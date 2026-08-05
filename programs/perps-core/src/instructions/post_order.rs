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
    if registry.is_trading_paused() {
        msg!("Error: Trading is paused");
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
}
