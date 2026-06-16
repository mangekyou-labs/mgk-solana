use crate::state::{Portfolio, Vault};
use percolator_common::PercolatorError;
use pinocchio::{
    account_info::AccountInfo,
    instruction::{AccountMeta, Instruction},
    msg,
    program::invoke,
    ProgramResult,
};

pub fn process_deposit(
    _portfolio_account: &AccountInfo,
    portfolio: &mut Portfolio,
    user_account: &AccountInfo,
    system_program: &AccountInfo,
    vault_account: &AccountInfo,
    vault: &mut Vault,
    amount: u64,
) -> ProgramResult {
    if amount == 0 {
        msg!("Error: Deposit amount must be greater than zero");
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

    // CPI to System Program: transfer SOL from user to vault
    let mut instruction_data = [0u8; 12];
    instruction_data[0..4].copy_from_slice(&2u32.to_le_bytes());
    instruction_data[4..12].copy_from_slice(&amount.to_le_bytes());

    let transfer_instruction = Instruction {
        program_id: system_program.key(),
        accounts: &[
            AccountMeta {
                pubkey: user_account.key(),
                is_signer: true,
                is_writable: true,
            },
            AccountMeta {
                pubkey: vault_account.key(),
                is_signer: false,
                is_writable: true,
            },
        ],
        data: &instruction_data,
    };

    invoke(
        &transfer_instruction,
        &[user_account, vault_account, system_program],
    )?;

    // Update state
    vault.balance = vault.balance.saturating_add(amount);

    let amount_i128 = amount as i128;
    portfolio.principal = portfolio.principal
        .checked_add(amount_i128)
        .ok_or(PercolatorError::Overflow)?;
    portfolio.equity = portfolio.equity
        .checked_add(amount_i128)
        .ok_or(PercolatorError::Overflow)?;
    portfolio.recalc_margin();

    msg!("Deposit successful");
    Ok(())
}
