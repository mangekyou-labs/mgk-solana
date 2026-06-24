use crate::state::Portfolio;
use pinocchio::{
    account_info::AccountInfo,
    cpi::invoke_signed,
    instruction::{AccountMeta, Instruction, Seed, Signer},
    msg,
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvars::{rent::Rent, Sysvar},
    ProgramResult,
};

/// The canonical Solana System Program ID (all zeros = 111111...111111).
const SYSTEM_PROGRAM_ID: Pubkey = [0u8; 32];

/// Create and initialize a Portfolio PDA for `user`.
///
/// This instruction creates a new Portfolio PDA account and initializes it.
/// The Portfolio is derived from `["portfolio", user]` with the given bump.
///
/// Accounts:
///   0: [writable] Portfolio PDA - the new account to create
///   1: [signer]   User wallet - pays for the account creation
///   2: []         System program
///
/// Data: bump(1)
pub fn process_create_portfolio(
    program_id: &Pubkey,
    portfolio_account: &AccountInfo,
    user_account: &AccountInfo,
    system_program: &AccountInfo,
    bump: u8,
) -> ProgramResult {
    msg!("CreatePortfolio: starting");

    // Validate accounts
    if !user_account.is_signer() {
        msg!("CreatePortfolio: user must sign");
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Calculate minimum rent exemption
    let rent = Rent::get()?;
    let space = core::mem::size_of::<Portfolio>() as u64;
    let lamports = rent.minimum_balance(space as usize);

    // Encode SystemInstruction::CreateAccount:
    // disc(1) + lamports(8) + space(8) + owner(32) = 49 bytes
    let mut instruction_data = [0u8; 49];
    instruction_data[0] = 0u8; // CreateAccount discriminant
    instruction_data[1..9].copy_from_slice(&lamports.to_le_bytes());
    instruction_data[9..17].copy_from_slice(&space.to_le_bytes());
    instruction_data[17..49].copy_from_slice(program_id.as_ref());

    msg!("CreatePortfolio: building CreateAccount instruction");

    // Build the CreateAccount instruction.
    // Accounts in Solana SystemProgram order: [to (new account), from (payer), system]
    // The "to" account is the portfolio PDA — it is NOT a signer (PDAs can't sign).
    let create_account_ix = Instruction {
        program_id: &SYSTEM_PROGRAM_ID,
        accounts: &[
            AccountMeta::new(&*portfolio_account.key(), true, false),   // to: writable, not signer
            AccountMeta::new(&*user_account.key(), true, true),         // from: writable + signer (payer)
            AccountMeta::readonly(system_program.key()),                // system: neither
        ],
        data: &instruction_data,
    };

    // Build signer seeds using pinocchio's Seed/Signer API.
    // Seed::from(&[u8]) takes a byte slice; b"portfolio" is &'static [u8; 10].
    // The bump is passed as &[bump] (single-element slice).
    let bump_ref: &[u8] = &[bump];
    let signer_seeds: [Seed; 3] = [
        Seed::from(b"portfolio" as &[_]),  // seed: "portfolio"
        Seed::from(user_account.key().as_ref()), // seed: user pubkey bytes
        Seed::from(bump_ref),              // seed: bump byte
    ];

    // Wrap in a Signer — pinocchio's BPF loader correctly translates this
    // into the SignerSeedsC format that sol_invoke_signed_c expects.
    let signer = Signer::from(&signer_seeds);

    // Account infos in same order as the instruction accounts above.
    let account_infos: [&AccountInfo; 3] = [
        portfolio_account,
        user_account,
        system_program,
    ];

    msg!("CreatePortfolio: invoking CreateAccount with PDA signing");

    // invoke_signed correctly formats the seeds for sol_invoke_signed_c.
    invoke_signed(&create_account_ix, &account_infos, &[signer])?;

    msg!("CreatePortfolio: account created, initializing data");

    // Initialize portfolio fields using direct byte-offset writes (BPF alignment-safe).
    // The account was just created by CreateAccount, so data is zeroed.
    let data_slice = unsafe { portfolio_account.borrow_mut_data_unchecked() };
    if data_slice.is_empty() {
        msg!("CreatePortfolio: data slice is empty");
        return Err(ProgramError::InvalidAccountData);
    }
    let dst = data_slice.as_ptr() as *mut u8;
    // Safety: dst is valid for Portfolio size writes since account was just allocated.
    unsafe {
        // user @ 0 (Pubkey = 32 bytes)
        *(dst as *mut Pubkey) = *user_account.key();
        // positions_len @ 144 (u16)
        *(dst.add(144) as *mut u16) = 0;
        // bump @ 1186 (u8)
        *(dst.add(1186) as *mut u8) = bump;
    }

    msg!("CreatePortfolio: done");
    Ok(())
}
