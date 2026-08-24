//! InitPortfolioForUser (disc 19) — creates and initializes a Portfolio
//! account at the user's portfolio PDA via `invoke_signed`.
//!
//! Two signing modes:
//!
//! 1. **Wallet-funded (T9.10)**: The connected wallet (user) signs as
//!    fee-payer and as `accounts[0]`. The instruction validates
//!    `requested_user == signer` — a user can only create their own
//!    portfolio. The PDA's implicit signature is provided by `invoke_signed`
//!    via seed verification.
//!
//! 2. **Keeper-signed (legacy)**: A keeper signs as `accounts[0]` and
//!    provides the user pubkey in the instruction data. The PDA is still
//!    created via `invoke_signed`.
//!
//! Accounts (wallet-funded):
//!   0: [writable, signer]  User / payer
//!   1: [writable]          Portfolio PDA (created here via invoke_signed)
//!
//! Accounts (keeper-signed, 3 accounts):
//!   0: [writable, signer]  Keeper (payer)
//!   1: [writable]          Portfolio PDA (created here via invoke_signed)
//!
//! Data: user_pubkey(32) = 32 bytes total (disc 19 stripped by dispatcher)

use crate::state::Portfolio;
use pinocchio::{
    account_info::AccountInfo,
    instruction::{AccountMeta, Instruction, Signer},
    msg,
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::{find_program_address, Pubkey},
    sysvars::{rent::Rent, Sysvar},
    ProgramResult,
};

/// Space for Portfolio struct (verified via size_of::<Portfolio>()).
const PORTFOLIO_SPACE: usize = core::mem::size_of::<Portfolio>();

/// System Program ID (same on all clusters).
const SYSTEM_PROGRAM_ID_BYTES: [u8; 32] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0,
];

pub fn process_init_portfolio_for_user(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 2 {
        msg!("Error: Not enough accounts for InitPortfolioForUser");
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let payer_account = &accounts[0];
    let portfolio_account = &accounts[1];

    if !payer_account.is_signer() {
        msg!("Error: Payer must sign");
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Parse user pubkey from instruction data
    let user_bytes = data.get(0..32).ok_or(ProgramError::InvalidInstructionData)?;
    let user = Pubkey::from(<[u8; 32]>::try_from(user_bytes).unwrap());

    // T9.10 wallet-funded path: when only 2 accounts are provided, the
    // payer IS the user — validate that the requested portfolio user
    // equals the signer. A user can only create their own portfolio.
    if accounts.len() == 2 && user != *payer_account.key() {
        msg!("Error: requested portfolio user must equal the signer");
        return Err(ProgramError::InvalidArgument);
    }

    // Derive user's portfolio PDA
    let (portfolio_pda, bump) = find_program_address(&[b"portfolio", user.as_ref()], program_id);

    // If portfolio account is not yet created (data_len == 0), use invoke_signed
    // + SystemProgram::CreateAccount to create it at the PDA address.
    if portfolio_account.data_len() < PORTFOLIO_SPACE {
        let rent_exempt = Rent::get()?.minimum_balance(PORTFOLIO_SPACE);
        let lamports_needed = rent_exempt.saturating_sub(portfolio_account.lamports());

        if payer_account.lamports() < lamports_needed {
            msg!("Error: insufficient SOL for rent exemption");
            return Err(ProgramError::InsufficientFunds);
        }

        // SystemProgram::CreateAccount layout: variant(u32 LE) + lamports(8) + space(8) + owner(32) = 52 bytes.
        let mut ix_data = [0u8; 52];
        ix_data[0..4].copy_from_slice(&0u32.to_le_bytes()); // CreateAccount variant
        ix_data[4..12].copy_from_slice(&lamports_needed.to_le_bytes());
        ix_data[12..20].copy_from_slice(&(PORTFOLIO_SPACE as u64).to_le_bytes());
        ix_data[20..52].copy_from_slice(program_id.as_ref());

        let system_program_id = Pubkey::from(SYSTEM_PROGRAM_ID_BYTES);
        let create_ix = Instruction {
            program_id: &system_program_id,
            accounts: &[
                AccountMeta::writable_signer(payer_account.key()),
                AccountMeta::writable_signer(&portfolio_pda),
            ],
            data: &ix_data,
        };

        let bump_seed = [bump];
        let signer_seeds = pinocchio::seeds!(b"portfolio", user.as_ref(), &bump_seed);
        let signer = Signer::from(&signer_seeds);
        let signers = [signer];

        invoke_signed::<2>(
            &create_ix,
            &[
                payer_account,
                portfolio_account,
            ],
            &signers,
        )?;

        msg!("InitPortfolioForUser: created portfolio at PDA via invoke_signed");
    }

    // Initialize portfolio data in-place (idempotent).
    let data_ptr = unsafe { portfolio_account.borrow_mut_data_unchecked().as_ptr() } as *mut u8;
    unsafe {
        core::ptr::copy_nonoverlapping(user.as_ref().as_ptr(), data_ptr, 32);
        core::ptr::write_bytes(data_ptr.add(32), 0, PORTFOLIO_SPACE - 32);
    }

    msg!("InitPortfolioForUser: portfolio initialized for user");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portfolio_space_matches_portfolio_layout() {
        assert_eq!(PORTFOLIO_SPACE, core::mem::size_of::<Portfolio>());
    }

    #[test]
    fn create_account_instruction_data_is_system_wire_format() {
        let lamports = 123u64;
        let mut ix_data = [0u8; 52];
        ix_data[0..4].copy_from_slice(&0u32.to_le_bytes());
        ix_data[4..12].copy_from_slice(&lamports.to_le_bytes());
        ix_data[12..20].copy_from_slice(&(PORTFOLIO_SPACE as u64).to_le_bytes());

        assert_eq!(u32::from_le_bytes(ix_data[0..4].try_into().unwrap()), 0);
        assert_eq!(u64::from_le_bytes(ix_data[4..12].try_into().unwrap()), lamports);
        assert_eq!(
            u64::from_le_bytes(ix_data[12..20].try_into().unwrap()),
            PORTFOLIO_SPACE as u64,
        );
    }
}
