use crate::state::{Portfolio, Vault};
use percolator_common::PercolatorError;
use pinocchio::{
    account_info::AccountInfo,
    msg,
    ProgramResult,
};

pub fn process_withdraw(
    _portfolio_account: &AccountInfo,
    portfolio: &mut Portfolio,
    user_account: &AccountInfo,
    vault_account: &AccountInfo,
    vault: &mut Vault,
    amount: u64,
) -> ProgramResult {
    if amount == 0 {
        msg!("Error: Withdraw amount must be greater than zero");
        return Err(PercolatorError::InvalidQuantity.into());
    }

    if !user_account.is_signer() {
        msg!("Error: User must be a signer");
        return Err(PercolatorError::Unauthorized.into());
    }

    if portfolio.user != *user_account.key() {
        msg!("Error: Portfolio does not belong to user");
        return Err(PercolatorError::Unauthorized.into());
    }

    // Check free collateral
    if (amount as i128) > portfolio.free_collateral {
        msg!("Error: Insufficient free collateral");
        return Err(PercolatorError::InsufficientFunds.into());
    }

    // Check vault has enough
    if amount > vault.balance {
        msg!("Error: Vault insufficient balance");
        return Err(PercolatorError::InsufficientFunds.into());
    }

    // Transfer SOL from vault to user
    unsafe {
        *vault_account.borrow_mut_lamports_unchecked() -= amount;
        *user_account.borrow_mut_lamports_unchecked() += amount;
    }

    // Update state
    vault.balance = vault.balance.saturating_sub(amount);

    let amount_i128 = amount as i128;
    portfolio.principal = portfolio.principal
        .checked_sub(amount_i128)
        .ok_or(PercolatorError::Underflow)?;
    portfolio.equity = portfolio.equity
        .checked_sub(amount_i128)
        .ok_or(PercolatorError::Underflow)?;
    portfolio.recalc_margin();

    msg!("Withdraw successful");
    Ok(())
}
