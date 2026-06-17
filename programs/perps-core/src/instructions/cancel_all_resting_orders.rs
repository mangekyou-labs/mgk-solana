use crate::state::Portfolio;
use percolator_common::{PercolatorError, validate_owner, validate_writable};
use pinocchio::{
    account_info::AccountInfo,
    instruction::{AccountMeta, Instruction},
    msg,
    program::invoke,
    pubkey::Pubkey,
    ProgramResult,
};

/// Matcher `CancelAll` discriminator (M7 7.7).
pub const MATCHER_CANCEL_ALL: u8 = 4;

/// Maximum number of book accounts a single `CancelAllRestingOrders` call
/// may target. Matches `MAX_INSTRUMENTS` so a user can have resting orders
/// on every instrument in the registry without exceeding the bound.
pub const MAX_BOOKS_PER_CALL: usize = 32;

/// Cancel every resting order owned by `user` across one or more books.
///
/// Called by the keeper (or LiquidateUser's pre-step) in the M7 7.7
/// liquidation flow. The user must sign the transaction so they cannot be
/// force-cancelled by a third party. Un-revealed commitments are NOT
/// cancelled here — they expire via the existing `CloseCommitting` /
/// `SettleBatch` slash flow (M7 7.2).
///
/// Accounts:
/// 0. [writable] Portfolio PDA
/// 1. [signer, writable] User wallet
/// 2. [] Matcher program
///
/// Then a variable-length list of book accounts (one per instrument the user has open orders on):
///   - matcher-owned, `["book", instrument_id_le]`; pass N = num_books accounts; total = 3 + num_books.
///
/// Data: num_books(2)
pub fn process_cancel_all_resting_orders(
    program_id: &Pubkey,
    portfolio_account: &AccountInfo,
    user_account: &AccountInfo,
    matcher_program: &AccountInfo,
    book_accounts: &[AccountInfo],
) -> ProgramResult {
    if !user_account.is_signer() {
        msg!("Error: User must be signer");
        return Err(PercolatorError::Unauthorized.into());
    }

    validate_owner(portfolio_account, program_id)?;
    validate_writable(portfolio_account)?;
    for book in book_accounts {
        validate_writable(book)?;
    }

    let portfolio = unsafe {
        &*(portfolio_account.borrow_data_unchecked().as_ptr() as *const Portfolio)
    };
    if portfolio.user != *user_account.key() {
        msg!("Error: Portfolio does not belong to user");
        return Err(PercolatorError::Unauthorized.into());
    }

    if book_accounts.len() > MAX_BOOKS_PER_CALL {
        msg!("Error: Too many book accounts");
        return Err(PercolatorError::InvalidInstruction.into());
    }

    // Build the CPI data once — same user for every book.
    let mut cpi_data = [0u8; 1 + 32];
    cpi_data[0] = MATCHER_CANCEL_ALL;
    cpi_data[1..33].copy_from_slice(user_account.key().as_ref());

    for book in book_accounts {
        let cpi_instruction = Instruction {
            program_id: matcher_program.key(),
            accounts: &[AccountMeta {
                pubkey: book.key(),
                is_signer: false,
                is_writable: true,
            }],
            data: &cpi_data,
        };

        invoke(&cpi_instruction, &[book, matcher_program])?;
    }

    msg!("CancelAllRestingOrders: CPI to matcher complete");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_matcher_cancel_all_discriminator_is_four() {
        // Keep the matcher disc in sync with matcher entrypoint.rs.
        assert_eq!(MATCHER_CANCEL_ALL, 4);
    }

    #[test]
    fn test_cpi_data_layout_is_stable() {
        // 1 (disc) + 32 (user) = 33 bytes
        let mut buf = [0u8; 1 + 32];
        assert_eq!(buf.len(), 33);
        buf[0] = MATCHER_CANCEL_ALL;
        let user = Pubkey::from([7u8; 32]);
        buf[1..33].copy_from_slice(user.as_ref());
        assert_eq!(buf[0], 4);
        assert_eq!(buf[1], 7);
    }

    #[test]
    fn test_max_books_pin() {
        // Bumping MAX_BOOKS_PER_CALL must be a conscious decision —
        // it's load-bearing for the account-list parse.
        assert_eq!(MAX_BOOKS_PER_CALL, 32);
    }
}