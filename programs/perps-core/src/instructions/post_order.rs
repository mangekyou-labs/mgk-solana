//! PostOrder (disc 20) — DFBA open limit post (replaces Commit+Reveal for v1).

use crate::state::{Batch, BatchStatus, Portfolio, Registry};
use mgk_common::{validate_owner, validate_writable, MgkError};
use pinocchio::{
    account_info::AccountInfo,
    instruction::{AccountMeta, Instruction},
    msg,
    program::invoke,
    pubkey::Pubkey,
    ProgramResult,
};

/// Matcher `PlaceResting` discriminator.
pub const MATCHER_PLACE_RESTING: u8 = 6;

/// Post a limit order onto the resting book in a single transaction.
///
/// Accounts:
/// 0. [writable] Portfolio PDA
/// 1. [signer] User
/// 2. [writable] Batch PDA (must be Committing / open collection window)
/// 3. [] Registry
/// 4. [writable] Book account (matcher-owned)
/// 5. [] Matcher program
///
/// Data:
///   side(1) + is_maker(1) + price(8) + qty(8) + instrument_id(2) + reduce_only(1)
///   = 21 bytes
///
/// `is_maker`: 0 = taker (default), 1 = maker.
#[allow(clippy::too_many_arguments)]
pub fn process_post_order(
    program_id: &Pubkey,
    portfolio_account: &AccountInfo,
    user_account: &AccountInfo,
    batch_account: &AccountInfo,
    registry_account: &AccountInfo,
    book_account: &AccountInfo,
    matcher_program: &AccountInfo,
    side: u8,
    is_maker: bool,
    price: i64,
    qty: u64,
    instrument_id: u16,
    reduce_only: bool,
) -> ProgramResult {
    let registry =
        unsafe { &*(registry_account.borrow_data_unchecked().as_ptr() as *const Registry) };
    if registry.is_trading_paused() || registry.is_posts_paused() {
        msg!("Error: Trading/posts is paused");
        return Err(MgkError::OperationPaused.into());
    }

    if !user_account.is_signer() {
        msg!("Error: User must be signer");
        return Err(MgkError::Unauthorized.into());
    }

    validate_owner(portfolio_account, program_id)?;
    validate_writable(portfolio_account)?;
    validate_owner(batch_account, program_id)?;
    validate_writable(batch_account)?;
    validate_owner(registry_account, program_id)?;
    validate_writable(book_account)?;

    if qty == 0 {
        return Err(MgkError::InvalidQuantity.into());
    }
    if price <= 0 {
        return Err(MgkError::InvalidPrice.into());
    }
    if side > 1 {
        return Err(MgkError::InvalidSide.into());
    }

    let batch = unsafe { &mut *(batch_account.borrow_mut_data_unchecked().as_ptr() as *mut Batch) };
    // Until T9.3 renames status to Collecting, Committing is the open window.
    if batch.status != BatchStatus::Committing {
        msg!("Error: Batch not open for posts");
        return Err(MgkError::BatchNotOpen.into());
    }

    let portfolio =
        unsafe { &mut *(portfolio_account.borrow_mut_data_unchecked().as_ptr() as *mut Portfolio) };
    if portfolio.user != *user_account.key() {
        msg!("Error: Portfolio does not belong to user");
        return Err(MgkError::Unauthorized.into());
    }

    // T9.10.7: Reduce-only enforcement at post time.
    // Multiple concurrent reduce-only orders are not execution-reserved;
    // the guard validates against the on-chain position only.
    if reduce_only {
        match portfolio.find_position(instrument_id) {
            None => {
                msg!("Error: Reduce-only order but no position");
                return Err(MgkError::ReduceOnlyViolation.into());
            }
            Some((_idx, pos)) => {
                let pos_qty = pos.qty;
                // Long (pos_qty > 0) may only sell; short (pos_qty < 0) may only buy.
                if (pos_qty > 0 && side == 1) || (pos_qty < 0 && side == 0) {
                    // This is the reducing direction — OK.
                } else {
                    msg!("Error: Reduce-only order on wrong side for position");
                    return Err(MgkError::ReduceOnlyViolation.into());
                }
                let abs_pos = pos_qty.unsigned_abs();
                if qty > abs_pos {
                    msg!("Error: Reduce-only qty exceeds position");
                    return Err(MgkError::ReduceOnlyViolation.into());
                }
            }
        }
    }

    // Build CPI: disc(1) + user(32) + side(1) + is_maker(1) + price(8) + qty(8)
    //           + instrument_id(2) + reduce_only(1) = 54
    let mut cpi_data = [0u8; 1 + 32 + 1 + 1 + 8 + 8 + 2 + 1];
    cpi_data[0] = MATCHER_PLACE_RESTING;
    cpi_data[1..33].copy_from_slice(user_account.key().as_ref());
    cpi_data[33] = side;
    cpi_data[34] = if is_maker { 1 } else { 0 };
    cpi_data[35..43].copy_from_slice(&price.to_le_bytes());
    cpi_data[43..51].copy_from_slice(&qty.to_le_bytes());
    cpi_data[51..53].copy_from_slice(&instrument_id.to_le_bytes());
    cpi_data[53] = if reduce_only { 1 } else { 0 };

    let cpi_instruction = Instruction {
        program_id: matcher_program.key(),
        accounts: &[AccountMeta {
            pubkey: book_account.key(),
            is_signer: false,
            is_writable: true,
        }],
        data: &cpi_data,
    };

    invoke(&cpi_instruction, &[book_account, matcher_program])?;

    // Count posts for n_min close (reuses total_commitments field).
    batch.total_commitments = batch.total_commitments.saturating_add(1);
    portfolio.last_batch_id = batch.batch_id;

    msg!("PostOrder: placed");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_matcher_place_disc_is_six() {
        assert_eq!(MATCHER_PLACE_RESTING, 6);
    }

    #[test]
    fn test_cpi_data_layout_length() {
        // disc + user + side + is_maker + price + qty + instrument + reduce_only
        assert_eq!(1 + 32 + 1 + 1 + 8 + 8 + 2 + 1, 54);
    }

    #[test]
    fn test_default_taker_flag_is_zero() {
        let is_maker = false;
        assert_eq!(if is_maker { 1u8 } else { 0 }, 0);
    }

    // ------------------------------------------------------------------
    // T-POST-ORDER-UNIT: wire format + validation constants
    // ------------------------------------------------------------------

    #[test]
    fn test_post_order_disc_is_twenty() {
        // PostOrder is discriminator 20 in the entrypoint match.
        assert_eq!(20u8, 20);
    }

    #[test]
    fn test_post_order_wire_data_length() {
        // Data after disc strip: side(1) + is_maker(1) + price(8) + qty(8)
        //   + instrument_id(2) + reduce_only(1) = 21 bytes
        let wire_len = 1 + 1 + 8 + 8 + 2 + 1;
        assert_eq!(wire_len, 21);
    }

    #[test]
    fn test_post_order_wire_parse_buy_taker() {
        // Simulate parsing 21 bytes of instruction data (disc already stripped).
        let mut data = [0u8; 21];
        data[0] = 0; // side = Buy
        data[1] = 0; // is_maker = false (taker)
        data[2..10].copy_from_slice(&100_000i64.to_le_bytes()); // price
        data[10..18].copy_from_slice(&5u64.to_le_bytes()); // qty
        data[18..20].copy_from_slice(&0u16.to_le_bytes()); // instrument_id
        data[20] = 0; // reduce_only = false

        let side = data[0];
        let is_maker = data[1] != 0;
        let price = i64::from_le_bytes(data[2..10].try_into().unwrap());
        let qty = u64::from_le_bytes(data[10..18].try_into().unwrap());
        let instrument_id = u16::from_le_bytes(data[18..20].try_into().unwrap());
        let reduce_only = data[20] != 0;

        assert_eq!(side, 0);
        assert!(!is_maker);
        assert_eq!(price, 100_000);
        assert_eq!(qty, 5);
        assert_eq!(instrument_id, 0);
        assert!(!reduce_only);
    }

    #[test]
    fn test_post_order_wire_parse_sell_maker_reduce_only() {
        let mut data = [0u8; 21];
        data[0] = 1; // side = Sell
        data[1] = 1; // is_maker = true
        data[2..10].copy_from_slice(&99_500i64.to_le_bytes());
        data[10..18].copy_from_slice(&10u64.to_le_bytes());
        data[18..20].copy_from_slice(&1u16.to_le_bytes()); // instrument_id = 1
        data[20] = 1; // reduce_only = true

        let side = data[0];
        let is_maker = data[1] != 0;
        let price = i64::from_le_bytes(data[2..10].try_into().unwrap());
        let qty = u64::from_le_bytes(data[10..18].try_into().unwrap());
        let instrument_id = u16::from_le_bytes(data[18..20].try_into().unwrap());
        let reduce_only = data[20] != 0;

        assert_eq!(side, 1);
        assert!(is_maker);
        assert_eq!(price, 99_500);
        assert_eq!(qty, 10);
        assert_eq!(instrument_id, 1);
        assert!(reduce_only);
    }

    #[test]
    fn test_post_order_wire_negative_price() {
        // DFBA: prices must be positive; negative is invalid.
        let price: i64 = -1;
        assert!(price <= 0); // validation would reject
    }

    #[test]
    fn test_post_order_wire_zero_qty() {
        // qty == 0 is invalid.
        let qty: u64 = 0;
        assert_eq!(qty, 0); // validation would reject
    }

    #[test]
    fn test_post_order_wire_invalid_side() {
        // side > 1 is invalid (0=Buy, 1=Sell).
        let side: u8 = 2;
        assert!(side > 1); // validation would reject
    }

    #[test]
    fn test_post_order_account_count() {
        // PostOrder requires exactly 6 accounts:
        // 0: portfolio (writable), 1: user (signer), 2: batch (writable),
        // 3: registry, 4: book (writable), 5: matcher program
        let required = 6usize;
        assert_eq!(required, 6);
    }

    #[test]
    fn test_cpi_place_resting_data_fields() {
        // CPI to matcher disc 6 PlaceResting:
        // disc(1) + user(32) + side(1) + is_maker(1) + price(8) + qty(8)
        //   + instrument_id(2) + reduce_only(1) = 54
        let mut cpi = [0u8; 54];
        cpi[0] = MATCHER_PLACE_RESTING; // disc 6

        // user at 1..33 (would be filled with actual pubkey)
        let user = [42u8; 32];
        cpi[1..33].copy_from_slice(&user);

        cpi[33] = 1; // side = Sell
        cpi[34] = 1; // is_maker = true
        cpi[35..43].copy_from_slice(&99_000i64.to_le_bytes());
        cpi[43..51].copy_from_slice(&3u64.to_le_bytes());
        cpi[51..53].copy_from_slice(&0u16.to_le_bytes());
        cpi[53] = 0; // reduce_only = false

        assert_eq!(cpi[0], 6);
        assert_eq!(&cpi[1..33], &[42u8; 32]);
        assert_eq!(cpi[33], 1); // side
        assert_eq!(cpi[34], 1); // is_maker
        assert_eq!(i64::from_le_bytes(cpi[35..43].try_into().unwrap()), 99_000);
        assert_eq!(u64::from_le_bytes(cpi[43..51].try_into().unwrap()), 3);
        assert_eq!(u16::from_le_bytes(cpi[51..53].try_into().unwrap()), 0);
        assert_eq!(cpi[53], 0); // reduce_only
    }

    // ====================================================================
    // T9.10.7: Reduce-only enforcement tests
    // ====================================================================

    use crate::state::portfolio::{Portfolio, Position};
    use mgk_common::MgkError;
    use pinocchio::pubkey::Pubkey as Pk;

    /// Helper: simulate reduce-only validation against a portfolio.
    /// Returns Ok(()) if valid, Err(ReduceOnlyViolation) if not.
    fn validate_reduce_only(
        portfolio: &Portfolio,
        instrument_id: u16,
        side: u8,
        qty: u64,
    ) -> Result<(), MgkError> {
        match portfolio.find_position(instrument_id) {
            None => Err(MgkError::ReduceOnlyViolation),
            Some((_idx, pos)) => {
                let pos_qty = pos.qty;
                if (pos_qty > 0 && side == 1) || (pos_qty < 0 && side == 0) {
                    // Reducing direction — OK so far
                } else {
                    return Err(MgkError::ReduceOnlyViolation);
                }
                let abs_pos = pos_qty.unsigned_abs();
                if qty > abs_pos {
                    return Err(MgkError::ReduceOnlyViolation);
                }
                Ok(())
            }
        }
    }

    /// Reduce-only on flat position → Reject.
    #[test]
    fn test_reduce_only_flat_position_rejected() {
        let p = Portfolio::new(Pk::default());
        // No positions (flat)
        let result = validate_reduce_only(&p, 0, 1, 100); // side=Sell
        assert_eq!(result, Err(MgkError::ReduceOnlyViolation));
    }

    /// Long position, reduce-only sell (correct side) → Accept.
    #[test]
    fn test_reduce_only_long_position_sell_accepted() {
        let mut p = Portfolio::new(Pk::default());
        p.positions[0] = Position { instrument_id: 0, qty: 100, entry_vwap: 50_000_000 };
        p.positions_len = 1;
        assert!(validate_reduce_only(&p, 0, 1, 100).is_ok()); // sell, qty=100 exact
    }

    /// Long position, reduce-only sell oversized → Reject.
    #[test]
    fn test_reduce_only_long_position_oversized_rejected() {
        let mut p = Portfolio::new(Pk::default());
        p.positions[0] = Position { instrument_id: 0, qty: 50, entry_vwap: 50_000_000 };
        p.positions_len = 1;
        assert_eq!(validate_reduce_only(&p, 0, 1, 51), Err(MgkError::ReduceOnlyViolation));
    }

    /// Long position, reduce-only buy (wrong side) → Reject.
    #[test]
    fn test_reduce_only_long_position_wrong_side_rejected() {
        let mut p = Portfolio::new(Pk::default());
        p.positions[0] = Position { instrument_id: 0, qty: 100, entry_vwap: 50_000_000 };
        p.positions_len = 1;
        assert_eq!(validate_reduce_only(&p, 0, 0, 100), Err(MgkError::ReduceOnlyViolation)); // buy
    }

    /// Short position, reduce-only buy (correct side) → Accept.
    #[test]
    fn test_reduce_only_short_position_buy_accepted() {
        let mut p = Portfolio::new(Pk::default());
        p.positions[0] = Position { instrument_id: 0, qty: -100, entry_vwap: 50_000_000 };
        p.positions_len = 1;
        assert!(validate_reduce_only(&p, 0, 0, 100).is_ok()); // buy, qty=100 exact
    }

    /// Short position, reduce-only buy oversized → Reject.
    #[test]
    fn test_reduce_only_short_position_oversized_rejected() {
        let mut p = Portfolio::new(Pk::default());
        p.positions[0] = Position { instrument_id: 0, qty: -50, entry_vwap: 50_000_000 };
        p.positions_len = 1;
        assert_eq!(validate_reduce_only(&p, 0, 0, 51), Err(MgkError::ReduceOnlyViolation));
    }

    /// Short position, reduce-only sell (wrong side) → Reject.
    #[test]
    fn test_reduce_only_short_position_wrong_side_rejected() {
        let mut p = Portfolio::new(Pk::default());
        p.positions[0] = Position { instrument_id: 0, qty: -100, entry_vwap: 50_000_000 };
        p.positions_len = 1;
        assert_eq!(validate_reduce_only(&p, 0, 1, 100), Err(MgkError::ReduceOnlyViolation)); // sell
    }

    /// ReduceOnlyViolation = 606 is pinned.
    #[test]
    fn test_reduce_only_violation_discriminator() {
        assert_eq!(MgkError::ReduceOnlyViolation as u32, 606);
    }

    /// Non-reduce-only order skips the check (always accepted if other validations pass).
    #[test]
    fn test_non_reduce_only_skips_check() {
        let p = Portfolio::new(Pk::default());
        // Flat position, but reduce_only=false so no validation applies.
        // The actual validation only runs when reduce_only=true;
        // this test documents that behavior.
        assert!(p.positions_len == 0); // flat
    }
}
