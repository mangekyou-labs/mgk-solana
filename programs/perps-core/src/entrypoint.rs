use pinocchio::{
    account_info::AccountInfo,
    entrypoint,
    msg,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

use crate::instructions::{
    CoreInstruction, process_add_instrument, process_cancel_resting_order, process_clear_batch,
    process_close_committing, process_commit_order, process_deposit, process_init_portfolio,
    process_initialize, process_liquidate_user, process_modify_resting_order, process_reveal_order,
    process_set_pause_flags, process_settle_batch, process_withdraw,
};
use crate::state::{Portfolio, Registry, Vault};
use percolator_common::{
    PercolatorError, validate_owner, validate_writable, borrow_account_data_mut,
};

entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    if instruction_data.is_empty() {
        msg!("Error: Instruction data is empty");
        return Err(PercolatorError::InvalidInstruction.into());
    }

    let discriminator = instruction_data[0];
    let instruction = match discriminator {
        0 => CoreInstruction::Initialize,
        1 => CoreInstruction::InitPortfolio,
        2 => CoreInstruction::Deposit,
        3 => CoreInstruction::Withdraw,
        4 => CoreInstruction::CommitOrder,
        5 => CoreInstruction::RevealOrder,
        6 => CoreInstruction::CloseCommitting,
        7 => CoreInstruction::ClearBatch,
        8 => CoreInstruction::SettleBatch,
        9 => CoreInstruction::LiquidateUser,
        10 => CoreInstruction::AddInstrument,
        11 => CoreInstruction::CancelRestingOrder,
        12 => CoreInstruction::ModifyRestingOrder,
        14 => CoreInstruction::SetPauseFlags,
        _ => {
            msg!("Error: Unknown instruction");
            return Err(PercolatorError::InvalidInstruction.into());
        }
    };

    match instruction {
        CoreInstruction::Initialize => {
            msg!("Instruction: Initialize");
            process_initialize_inner(program_id, accounts, &instruction_data[1..])
        }
        CoreInstruction::InitPortfolio => {
            msg!("Instruction: InitPortfolio");
            process_init_portfolio_inner(program_id, accounts, &instruction_data[1..])
        }
        CoreInstruction::Deposit => {
            msg!("Instruction: Deposit");
            process_deposit_inner(program_id, accounts, &instruction_data[1..])
        }
        CoreInstruction::Withdraw => {
            msg!("Instruction: Withdraw");
            process_withdraw_inner(program_id, accounts, &instruction_data[1..])
        }
        CoreInstruction::CommitOrder => {
            msg!("Instruction: CommitOrder");
            process_commit_order_inner(program_id, accounts, &instruction_data[1..])
        }
        CoreInstruction::RevealOrder => {
            msg!("Instruction: RevealOrder");
            process_reveal_order_inner(program_id, accounts, &instruction_data[1..])
        }
        CoreInstruction::CloseCommitting => {
            msg!("Instruction: CloseCommitting");
            process_close_committing_inner(program_id, accounts, &instruction_data[1..])
        }
        CoreInstruction::ClearBatch => {
            msg!("Instruction: ClearBatch");
            process_clear_batch_inner(program_id, accounts, &instruction_data[1..])
        }
        CoreInstruction::SettleBatch => {
            msg!("Instruction: SettleBatch");
            process_settle_batch_inner(program_id, accounts, &instruction_data[1..])
        }
        CoreInstruction::LiquidateUser => {
            msg!("Instruction: LiquidateUser");
            process_liquidate_user_inner(program_id, accounts, &instruction_data[1..])
        }
        CoreInstruction::AddInstrument => {
            msg!("Instruction: AddInstrument");
            process_add_instrument_inner(program_id, accounts, &instruction_data[1..])
        }
        CoreInstruction::CancelRestingOrder => {
            msg!("Instruction: CancelRestingOrder");
            process_cancel_resting_order_inner(program_id, accounts, &instruction_data[1..])
        }
        CoreInstruction::ModifyRestingOrder => {
            msg!("Instruction: ModifyRestingOrder");
            process_modify_resting_order_inner(program_id, accounts, &instruction_data[1..])
        }
        CoreInstruction::SetPauseFlags => {
            msg!("Instruction: SetPauseFlags");
            process_set_pause_flags_inner(program_id, accounts, &instruction_data[1..])
        }
    }
}

/// Initialize registry + first instrument
///
/// Accounts:
/// 0. [writable] Registry PDA
/// 1. [signer, writable] Governance
/// 2. [writable] Default instrument PDA
///
/// Data: governance(32) + base_deposit(8) + n_min(4) + t_min(8) + t_max(8) + t_reveal(8)
///       + instrument_id(2) + tick(8) + lot(8) + imr(2) + mmr(2) + taker_fee_bps(2) + maker_fee_bps(2)
///       + oracle(32) + registry_bump(1) + instrument_bump(1)
fn process_initialize_inner(_program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if accounts.len() < 3 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    // 32+8+4+8+8+8 + 2+8+8+2+2+2+2+32 + 1+1 = 128
    if data.len() < 128 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let registry_account = &accounts[0];
    let _governance_account = &accounts[1];
    let instrument_account = &accounts[2];

    validate_writable(registry_account)?;
    validate_writable(instrument_account)?;

    let governance = Pubkey::from(<[u8; 32]>::try_from(&data[0..32]).unwrap());
    let base_deposit = u64::from_le_bytes(data[32..40].try_into().unwrap());
    let n_min = u32::from_le_bytes(data[40..44].try_into().unwrap());
    let t_min_slots = u64::from_le_bytes(data[44..52].try_into().unwrap());
    let t_max_slots = u64::from_le_bytes(data[52..60].try_into().unwrap());
    let t_reveal_slots = u64::from_le_bytes(data[60..68].try_into().unwrap());
    let instrument_id = u16::from_le_bytes(data[68..70].try_into().unwrap());
    let tick_size = u64::from_le_bytes(data[70..78].try_into().unwrap());
    let lot_size = u64::from_le_bytes(data[78..86].try_into().unwrap());
    let imr_bps = u16::from_le_bytes(data[86..88].try_into().unwrap());
    let mmr_bps = u16::from_le_bytes(data[88..90].try_into().unwrap());
    let taker_fee_bps = u16::from_le_bytes(data[90..92].try_into().unwrap());
    let maker_fee_bps = i16::from_le_bytes(data[92..94].try_into().unwrap());
    let oracle_addr = Pubkey::from(<[u8; 32]>::try_from(&data[94..126]).unwrap());
    let registry_bump = data[126];
    let instrument_bump = data[127];

    process_initialize(
        registry_account,
        &governance,
        base_deposit,
        n_min,
        t_min_slots,
        t_max_slots,
        t_reveal_slots,
        registry_bump,
        instrument_account,
        instrument_id,
        tick_size,
        lot_size,
        imr_bps,
        mmr_bps,
        taker_fee_bps,
        maker_fee_bps,
        oracle_addr,
        instrument_bump,
    )
}

/// Initialize a user portfolio
///
/// Accounts:
/// 0. [writable] Portfolio PDA
/// 1. [signer, writable] Payer
///
/// Data: user_pubkey(32) + bump(1)
fn process_init_portfolio_inner(_program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if accounts.len() < 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.len() < 33 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let portfolio_account = &accounts[0];
    let payer = &accounts[1];

    if !payer.is_signer() {
        return Err(PercolatorError::Unauthorized.into());
    }

    validate_writable(portfolio_account)?;

    let user = Pubkey::from(<[u8; 32]>::try_from(&data[0..32]).unwrap());
    let bump = data[32];

    process_init_portfolio(portfolio_account, &user, bump)
}

/// Deposit SOL collateral
///
/// Accounts:
/// 0. [writable] Portfolio PDA
/// 1. [signer, writable] User wallet
/// 2. [] System program
/// 3. [writable] Vault PDA
///
/// Data: amount(8)
fn process_deposit_inner(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if accounts.len() < 4 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.len() < 8 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let portfolio_account = &accounts[0];
    let user_account = &accounts[1];
    let system_program = &accounts[2];
    let vault_account = &accounts[3];

    validate_owner(portfolio_account, program_id)?;
    validate_writable(portfolio_account)?;
    validate_writable(user_account)?;
    validate_owner(vault_account, program_id)?;
    validate_writable(vault_account)?;

    let portfolio = unsafe { borrow_account_data_mut::<Portfolio>(portfolio_account)? };
    let vault = unsafe { borrow_account_data_mut::<Vault>(vault_account)? };

    let amount = u64::from_le_bytes(data[0..8].try_into().unwrap());

    process_deposit(portfolio_account, portfolio, user_account, system_program, vault_account, vault, amount)
}

/// Withdraw SOL collateral
///
/// Accounts:
/// 0. [writable] Portfolio PDA
/// 1. [signer, writable] User wallet
/// 2. [writable] Vault PDA
/// 3. [] Registry (M7 7.8: required for withdrawals_paused check)
///
/// Data: amount(8)
fn process_withdraw_inner(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if accounts.len() < 4 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.len() < 8 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let portfolio_account = &accounts[0];
    let user_account = &accounts[1];
    let vault_account = &accounts[2];
    let registry_account = &accounts[3];

    validate_owner(portfolio_account, program_id)?;
    validate_writable(portfolio_account)?;
    validate_writable(user_account)?;
    validate_owner(vault_account, program_id)?;
    validate_writable(vault_account)?;
    validate_owner(registry_account, program_id)?;

    let portfolio = unsafe { borrow_account_data_mut::<Portfolio>(portfolio_account)? };
    let vault = unsafe { borrow_account_data_mut::<Vault>(vault_account)? };

    let amount = u64::from_le_bytes(data[0..8].try_into().unwrap());

    process_withdraw(portfolio_account, portfolio, user_account, vault_account, vault, registry_account, amount)
}

/// Add an instrument (governance only)
///
/// Accounts:
/// 0. [writable] Registry PDA
/// 1. [signer] Governance
/// 2. [writable] Instrument PDA
///
/// Data: instrument_id(2) + tick(8) + lot(8) + imr(2) + mmr(2) + taker_fee_bps(2) + maker_fee_bps(2) + oracle(32) + bump(1)
fn process_add_instrument_inner(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if accounts.len() < 3 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    // 2+8+8+2+2+2+2+32+1 = 59
    if data.len() < 59 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let registry_account = &accounts[0];
    let governance_account = &accounts[1];
    let instrument_account = &accounts[2];

    validate_owner(registry_account, program_id)?;
    validate_writable(registry_account)?;
    validate_writable(instrument_account)?;

    let registry = unsafe { borrow_account_data_mut::<Registry>(registry_account)? };

    let instrument_id = u16::from_le_bytes(data[0..2].try_into().unwrap());
    let tick_size = u64::from_le_bytes(data[2..10].try_into().unwrap());
    let lot_size = u64::from_le_bytes(data[10..18].try_into().unwrap());
    let imr_bps = u16::from_le_bytes(data[18..20].try_into().unwrap());
    let mmr_bps = u16::from_le_bytes(data[20..22].try_into().unwrap());
    let taker_fee_bps = u16::from_le_bytes(data[22..24].try_into().unwrap());
    let maker_fee_bps = i16::from_le_bytes(data[24..26].try_into().unwrap());
    let oracle_addr = Pubkey::from(<[u8; 32]>::try_from(&data[26..58]).unwrap());
    let bump = data[58];

    process_add_instrument(
        registry,
        governance_account,
        instrument_account,
        instrument_id,
        tick_size,
        lot_size,
        imr_bps,
        mmr_bps,
        taker_fee_bps,
        maker_fee_bps,
        oracle_addr,
        bump,
    )
}

/// Commit to an order in a batch
///
/// Accounts:
/// 0. [writable] Commitment PDA
/// 1. [signer, writable] User wallet
/// 2. [writable] Portfolio PDA
/// 3. [] Batch PDA
/// 4. [] Registry
///
/// Data (M6 6g): order_type(1) + instrument_id(2) + reduce_only(1) + side(1) + price(8) + qty(8) + salt(8) + batch_id(8) + commitment_bump(1) = 38
fn process_commit_order_inner(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if accounts.len() < 5 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.len() < 38 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let commitment_account = &accounts[0];
    let user_account = &accounts[1];
    let portfolio_account = &accounts[2];
    let batch_account = &accounts[3];
    let registry_account = &accounts[4];

    validate_owner(commitment_account, program_id)?;
    validate_writable(commitment_account)?;
    validate_owner(portfolio_account, program_id)?;
    validate_writable(portfolio_account)?;
    validate_owner(batch_account, program_id)?;
    validate_owner(registry_account, program_id)?;

    let order_type = data[0];
    let instrument_id = u16::from_le_bytes(data[1..3].try_into().unwrap());
    let reduce_only = data[3] != 0;
    let side = data[4];
    let price = i64::from_le_bytes(data[5..13].try_into().unwrap());
    let qty = u64::from_le_bytes(data[13..21].try_into().unwrap());
    let salt = u64::from_le_bytes(data[21..29].try_into().unwrap());
    let batch_id = u64::from_le_bytes(data[29..37].try_into().unwrap());
    let commitment_bump = data[37];

    process_commit_order(
        commitment_account,
        user_account,
        portfolio_account,
        batch_account,
        registry_account,
        order_type,
        instrument_id,
        reduce_only,
        side,
        price,
        qty,
        salt,
        batch_id,
        commitment_bump,
    )
}

/// Reveal a previously committed order
///
/// Accounts:
/// 0. [writable] Commitment PDA
/// 1. [signer] User
/// 2. [writable] Portfolio PDA
/// 3. [] Batch PDA
/// 4. [] Registry (M7 7.8: required for trading_paused check)
///
/// Data (M6 6g): order_type(1) + instrument_id(2) + reduce_only(1) + side(1) + price(8) + qty(8) + salt(8) + batch_id(8) = 37
fn process_reveal_order_inner(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if accounts.len() < 5 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.len() < 37 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let commitment_account = &accounts[0];
    let user_account = &accounts[1];
    let portfolio_account = &accounts[2];
    let batch_account = &accounts[3];
    let registry_account = &accounts[4];

    validate_owner(commitment_account, program_id)?;
    validate_writable(commitment_account)?;
    validate_owner(portfolio_account, program_id)?;
    validate_writable(portfolio_account)?;
    validate_owner(batch_account, program_id)?;
    validate_owner(registry_account, program_id)?;

    let order_type = data[0];
    let instrument_id = u16::from_le_bytes(data[1..3].try_into().unwrap());
    let reduce_only = data[3] != 0;
    let side = data[4];
    let price = i64::from_le_bytes(data[5..13].try_into().unwrap());
    let qty = u64::from_le_bytes(data[13..21].try_into().unwrap());
    let salt = u64::from_le_bytes(data[21..29].try_into().unwrap());
    let batch_id = u64::from_le_bytes(data[29..37].try_into().unwrap());

    process_reveal_order(
        commitment_account,
        user_account,
        portfolio_account,
        batch_account,
        registry_account,
        order_type,
        instrument_id,
        reduce_only,
        side,
        price,
        qty,
        salt,
        batch_id,
    )
}

/// Close the committing phase of a batch (permissionless crank)
///
/// Accounts:
/// 0. [writable] Batch PDA
/// 1. [] Registry
///
/// Data: none
fn process_close_committing_inner(program_id: &Pubkey, accounts: &[AccountInfo], _data: &[u8]) -> ProgramResult {
    if accounts.len() < 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let batch_account = &accounts[0];
    let registry_account = &accounts[1];

    validate_owner(batch_account, program_id)?;
    validate_writable(batch_account)?;
    validate_owner(registry_account, program_id)?;

    process_close_committing(program_id, batch_account, registry_account)
}

/// Clear a batch by invoking the matcher program (M6 6i.2).
///
/// M7 7.6: account list extended to include per-batch instrument and
/// portfolio accounts so Core can pre-compute per-user notional caps
/// (D2: `cap = portfolio.free_collateral * instrument.max_leverage`).
///
/// Accounts:
/// 0. [writable] Batch PDA
/// 1. [writable] Book account (matcher-owned, `["book", instrument_id_le]`)
/// 2. [writable] Results account
/// 3. [] Matcher program
/// 4. [] Registry
///    5..5+I. [] Instrument accounts (I = num_instruments, M7 7.6)
///    5+I..5+I+C. [] Commitment accounts (C = num_commitments)
///    5+I+C..5+I+C+P. [] Portfolio accounts (P = num_portfolios, M7 7.6)
///
/// Data (M7 7.6): num_commitments(2) + num_instruments(2) + num_portfolios(2)
fn process_clear_batch_inner(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if accounts.len() < 6 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.len() < 6 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let batch_account = &accounts[0];
    let book_account = &accounts[1];
    let results_account = &accounts[2];
    let matcher_program = &accounts[3];
    let registry_account = &accounts[4];

    let num_commitments = u16::from_le_bytes(data[0..2].try_into().unwrap()) as usize;
    let num_instruments = u16::from_le_bytes(data[2..4].try_into().unwrap()) as usize;
    let num_portfolios = u16::from_le_bytes(data[4..6].try_into().unwrap()) as usize;

    let instrument_accounts = &accounts[5..5 + num_instruments];
    let commitment_accounts = &accounts[5 + num_instruments..5 + num_instruments + num_commitments];
    let portfolio_accounts = &accounts
        [5 + num_instruments + num_commitments..5 + num_instruments + num_commitments + num_portfolios];

    validate_owner(batch_account, program_id)?;
    validate_writable(batch_account)?;
    validate_writable(results_account)?;

    process_clear_batch(
        program_id,
        batch_account,
        book_account,
        results_account,
        matcher_program,
        registry_account,
        instrument_accounts,
        commitment_accounts,
        portfolio_accounts,
    )
}

/// Settle a cleared batch — update positions and return/slash deposits (M6 6i.3).
/// M7 7.1: also creates the next Batch PDA in place (per design decision D1).
///
/// Accounts (M7 7.1: a `next_batch` PDA was added as the last account):
/// 0. [writable] Batch PDA (current batch being settled)
/// 1. [writable] Registry
/// 2. [writable] Vault PDA
/// 3. [] Results account
/// 4. [writable] Instrument account (M7 7.5: now writable so we can
///    write `instrument.mark_price` back)
/// 5. [] Book PDA (matcher-owned, read-only from Core; provides the
///    depth-weighted sweep input for mark price — design L468-501)
/// 6. [] Fallback oracle account (provides the oracle price for mark
///    price when the book is empty/stale; owner = percolator-oracle)
/// 7. [] Matcher program (the key is used to derive the book PDA
///    address for validation — same pattern as ClearBatch /
///    CancelRestingOrder / ModifyRestingOrder).
///
/// Then a variable-length list:
///   - indices 8..8+C: commitment accounts (C = total_commitments)
///   - indices 8+C..8+C+P: portfolio accounts (P = num_portfolios)
///   - index 8+C+P (M7 7.1): the next Batch PDA — fresh, core-owned, and
///     `size_of::<Batch>()` bytes. Caller pre-allocates it (system_program
///     CPI in the same TX, or pre-created by the keeper).
///
/// Data: num_commitments(2) + num_portfolios(2)
fn process_settle_batch_inner(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if accounts.len() < 7 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.len() < 4 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let batch_account = &accounts[0];
    let registry_account = &accounts[1];
    let vault_account = &accounts[2];
    let results_account = &accounts[3];
    let instrument_account = &accounts[4];
    let book_account = &accounts[5];
    let oracle_account = &accounts[6];
    let matcher_program = &accounts[7];

    let num_commitments = u16::from_le_bytes(data[0..2].try_into().unwrap()) as usize;
    let num_portfolios = u16::from_le_bytes(data[2..4].try_into().unwrap()) as usize;

    validate_owner(batch_account, program_id)?;
    validate_writable(batch_account)?;
    validate_owner(registry_account, program_id)?;
    validate_writable(registry_account)?;
    validate_owner(vault_account, program_id)?;
    validate_writable(vault_account)?;
    // M7 7.5: instrument is now writable so we can write mark_price.
    validate_owner(instrument_account, program_id)?;
    validate_writable(instrument_account)?;

    let commitment_accounts = &accounts[8..8 + num_commitments];
    let portfolio_accounts = &accounts[8 + num_commitments..8 + num_commitments + num_portfolios];
    // M7 7.1: next-batch account is the last account in the list. Slice
    // pattern avoids panics if num_commitments/num_portfolios are tampered.
    let next_batch_account = accounts
        .get(8 + num_commitments + num_portfolios)
        .ok_or(ProgramError::NotEnoughAccountKeys)?;
    validate_writable(next_batch_account)?;
    validate_owner(next_batch_account, program_id)?;

    process_settle_batch(
        program_id,
        batch_account,
        registry_account,
        vault_account,
        results_account,
        instrument_account,
        book_account,
        oracle_account,
        matcher_program,
        commitment_accounts,
        portfolio_accounts,
        next_batch_account,
    )
}

/// Liquidate an underwater portfolio
///
/// Accounts:
/// 0. [writable] Portfolio PDA
/// 1. [] Registry
/// 2. [writable] Vault PDA
/// 3. [signer] Liquidator
///    4..4+N. [] Oracle accounts (N = num_oracles)
///
/// Data: num_oracles(2)
fn process_liquidate_user_inner(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if accounts.len() < 5 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.len() < 2 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let portfolio_account = &accounts[0];
    let registry_account = &accounts[1];
    let vault_account = &accounts[2];
    let liquidator_account = &accounts[3];

    let num_oracles = u16::from_le_bytes(data[0..2].try_into().unwrap()) as usize;
    let oracle_accounts = &accounts[4..4 + num_oracles];

    validate_owner(portfolio_account, program_id)?;
    validate_writable(portfolio_account)?;
    validate_owner(registry_account, program_id)?;
    validate_owner(vault_account, program_id)?;
    validate_writable(vault_account)?;

    process_liquidate_user(
        portfolio_account,
        registry_account,
        vault_account,
        liquidator_account,
        oracle_accounts,
    )
}

/// Cancel a resting order by id (M6 6h).
///
/// Accounts:
/// 0. [writable] Portfolio PDA
/// 1. [signer, writable] User wallet
/// 2. [writable] Book account (matcher-owned)
/// 3. [] Matcher program
///
/// Data: order_id(8)
fn process_cancel_resting_order_inner(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 4 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.len() < 8 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let portfolio_account = &accounts[0];
    let user_account = &accounts[1];
    let book_account = &accounts[2];
    let matcher_program = &accounts[3];

    let order_id = u64::from_le_bytes(data[0..8].try_into().unwrap());

    process_cancel_resting_order(
        program_id,
        portfolio_account,
        user_account,
        book_account,
        matcher_program,
        order_id,
    )
}

/// Modify a resting order's qty (M6 6h).
///
/// Accounts:
/// 0. [writable] Portfolio PDA
/// 1. [signer, writable] User wallet
/// 2. [writable] Book account (matcher-owned)
/// 3. [] Matcher program
///
/// Data: order_id(8) + new_qty(8) = 16
fn process_modify_resting_order_inner(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 4 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.len() < 16 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let portfolio_account = &accounts[0];
    let user_account = &accounts[1];
    let book_account = &accounts[2];
    let matcher_program = &accounts[3];

    let order_id = u64::from_le_bytes(data[0..8].try_into().unwrap());
    let new_qty = u64::from_le_bytes(data[8..16].try_into().unwrap());

    process_modify_resting_order(
        program_id,
        portfolio_account,
        user_account,
        book_account,
        matcher_program,
        order_id,
        new_qty,
    )
}

/// M7 7.8: governance-only pause-flag setter (disc 14).
///
/// Wire format: disc(1) + flags(1) = 2 bytes (the disc is stripped
/// before this inner fn is called).
///
/// Accounts:
/// 0. [writable] Registry PDA
/// 1. [signer]   Governance (must equal `registry.governance`)
///
/// Bits 4..7 of the flags byte are reserved and masked off inside
/// `set_pause_flags` so a malformed instruction cannot set future flags.
fn process_set_pause_flags_inner(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if accounts.len() < 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.is_empty() {
        return Err(ProgramError::InvalidInstructionData);
    }

    let registry_account = &accounts[0];
    let governance_account = &accounts[1];

    validate_owner(registry_account, program_id)?;
    validate_writable(registry_account)?;
    // Governance is a normal account owned by the system program, not
    // a PDA; the caller checks `is_signer` and that
    // `governance_account.key() == registry.governance`.

    let flags = data[0];

    let registry = unsafe { borrow_account_data_mut::<Registry>(registry_account)? };

    process_set_pause_flags(registry, governance_account, flags)
}
