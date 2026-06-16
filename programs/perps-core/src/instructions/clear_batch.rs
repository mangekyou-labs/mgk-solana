use crate::state::{
    Commitment, CommitmentStatus, Instrument, Portfolio, MAX_COMMITMENTS, Batch, BatchStatus,
};
use percolator_common::PercolatorError;
use pinocchio::{
    account_info::AccountInfo,
    instruction::{AccountMeta, Instruction},
    msg,
    program::invoke,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

/// Bytes per order in the CPI payload (M6 6g).
/// side(1) + price(8) + qty(8) + user(32) + order_type(1) + instrument_id(2) + reduce_only(1) = 53
const BYTES_PER_ORDER: usize = 53;
/// Header bytes (M7 7.6): close_slot(8) + num_orders(2) + num_caps(2) = 12
const HEADER_BYTES: usize = 12;
/// Bytes per user cap (M7 7.6, D2): user(32) + max_notional(16) = 48.
const BYTES_PER_CAP: usize = 48;
/// Maximum caps per batch. Matches the matcher's `MAX_ORDERS` (64) — for
/// 64 orders, there can be at most 64 unique users. If a batch has more
/// than 64 unique users, `process_clear_batch` returns an error.
const MAX_CAPS: usize = 64;
/// Maximum CPI payload size (M7 7.6): header + max_caps*cap_bytes + max_commitments*order_bytes.
const CPI_DATA_SIZE: usize =
    HEADER_BYTES + MAX_CAPS * BYTES_PER_CAP + MAX_COMMITMENTS * BYTES_PER_ORDER;

/// Matcher `ClearAndMatch` discriminator (M6 6i.2).
pub const MATCHER_CLEAR_AND_MATCH: u8 = 3;

/// Compute a single user's notional cap from their free collateral and
/// the max leverage they're exposed to in this batch (M7 7.6, decision D2).
///
/// Pure function — easy to test in isolation. Returns 0 if
/// `free_collateral < 0` (defensive: prevents underwater users from
/// opening new positions). Otherwise returns
/// `free_collateral * max_leverage` (both unsigned for the multiplication).
pub(crate) fn compute_user_cap(free_collateral: i128, max_leverage: u16) -> u128 {
    if free_collateral < 0 {
        0
    } else {
        (free_collateral as u128) * (max_leverage as u128)
    }
}

/// Clear a batch by invoking the matcher program (M6 6i.2).
///
/// M7 7.6 (decision D2): pre-computes a per-user notional cap from
/// `portfolio.free_collateral * instrument.max_leverage` (max across the
/// user's instruments in this batch) and passes it to the matcher via the
/// CPI data. The matcher's `capped_risk_check` cancels the remainder of
/// any order whose cumulative notional exceeds the cap for its user.
///
/// Cap formula: `cap = free_collateral * max_leverage` (u128). If the user
/// has no portfolio in this batch, or `free_collateral < 0`, `cap = 0` —
/// the matcher cancels all fills for that user (defensive: prevents
/// unfunded takers from filling). Caps are stored in a stack-allocated
/// array of at most `MAX_CAPS = 64` entries (matching matcher's
/// `MAX_ORDERS`); a batch with more than 64 unique users returns an
/// error.
#[allow(clippy::too_many_arguments)]
pub fn process_clear_batch(
    _program_id: &Pubkey,
    batch_account: &AccountInfo,
    book_account: &AccountInfo,
    results_account: &AccountInfo,
    matcher_program: &AccountInfo,
    _registry_account: &AccountInfo,
    instrument_accounts: &[AccountInfo],
    commitment_accounts: &[AccountInfo],
    portfolio_accounts: &[AccountInfo],
) -> ProgramResult {
    let batch = unsafe { &*(batch_account.borrow_data_unchecked().as_ptr() as *const Batch) };

    if batch.status != BatchStatus::Revealing {
        msg!("Error: Batch not in revealing phase");
        return Err(PercolatorError::InvalidInstruction.into());
    }

    let total_commitments = batch.total_commitments as usize;
    if total_commitments == 0 {
        msg!("Error: No commitments to clear");
        return Err(PercolatorError::InvalidInstruction.into());
    }

    if !book_account.is_writable() {
        msg!("Error: Book account must be writable");
        return Err(ProgramError::InvalidAccountData);
    }

    // ===========================================================
    // M7 7.6 (D2): build per-user cap table.
    // ===========================================================

    // Step 1: collect unique users from revealed commitments.
    let mut unique_users: [Pubkey; MAX_CAPS] = [Pubkey::default(); MAX_CAPS];
    let mut unique_user_count: usize = 0;
    for commitment_account in commitment_accounts.iter().take(total_commitments) {
        let commitment = unsafe {
            &*(commitment_account.borrow_data_unchecked().as_ptr() as *const Commitment)
        };
        if commitment.status != CommitmentStatus::Revealed {
            continue;
        }
        let user = commitment.revealed.user;
        let found = unique_users[..unique_user_count].contains(&user);
        if !found {
            if unique_user_count >= MAX_CAPS {
                msg!("Error: Too many unique users in batch (max 64)");
                return Err(PercolatorError::InvalidInstruction.into());
            }
            unique_users[unique_user_count] = user;
            unique_user_count += 1;
        }
    }

    // Step 2: for each unique user, compute max_leverage across their
    // instruments. We use the largest max_leverage the user is exposed to
    // in this batch — this preserves the most permissive cap and avoids
    // suppressing fills on lower-leverage instruments.
    let mut user_max_leverage: [u16; MAX_CAPS] = [1u16; MAX_CAPS];
    for (i, user) in unique_users[..unique_user_count].iter().enumerate() {
        let mut max_lev: u16 = 1; // baseline = no leverage
        for commitment_account in commitment_accounts.iter().take(total_commitments) {
            let commitment = unsafe {
                &*(commitment_account.borrow_data_unchecked().as_ptr() as *const Commitment)
            };
            if commitment.status != CommitmentStatus::Revealed {
                continue;
            }
            if commitment.revealed.user != *user {
                continue;
            }
            let inst_id = commitment.revealed.instrument_id;
            for instrument_account in instrument_accounts {
                let instrument = unsafe {
                    &*(instrument_account.borrow_data_unchecked().as_ptr() as *const Instrument)
                };
                if instrument.instrument_id == inst_id && instrument.max_leverage > max_lev {
                    max_lev = instrument.max_leverage;
                }
            }
        }
        user_max_leverage[i] = max_lev;
    }

    // Step 3: for each unique user, look up their portfolio and compute cap.
    // cap = free_collateral * max_leverage. If portfolio missing or
    // free_collateral < 0, cap = 0 (cancels all fills for that user).
    let mut caps: [(Pubkey, u128); MAX_CAPS] = [(Pubkey::default(), 0u128); MAX_CAPS];
    for (i, user) in unique_users[..unique_user_count].iter().enumerate() {
        let mut free_collateral: i128 = 0;
        let mut found_portfolio = false;
        for portfolio_account in portfolio_accounts {
            let portfolio = unsafe {
                &*(portfolio_account.borrow_data_unchecked().as_ptr() as *const Portfolio)
            };
            if portfolio.user == *user {
                free_collateral = portfolio.free_collateral;
                found_portfolio = true;
                break;
            }
        }

        let cap: u128 = if !found_portfolio {
            0
        } else {
            compute_user_cap(free_collateral, user_max_leverage[i])
        };
        caps[i] = (*user, cap);
    }

    // ===========================================================
    // Build CPI payload for matcher's ClearAndMatch.
    // Header: close_slot(8) + num_orders(2) + num_caps(2) = 12
    // Caps: num_caps * 48 bytes
    // Orders: num_orders * 53 bytes
    // ===========================================================
    let mut cpi_data = [0u8; CPI_DATA_SIZE];
    cpi_data[0..8].copy_from_slice(&batch.close_slot.to_le_bytes());
    cpi_data[8..10].copy_from_slice(&(total_commitments as u16).to_le_bytes());
    cpi_data[10..12].copy_from_slice(&(unique_user_count as u16).to_le_bytes());

    // Write caps section.
    let mut offset = HEADER_BYTES;
    for (user, cap) in caps[..unique_user_count].iter() {
        cpi_data[offset..offset + 32].copy_from_slice(user.as_ref());
        cpi_data[offset + 32..offset + 48].copy_from_slice(&cap.to_le_bytes());
        offset += BYTES_PER_CAP;
    }

    // Write orders section.
    for commitment_account in commitment_accounts.iter().take(total_commitments) {
        let commitment = unsafe {
            &*(commitment_account.borrow_data_unchecked().as_ptr() as *const Commitment)
        };

        if commitment.status != CommitmentStatus::Revealed {
            msg!("Warning: Commitment not revealed, skipping");
            continue;
        }

        let r = &commitment.revealed;
        let side = r.side as u8;
        let price = r.price;
        let qty = r.qty;
        let order_type = r.order_type as u8;
        let instrument_id = r.instrument_id;
        let reduce_only = r.reduce_only as u8;

        cpi_data[offset] = side;
        cpi_data[offset + 1..offset + 9].copy_from_slice(&price.to_le_bytes());
        cpi_data[offset + 9..offset + 17].copy_from_slice(&qty.to_le_bytes());
        cpi_data[offset + 17..offset + 49].copy_from_slice(r.user.as_ref());
        cpi_data[offset + 49] = order_type;
        cpi_data[offset + 50..offset + 52].copy_from_slice(&instrument_id.to_le_bytes());
        cpi_data[offset + 52] = reduce_only;
        offset += BYTES_PER_ORDER;
    }

    // CPI to matcher's ClearAndMatch (discriminator 3 prepended).
    let mut cpi_instruction_data = [0u8; CPI_DATA_SIZE + 1];
    cpi_instruction_data[0] = MATCHER_CLEAR_AND_MATCH;
    cpi_instruction_data[1..1 + offset].copy_from_slice(&cpi_data[..offset]);

    let cpi_instruction = Instruction {
        program_id: matcher_program.key(),
        accounts: &[
            AccountMeta {
                pubkey: book_account.key(),
                is_signer: false,
                is_writable: true,
            },
            AccountMeta {
                pubkey: results_account.key(),
                is_signer: false,
                is_writable: true,
            },
        ],
        data: &cpi_instruction_data[..1 + offset],
    };

    invoke(
        &cpi_instruction,
        &[book_account, results_account, matcher_program],
    )?;

    // Transition to Clearing
    let batch_mut = unsafe {
        &mut *(batch_account.borrow_mut_data_unchecked().as_ptr() as *mut Batch)
    };
    batch_mut.status = BatchStatus::Clearing;

    msg!("ClearBatch: CLOB match via matcher complete");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cpi_data_layout_is_stable() {
        // Header: close_slot(8) + num_orders(2) + num_caps(2) = 12
        assert_eq!(HEADER_BYTES, 12);
        // Per cap: user(32) + max_notional(16) = 48
        assert_eq!(BYTES_PER_CAP, 48);
        // Per order: 53 bytes (M6 6g).
        assert_eq!(BYTES_PER_ORDER, 53);
        // Max caps = 64 (matches matcher's MAX_ORDERS).
        assert_eq!(MAX_CAPS, 64);
        // Max payload: 12 + 64*48 + 500*53.
        assert_eq!(
            CPI_DATA_SIZE,
            12 + MAX_CAPS * 48 + MAX_COMMITMENTS * 53
        );
    }

    #[test]
    fn test_matcher_clear_and_match_discriminator_is_three() {
        // Pin to matcher's entrypoint.rs.
        assert_eq!(MATCHER_CLEAR_AND_MATCH, 3);
    }

    #[test]
    fn test_cpi_header_writes_close_slot_num_orders_num_caps() {
        let mut buf = [0u8; HEADER_BYTES + 53];
        let close_slot: u64 = 0xDEAD_BEEF_CAFE_BABE;
        let num_orders: u16 = 1;
        let num_caps: u16 = 0;
        buf[0..8].copy_from_slice(&close_slot.to_le_bytes());
        buf[8..10].copy_from_slice(&num_orders.to_le_bytes());
        buf[10..12].copy_from_slice(&num_caps.to_le_bytes());
        assert_eq!(
            u64::from_le_bytes(buf[0..8].try_into().unwrap()),
            close_slot
        );
        assert_eq!(u16::from_le_bytes(buf[8..10].try_into().unwrap()), 1);
        assert_eq!(u16::from_le_bytes(buf[10..12].try_into().unwrap()), 0);
    }

    // ========================================================================
    // M7 7.6 (D2) cap computation tests
    // ========================================================================

    #[test]
    fn test_compute_user_cap_normal() {
        // cap = free_collateral * max_leverage.
        // free_collateral = 1_000, max_leverage = 10 → cap = 10_000.
        assert_eq!(compute_user_cap(1_000, 10), 10_000);
    }

    #[test]
    fn test_compute_user_cap_zero_free_collateral() {
        // No free collateral → no cap (cancels any fill attempt).
        assert_eq!(compute_user_cap(0, 10), 0);
    }

    #[test]
    fn test_compute_user_cap_underwater_returns_zero() {
        // Underwater user: free_collateral < 0 → cap = 0 (defensive).
        // Matches `LiquidateUser`'s `health >= 0 → reject` behavior.
        assert_eq!(compute_user_cap(-1, 10), 0);
        assert_eq!(compute_user_cap(-1_000_000, 100), 0);
    }

    #[test]
    fn test_compute_user_cap_zero_leverage() {
        // max_leverage = 0 means "no leverage allowed" — cap is 0.
        // This shouldn't happen in practice (default is 10) but the
        // function should handle it gracefully.
        assert_eq!(compute_user_cap(1_000_000, 0), 0);
    }

    #[test]
    fn test_compute_user_cap_high_leverage() {
        // Realistic 50x leverage on a large free_collateral.
        assert_eq!(compute_user_cap(10_000_000, 50), 500_000_000);
    }

    #[test]
    fn test_compute_user_cap_no_overflow_realistic_inputs() {
        // Realistic upper bounds: free_collateral up to 1e15 (e.g., 1M
        // SOL at 1e9 lamports each = 1e15) and max_leverage up to 100.
        // Product = 1e17, well within u128::MAX (~3.4e38).
        let fc: i128 = 1_000_000_000_000_000; // 1e15
        let cap = compute_user_cap(fc, 100);
        assert_eq!(cap, 100_000_000_000_000_000); // 1e17
    }
}
