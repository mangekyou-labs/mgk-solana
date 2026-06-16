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

/// Matcher `ModifyResting` discriminator.
pub const MATCHER_MODIFY_RESTING: u8 = 2;

/// Modify a single resting order's qty by `order_id`.
///
/// Accounts:
/// 0. [writable] Portfolio PDA
/// 1. [signer, writable] User wallet
/// 2. [writable] Book account (PDA: `["book", instrument_id_le]`, matcher-owned)
/// 3. [] Matcher program
///
/// Data: order_id(8) + new_qty(8)
pub fn process_modify_resting_order(
    program_id: &Pubkey,
    portfolio_account: &AccountInfo,
    user_account: &AccountInfo,
    book_account: &AccountInfo,
    matcher_program: &AccountInfo,
    order_id: u64,
    new_qty: u64,
) -> ProgramResult {
    if new_qty == 0 {
        msg!("Error: new_qty must be > 0");
        return Err(PercolatorError::InvalidAmount.into());
    }

    if !user_account.is_signer() {
        msg!("Error: User must be signer");
        return Err(PercolatorError::Unauthorized.into());
    }

    validate_owner(portfolio_account, program_id)?;
    validate_writable(portfolio_account)?;
    validate_writable(book_account)?;

    let portfolio = unsafe { &*(portfolio_account.borrow_data_unchecked().as_ptr() as *const Portfolio) };
    if portfolio.user != *user_account.key() {
        msg!("Error: Portfolio does not belong to user");
        return Err(PercolatorError::Unauthorized.into());
    }

    // Build CPI to matcher's ModifyResting (disc 2).
    // Wire: discriminator(1) + user(32) + order_id(8) + new_qty(8) = 49 bytes
    let mut cpi_data = [0u8; 1 + 32 + 8 + 8];
    cpi_data[0] = MATCHER_MODIFY_RESTING;
    cpi_data[1..33].copy_from_slice(user_account.key().as_ref());
    cpi_data[33..41].copy_from_slice(&order_id.to_le_bytes());
    cpi_data[41..49].copy_from_slice(&new_qty.to_le_bytes());

    let cpi_instruction = Instruction {
        program_id: matcher_program.key(),
        accounts: &[AccountMeta {
            pubkey: book_account.key(),
            is_signer: false,
            is_writable: true,
        }],
        data: &cpi_data,
    };

    invoke(
        &cpi_instruction,
        &[book_account, matcher_program],
    )?;

    msg!("ModifyRestingOrder: CPI to matcher complete");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use pinocchio::pubkey::Pubkey;

    #[test]
    fn test_matcher_modify_discriminator_is_two() {
        assert_eq!(MATCHER_MODIFY_RESTING, 2);
    }

    #[test]
    fn test_cpi_data_layout_is_stable() {
        // 1 (disc) + 32 (user) + 8 (order_id) + 8 (new_qty) = 49
        let mut buf = [0u8; 1 + 32 + 8 + 8];
        assert_eq!(buf.len(), 49);
        buf[0] = MATCHER_MODIFY_RESTING;
        let user = Pubkey::from([9u8; 32]);
        buf[1..33].copy_from_slice(user.as_ref());
        buf[33..41].copy_from_slice(&42u64.to_le_bytes());
        buf[41..49].copy_from_slice(&7u64.to_le_bytes());
        assert_eq!(buf[0], 2);
        assert_eq!(u64::from_le_bytes(buf[33..41].try_into().unwrap()), 42);
        assert_eq!(u64::from_le_bytes(buf[41..49].try_into().unwrap()), 7);
    }
}
