use crate::state::{
    Batch, BatchStatus, Commitment, CommitmentStatus, Instrument, Portfolio,
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

/// Keep the Core -> Matcher CPI payload inside the SBF stack-frame limit.
/// Larger batches can be cleared in slices by the keeper.
const MAX_CPI_ORDERS: usize = 32;

/// Bytes per order in the CPI payload (M6 6g).
/// side(1) + price(8) + qty(8) + user(32) + order_type(1) + instrument_id(2) + reduce_only(1) = 53
const BYTES_PER_ORDER: usize = 53;
/// Header bytes (M7 7.6): close_slot(8) + num_orders(2) + num_caps(2) = 12
const HEADER_BYTES: usize = 12;
/// Bytes per user cap (M7 7.6, D2): user(32) + max_notional(16) = 48.
const BYTES_PER_CAP: usize = 48;
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
/// unfunded takers from filling). A single ClearBatch call is bounded to
/// `MAX_CPI_ORDERS` revealed commitments so its CPI payload remains below
/// the SBF stack-frame limit.
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

    let revealed_count = commitment_accounts
        .iter()
        .filter(|account| {
            let commitment = unsafe {
                &*(account.borrow_data_unchecked().as_ptr() as *const Commitment)
            };
            commitment.status == CommitmentStatus::Revealed
        })
        .count();
    if revealed_count == 0 {
        msg!("Error: No commitments to clear");
        return Err(PercolatorError::InvalidInstruction.into());
    }
    if revealed_count > MAX_CPI_ORDERS {
        msg!("Error: Too many commitments for one ClearBatch call");
        return Err(PercolatorError::InvalidInstruction.into());
    }

    if !book_account.is_writable() {
        msg!("Error: Book account must be writable");
        return Err(ProgramError::InvalidAccountData);
    }

    let mut cpi_instruction_data =
        [0u8; 1 + HEADER_BYTES + MAX_CPI_ORDERS * (BYTES_PER_CAP + BYTES_PER_ORDER)];
    cpi_instruction_data[0] = MATCHER_CLEAR_AND_MATCH;
    let cpi_data = &mut cpi_instruction_data[1..];
    cpi_data[0..8].copy_from_slice(&batch.close_slot.to_le_bytes());
    cpi_data[8..10].copy_from_slice(&(revealed_count as u16).to_le_bytes());

    let mut cap_count = 0usize;
    for commitment_account in commitment_accounts {
        let commitment = unsafe {
            &*(commitment_account.borrow_data_unchecked().as_ptr() as *const Commitment)
        };
        if commitment.status != CommitmentStatus::Revealed {
            continue;
        }

        let user = commitment.revealed.user;
        let already_written = (0..cap_count).any(|i| {
            let start = HEADER_BYTES + i * BYTES_PER_CAP;
            cpi_data[start..start + 32] == *user.as_ref()
        });
        if already_written {
            continue;
        }
        if cap_count >= MAX_CPI_ORDERS {
            msg!("Error: Too many unique users for one ClearBatch call");
            return Err(PercolatorError::InvalidInstruction.into());
        }

        let mut max_leverage: u16 = 1;
        for other_account in commitment_accounts {
            let other = unsafe {
                &*(other_account.borrow_data_unchecked().as_ptr() as *const Commitment)
            };
            if other.status != CommitmentStatus::Revealed || other.revealed.user != user {
                continue;
            }
            for instrument_account in instrument_accounts {
                let instrument = unsafe {
                    &*(instrument_account.borrow_data_unchecked().as_ptr() as *const Instrument)
                };
                if instrument.instrument_id == other.revealed.instrument_id
                    && instrument.max_leverage > max_leverage
                {
                    max_leverage = instrument.max_leverage;
                }
            }
        }

        let mut free_collateral: i128 = 0;
        let mut found_portfolio = false;
        for portfolio_account in portfolio_accounts {
            let portfolio = unsafe {
                &*(portfolio_account.borrow_data_unchecked().as_ptr() as *const Portfolio)
            };
            if portfolio.user == user {
                free_collateral = portfolio.free_collateral;
                found_portfolio = true;
                break;
            }
        }

        let cap = if found_portfolio {
            compute_user_cap(free_collateral, max_leverage)
        } else {
            0
        };
        let offset = HEADER_BYTES + cap_count * BYTES_PER_CAP;
        cpi_data[offset..offset + 32].copy_from_slice(user.as_ref());
        cpi_data[offset + 32..offset + 48].copy_from_slice(&cap.to_le_bytes());
        cap_count += 1;
    }
    cpi_data[10..12].copy_from_slice(&(cap_count as u16).to_le_bytes());

    let mut offset = HEADER_BYTES + cap_count * BYTES_PER_CAP;
    for commitment_account in commitment_accounts {
        let commitment = unsafe {
            &*(commitment_account.borrow_data_unchecked().as_ptr() as *const Commitment)
        };
        if commitment.status != CommitmentStatus::Revealed {
            continue;
        }

        let r = &commitment.revealed;
        cpi_data[offset] = r.side as u8;
        cpi_data[offset + 1..offset + 9].copy_from_slice(&r.price.to_le_bytes());
        cpi_data[offset + 9..offset + 17].copy_from_slice(&r.qty.to_le_bytes());
        cpi_data[offset + 17..offset + 49].copy_from_slice(r.user.as_ref());
        cpi_data[offset + 49] = r.order_type as u8;
        cpi_data[offset + 50..offset + 52].copy_from_slice(&r.instrument_id.to_le_bytes());
        cpi_data[offset + 52] = r.reduce_only as u8;
        offset += BYTES_PER_ORDER;
    }

    {
        let cpi_instruction_data = &cpi_instruction_data[..1 + offset];
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
            data: cpi_instruction_data,
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
        assert_eq!(MAX_CPI_ORDERS, 32);
        // Max local payload: discriminator + header + caps + orders.
        assert_eq!(
            1 + HEADER_BYTES + MAX_CPI_ORDERS * (BYTES_PER_CAP + BYTES_PER_ORDER),
            3245
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
