use crate::state::{Portfolio, Registry, Vault};
use mgk_common::MgkError;
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
    registry_account: &AccountInfo,
    amount: u64,
) -> ProgramResult {
    // M7 7.8: governance emergency brake. Withdrawals can be paused
    // (e.g. oracle outage, suspected bug). Deposits stay open so users
    // can still fund defensive positions during a paused-but-recovering
    // state.
    let registry = unsafe { &*(registry_account.borrow_data_unchecked().as_ptr() as *const Registry) };
    if registry.is_withdrawals_paused() {
        msg!("Error: Withdrawals are paused");
        return Err(MgkError::OperationPaused.into());
    }

    if amount == 0 {
        msg!("Error: Withdraw amount must be greater than zero");
        return Err(MgkError::InvalidQuantity.into());
    }

    if !user_account.is_signer() {
        msg!("Error: User must be a signer");
        return Err(MgkError::Unauthorized.into());
    }

    if portfolio.user != *user_account.key() {
        msg!("Error: Portfolio does not belong to user");
        return Err(MgkError::Unauthorized.into());
    }

    // Check free collateral
    if (amount as i128) > portfolio.free_collateral {
        msg!("Error: Insufficient free collateral");
        return Err(MgkError::InsufficientFunds.into());
    }

    // Check vault has enough
    if amount > vault.balance {
        msg!("Error: Vault insufficient balance");
        return Err(MgkError::InsufficientFunds.into());
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
        .ok_or(MgkError::Underflow)?;
    portfolio.equity = portfolio.equity
        .checked_sub(amount_i128)
        .ok_or(MgkError::Underflow)?;
    portfolio.recalc_margin();

    msg!("Withdraw successful");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::registry::PAUSE_WITHDRAWALS;

    /// M7 7.8: `withdrawals_paused` blocks `Withdraw`. See the
    /// matching test in `commit_order.rs` for why we pin the pattern
    /// here rather than call the full instruction.
    #[test]
    fn test_withdraw_withdrawals_paused_pattern() {
        use pinocchio::pubkey::Pubkey;
        let mut r = Registry::new(Pubkey::from([9u8; 32]));
        r.set_pause_flags(PAUSE_WITHDRAWALS);
        assert!(r.is_withdrawals_paused());
        let err: u64 = MgkError::OperationPaused.into();
        assert_eq!(err, 602);
    }
}
