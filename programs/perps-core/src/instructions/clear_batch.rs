use crate::state::{Batch, BatchStatus};
use mgk_common::MgkError;
use pinocchio::{
    account_info::AccountInfo,
    instruction::{AccountMeta, Instruction},
    msg,
    program::invoke,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

/// Matcher `DfbaClear` discriminator.
pub const MATCHER_DFBA_CLEAR: u8 = 5;
/// Legacy CLOB disc (kept for tests).
pub const MATCHER_CLEAR_AND_MATCH: u8 = 3;
/// DFBA results header: bid(8)+ask(8)+mbid(8)+mask(8)+nfill(2)=34
const DFBA_RESULTS_HEADER: usize = 34;

/// Cap helper retained for unit tests / future per-user DFBA caps.
#[cfg(test)]
const MAX_CPI_ORDERS: usize = 32;
#[cfg(test)]
const BYTES_PER_ORDER: usize = 53;
#[cfg(test)]
const HEADER_BYTES: usize = 12;
#[cfg(test)]
const BYTES_PER_CAP: usize = 48;

/// Compute a single user's notional cap from their free collateral and
/// the max leverage they're exposed to in this batch (M7 7.6, decision D2).
///
/// Pure function — easy to test in isolation. Returns 0 if
/// `free_collateral < 0` (defensive: prevents underwater users from
/// opening new positions). Otherwise returns
/// `free_collateral * max_leverage` (both unsigned for the multiplication).
#[cfg(test)]
pub(crate) fn compute_user_cap(free_collateral: i128, max_leverage: u16) -> u128 {
    if free_collateral < 0 {
        0
    } else {
        (free_collateral as u128) * (max_leverage as u128)
    }
}

/// Clear a batch via matcher DFBA dual auction (disc 5).
///
/// Collects resting orders from the book (num_orders=0 in CPI), runs dual
/// clear, applies fills on book, writes dual prices + mark validity on Batch.
///
/// Legacy commitment-based CLOB clear is retired for DFBA.
#[allow(clippy::too_many_arguments)]
pub fn process_clear_batch(
    _program_id: &Pubkey,
    batch_account: &AccountInfo,
    book_account: &AccountInfo,
    results_account: &AccountInfo,
    matcher_program: &AccountInfo,
    _registry_account: &AccountInfo,
    _instrument_accounts: &[AccountInfo],
    _commitment_accounts: &[AccountInfo],
    _portfolio_accounts: &[AccountInfo],
) -> ProgramResult {
    let batch = unsafe { &*(batch_account.borrow_data_unchecked().as_ptr() as *const Batch) };

    // DFBA: close_collecting lands in Clearing; also accept legacy Revealing.
    if batch.status != BatchStatus::Clearing && batch.status != BatchStatus::Revealing {
        msg!("Error: Batch not ready to clear");
        return Err(MgkError::InvalidInstruction.into());
    }

    if !book_account.is_writable() {
        msg!("Error: Book account must be writable");
        return Err(ProgramError::InvalidAccountData);
    }
    if !results_account.is_writable() {
        msg!("Error: Results account must be writable");
        return Err(ProgramError::InvalidAccountData);
    }

    // CPI: disc 5 DfbaClear — marginal_size_cap(8) + num_orders(2)=0 → collect from book
    let mut cpi_data = [0u8; 1 + 10];
    cpi_data[0] = MATCHER_DFBA_CLEAR;
    cpi_data[1..9].copy_from_slice(&u64::MAX.to_le_bytes()); // no marginal size cap
    cpi_data[9..11].copy_from_slice(&0u16.to_le_bytes()); // collect from book

    let cpi_instruction = Instruction {
        program_id: matcher_program.key(),
        accounts: &[
            AccountMeta {
                pubkey: results_account.key(),
                is_signer: false,
                is_writable: true,
            },
            AccountMeta {
                pubkey: book_account.key(),
                is_signer: false,
                is_writable: true,
            },
        ],
        data: &cpi_data,
    };

    invoke(
        &cpi_instruction,
        &[results_account, book_account, matcher_program],
    )?;

    // Read DFBA results header into batch.
    let results_data = results_account
        .try_borrow_data()
        .map_err(|_| MgkError::InvalidAccount)?;
    if results_data.len() < DFBA_RESULTS_HEADER {
        return Err(ProgramError::AccountDataTooSmall);
    }

    let bid = i64::from_le_bytes(results_data[0..8].try_into().unwrap());
    let ask = i64::from_le_bytes(results_data[8..16].try_into().unwrap());
    let matched_bid = u64::from_le_bytes(results_data[16..24].try_into().unwrap());
    let matched_ask = u64::from_le_bytes(results_data[24..32].try_into().unwrap());

    let batch_mut = unsafe {
        &mut *(batch_account.borrow_mut_data_unchecked().as_ptr() as *mut Batch)
    };
    batch_mut.bid_clearing_price = bid;
    batch_mut.ask_clearing_price = ask;
    batch_mut.matched_bid_qty = matched_bid;
    batch_mut.matched_ask_qty = matched_ask;
    batch_mut.total_volume = matched_bid.saturating_add(matched_ask);

    let dual_ok = matched_bid > 0 && matched_ask > 0;
    if dual_ok {
        batch_mut.mark_valid = 1;
        batch_mut.liq_paused = 0;
        batch_mut.clearing_price = bid / 2 + ask / 2 + (bid % 2 + ask % 2) / 2;
    } else {
        batch_mut.mark_valid = 0;
        batch_mut.liq_paused = 1;
        batch_mut.clearing_price = 0;
    }

    batch_mut.status = BatchStatus::Clearing;

    msg!("ClearBatch: DFBA dual clear complete");
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
        assert_eq!(MAX_CPI_ORDERS, 32);
        // Max local payload: discriminator + header + caps + orders.
        assert_eq!(
            1 + HEADER_BYTES + MAX_CPI_ORDERS * (BYTES_PER_CAP + BYTES_PER_ORDER),
            3245
        );
    }

    #[test]
    fn test_matcher_clear_and_match_discriminator_is_three() {
        // Legacy CLOB disc — kept for reference.
        assert_eq!(MATCHER_CLEAR_AND_MATCH, 3);
    }

    #[test]
    fn test_matcher_dfba_clear_discriminator_is_five() {
        assert_eq!(MATCHER_DFBA_CLEAR, 5);
    }

    #[test]
    fn test_dfba_results_header_layout() {
        // bid(8) + ask(8) + matched_bid(8) + matched_ask(8) + num_fills(2) = 34
        assert_eq!(DFBA_RESULTS_HEADER, 34);
        let mut buf = [0u8; 34];
        buf[0..8].copy_from_slice(&100i64.to_le_bytes());
        buf[8..16].copy_from_slice(&110i64.to_le_bytes());
        buf[16..24].copy_from_slice(&10u64.to_le_bytes());
        buf[24..32].copy_from_slice(&10u64.to_le_bytes());
        buf[32..34].copy_from_slice(&2u16.to_le_bytes());
        let bid = i64::from_le_bytes(buf[0..8].try_into().unwrap());
        let ask = i64::from_le_bytes(buf[8..16].try_into().unwrap());
        let dual_ok = 10u64 > 0 && 10u64 > 0;
        let mid = bid / 2 + ask / 2;
        assert!(dual_ok);
        assert_eq!(mid, 105);
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
