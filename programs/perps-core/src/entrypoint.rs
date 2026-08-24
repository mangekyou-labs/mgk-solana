use pinocchio::{
    account_info::AccountInfo, entrypoint, msg, program_error::ProgramError, pubkey::Pubkey,
    ProgramResult,
};

use crate::instructions::{
    process_add_instrument, process_cancel_all_resting_orders, process_cancel_resting_order,
    process_clear_batch, process_close_committing, process_commit_order, process_create_batch,
    process_create_portfolio, process_deposit, process_init_portfolio,
    process_init_portfolio_for_user, process_init_vault, process_initialize,
    process_liquidate_user, process_modify_resting_order, process_post_order, process_reveal_order,
    process_set_batch_counter, process_set_batch_params, process_set_funding_params,
    process_set_instrument_fees, process_set_instrument_oracle, process_set_pause_flags,
    process_settle_batch, process_withdraw, CoreInstruction,
};
use crate::state::{Portfolio, Registry, Vault};
use mgk_common::{borrow_account_data_mut, validate_owner, validate_writable, MgkError};

entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    if instruction_data.is_empty() {
        msg!("Error: Instruction data is empty");
        return Err(MgkError::InvalidInstruction.into());
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
        13 => CoreInstruction::CancelAllRestingOrders,
        14 => CoreInstruction::SetPauseFlags,
        15 => CoreInstruction::InitVault,
        16 => CoreInstruction::CreateBatch,
        17 => CoreInstruction::SetBatchCounter,
        18 => CoreInstruction::CreatePortfolio,
        19 => CoreInstruction::InitPortfolioForUser,
        20 => CoreInstruction::PostOrder,
        21 => CoreInstruction::SetBatchParams,
        22 => CoreInstruction::SetInstrumentFees,
        23 => CoreInstruction::SetInstrumentOracle,
        24 => CoreInstruction::SetFundingParams,
        _ => {
            msg!("Error: Unknown instruction");
            return Err(MgkError::InvalidInstruction.into());
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
        CoreInstruction::CancelAllRestingOrders => {
            msg!("Instruction: CancelAllRestingOrders");
            process_cancel_all_resting_orders_inner(program_id, accounts, &instruction_data[1..])
        }
        CoreInstruction::SetPauseFlags => {
            msg!("Instruction: SetPauseFlags");
            process_set_pause_flags_inner(program_id, accounts, &instruction_data[1..])
        }
        CoreInstruction::InitVault => {
            msg!("Instruction: InitVault");
            process_init_vault_inner(program_id, accounts, &instruction_data[1..])
        }
        CoreInstruction::CreateBatch => {
            msg!("Instruction: CreateBatch");
            process_create_batch_inner(program_id, accounts, &instruction_data[1..])
        }
        CoreInstruction::SetBatchCounter => {
            msg!("Instruction: SetBatchCounter");
            process_set_batch_counter_inner(program_id, accounts, &instruction_data[1..])
        }
        CoreInstruction::CreatePortfolio => {
            msg!("Instruction: CreatePortfolio");
            process_create_portfolio_inner(program_id, accounts, &instruction_data[1..])
        }
        CoreInstruction::InitPortfolioForUser => {
            msg!("Instruction: InitPortfolioForUser");
            process_init_portfolio_for_user(program_id, accounts, &instruction_data[1..])
        }
        CoreInstruction::PostOrder => {
            msg!("Instruction: PostOrder");
            process_post_order_inner(program_id, accounts, &instruction_data[1..])
        }
        CoreInstruction::SetBatchParams => {
            msg!("Instruction: SetBatchParams");
            process_set_batch_params_inner(program_id, accounts, &instruction_data[1..])
        }
        CoreInstruction::SetInstrumentFees => {
            msg!("Instruction: SetInstrumentFees");
            process_set_instrument_fees_inner(program_id, accounts, &instruction_data[1..])
        }
        CoreInstruction::SetInstrumentOracle => {
            msg!("Instruction: SetInstrumentOracle");
            process_set_instrument_oracle_inner(program_id, accounts, &instruction_data[1..])
        }
        CoreInstruction::SetFundingParams => {
            msg!("Instruction: SetFundingParams");
            process_set_funding_params_inner(program_id, accounts, &instruction_data[1..])
        }
    }
}

/// DFBA PostOrder (disc 20).
///
/// Accounts:
/// 0. [writable] Portfolio
/// 1. [signer] User
/// 2. [writable] Batch (open window; increments post count)
/// 3. [] Registry
/// 4. [writable] Book (matcher-owned)
/// 5. [] Matcher program
///
/// Data: side(1) + is_maker(1) + price(8) + qty(8) + instrument_id(2) + reduce_only(1) = 21
fn process_post_order_inner(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 6 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.len() < 21 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let side = data[0];
    let is_maker = data[1] != 0;
    let price = i64::from_le_bytes(data[2..10].try_into().unwrap());
    let qty = u64::from_le_bytes(data[10..18].try_into().unwrap());
    let instrument_id = u16::from_le_bytes(data[18..20].try_into().unwrap());
    let reduce_only = data[20] != 0;

    process_post_order(
        program_id,
        &accounts[0],
        &accounts[1],
        &accounts[2],
        &accounts[3],
        &accounts[4],
        &accounts[5],
        side,
        is_maker,
        price,
        qty,
        instrument_id,
        reduce_only,
    )
}

/// SetBatchParams (disc 21) — governance-only batch parameter update.
///
/// Accounts:
///   0. [writable] Registry PDA
///   1. [signer]   Governance
///
/// Data: max_orders(1) + marginal_cap(1) + t_min(8) + t_max(8) + n_min(4) = 22 bytes
fn process_set_batch_params_inner(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.len() < 22 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let registry_account = &accounts[0];
    let governance_account = &accounts[1];

    validate_owner(registry_account, program_id)?;
    validate_writable(registry_account)?;

    let max_orders = data[0];
    let marginal_cap = data[1];
    let t_min_slots = u64::from_le_bytes(data[2..10].try_into().unwrap());
    let t_max_slots = u64::from_le_bytes(data[10..18].try_into().unwrap());
    let n_min = u32::from_le_bytes(data[18..22].try_into().unwrap());

    process_set_batch_params(
        program_id,
        registry_account,
        governance_account,
        max_orders,
        marginal_cap,
        t_min_slots,
        t_max_slots,
        n_min,
    )
}

/// SetInstrumentFees (disc 22) — governance-only instrument fee retune.
///
/// Accounts:
///   0. [writable] Instrument PDA
///   1. []         Registry PDA
///   2. [signer]   Governance
///
/// Data: taker_fee_bps(2) + maker_fee_bps(2) = 4 bytes
fn process_set_instrument_fees_inner(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 3 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.len() < 4 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let instrument_account = &accounts[0];
    let registry_account = &accounts[1];
    let governance_account = &accounts[2];

    validate_owner(instrument_account, program_id)?;
    validate_writable(instrument_account)?;
    validate_owner(registry_account, program_id)?;

    let taker_fee_bps = u16::from_le_bytes(data[0..2].try_into().unwrap());
    let maker_fee_bps = i16::from_le_bytes(data[2..4].try_into().unwrap());

    process_set_instrument_fees(
        program_id,
        instrument_account,
        registry_account,
        governance_account,
        taker_fee_bps,
        maker_fee_bps,
    )
}

/// SetInstrumentOracle (disc 23) — governance-only instrument oracle binding.
///
/// Accounts:
///   0. [writable] Instrument PDA
///   1. []         Registry PDA
///   2. [signer]   Governance
///   3. []         PriceOracle data account
///
/// Data: none (discriminator only)
fn process_set_instrument_oracle_inner(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    _data: &[u8],
) -> ProgramResult {
    if accounts.len() < 4 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let instrument_account = &accounts[0];
    let registry_account = &accounts[1];
    let governance_account = &accounts[2];
    let oracle_account = &accounts[3];

    process_set_instrument_oracle(
        program_id,
        instrument_account,
        registry_account,
        governance_account,
        oracle_account,
    )
}

/// SetFundingParams (disc 24) — governance-only D7 funding parameter update.
///
/// Accounts:
///   0. [writable] Instrument PDA
///   1. []         Registry PDA
///   2. [signer]   Governance
///
/// Data: coefficient_bps(i64 LE) + max_rate_bps(i64 LE) + interval_slots(u64 LE) = 24 bytes
fn process_set_funding_params_inner(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 3 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.len() < 24 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let instrument_account = &accounts[0];
    let registry_account = &accounts[1];
    let governance_account = &accounts[2];

    let coefficient_bps = i64::from_le_bytes(data[0..8].try_into().unwrap());
    let max_rate_bps = i64::from_le_bytes(data[8..16].try_into().unwrap());
    let interval_slots = u64::from_le_bytes(data[16..24].try_into().unwrap());

    process_set_funding_params(
        program_id,
        instrument_account,
        registry_account,
        governance_account,
        coefficient_bps,
        max_rate_bps,
        interval_slots,
    )
}

/// Initialize registry + first instrument
///
/// Accounts:
/// 0. [writable] Registry PDA (created via CPI)
/// 1. [signer, writable] Governance
/// 2. [writable] Instrument #0 PDA (created via CPI)
///
/// Vault and Batch #0 are created by the keeper via CPI (SettleBatch).
///
/// Data: governance(32) + instrument_count(2) + volatility_multiplier(2)
///       + batch_id_counter(8) + base_deposit(8) + n_min(4) + t_min(8) + t_max(8) + t_reveal(8)
///       + instrument_id(2) + tick(8) + lot(8) + imr(2) + mmr(2) + taker_fee_bps(2) + maker_fee_bps(2)
///       + oracle(32) + registry_bump(1) + instrument_bump(1)
///     = 140 bytes
fn process_initialize_inner(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 4 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    // 32+2+2+8+8+4+8+8+8 + 2+8+8+2+2+2+2+32 + 1+1 = 140
    if data.len() < 140 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let registry_account = &accounts[0];
    let governance_account = &accounts[1];
    let instrument_account = &accounts[2];
    let system_program = &accounts[3];
    // Vault PDA (index 4) — created by Initialize if needed.
    // Optional: if not provided, vault creation is skipped (caller must pre-create).
    let vault_account = if accounts.len() > 4 {
        Some(&accounts[4])
    } else {
        None
    };

    if !governance_account.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    validate_writable(registry_account)?;
    validate_writable(instrument_account)?;

    let governance = Pubkey::from(<[u8; 32]>::try_from(&data[0..32]).unwrap());
    let instrument_count = u16::from_le_bytes(data[32..34].try_into().unwrap());
    let volatility_multiplier = u16::from_le_bytes(data[34..36].try_into().unwrap());
    let _batch_id_counter = u64::from_le_bytes(data[36..44].try_into().unwrap()); // always 0, parsed for alignment
    let base_deposit = u64::from_le_bytes(data[44..52].try_into().unwrap());
    let n_min = u32::from_le_bytes(data[52..56].try_into().unwrap());
    let t_min_slots = u64::from_le_bytes(data[56..64].try_into().unwrap());
    let t_max_slots = u64::from_le_bytes(data[64..72].try_into().unwrap());
    let t_reveal_slots = u64::from_le_bytes(data[72..80].try_into().unwrap());
    let instrument_id = u16::from_le_bytes(data[80..82].try_into().unwrap());
    let tick_size = u64::from_le_bytes(data[82..90].try_into().unwrap());
    let lot_size = u64::from_le_bytes(data[90..98].try_into().unwrap());
    let imr_bps = u16::from_le_bytes(data[98..100].try_into().unwrap());
    let mmr_bps = u16::from_le_bytes(data[100..102].try_into().unwrap());
    let taker_fee_bps = u16::from_le_bytes(data[102..104].try_into().unwrap());
    let maker_fee_bps = i16::from_le_bytes(data[104..106].try_into().unwrap());
    let oracle_addr = Pubkey::from(<[u8; 32]>::try_from(&data[106..138]).unwrap());
    let registry_bump = data[138];
    let instrument_bump = data[139];
    // vault_bump is passed as byte 140 if vault account is provided.
    let vault_bump = if data.len() > 140 { data[140] } else { 255 };

    // Use a dummy AccountInfo if vault not provided (creation will be skipped).
    let dummy_vault;
    let vault_ref = match vault_account {
        Some(v) => v,
        None => {
            // Create a minimal dummy — creation check will fail (data_len=0 but
            // lamports=0), so the invoke_signed will still run. Use governance as
            // placeholder; the actual vault PDA is derived internally.
            dummy_vault = *governance_account;
            &dummy_vault
        }
    };

    process_initialize(
        program_id,
        registry_account,
        governance_account,
        &governance,
        instrument_count,
        volatility_multiplier,
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
        system_program,
        vault_ref,
        vault_bump,
    )
}

/// Initialize a user portfolio
///
/// Accounts:
/// 0. [writable] Portfolio PDA
/// 1. [signer, writable] Payer
///
/// Data: user_pubkey(32) + bump(1)
fn process_init_portfolio_inner(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.len() < 33 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let portfolio_account = &accounts[0];
    let payer = &accounts[1];

    if !payer.is_signer() {
        return Err(MgkError::Unauthorized.into());
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
fn process_deposit_inner(
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

    process_deposit(
        portfolio_account,
        portfolio,
        user_account,
        system_program,
        vault_account,
        vault,
        amount,
    )
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
fn process_withdraw_inner(
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

    process_withdraw(
        portfolio_account,
        portfolio,
        user_account,
        vault_account,
        vault,
        registry_account,
        amount,
    )
}

/// Add an instrument (governance only)
///
/// Accounts:
/// 0. [writable] Registry PDA
/// 1. [signer] Governance
/// 2. [writable] Instrument PDA
///
/// Data: instrument_id(2) + tick(8) + lot(8) + imr(2) + mmr(2) + taker_fee_bps(2) + maker_fee_bps(2) + oracle(32) + bump(1)
fn process_add_instrument_inner(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
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
fn process_commit_order_inner(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
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
        program_id,
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
fn process_reveal_order_inner(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
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
fn process_close_committing_inner(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    _data: &[u8],
) -> ProgramResult {
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
fn process_clear_batch_inner(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
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
    let portfolio_accounts = &accounts[5 + num_instruments + num_commitments
        ..5 + num_instruments + num_commitments + num_portfolios];

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
/// 5. [] Book (matcher-owned, read-only from Core)
/// 6. [] Fallback oracle account (funding index; optional/missing ok)
/// 7. [] Matcher program
///
/// Then a variable-length list:
///   - indices 8..8+C: commitment accounts (C = total_commitments)
///   - indices 8+C..8+C+P: portfolio accounts (P = num_portfolios)
///   - index 8+C+P: next Batch PDA (created here via invoke_signed if empty)
///   - index 8+C+P+1: [signer, writable] Payer (required when creating next batch)
///   - index 8+C+P+2: [] System program (required when creating next batch)
///
/// Data: num_commitments(2) + num_portfolios(2) [+ next_batch_bump(1) when creating]
fn process_settle_batch_inner(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 8 {
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
    let next_batch_bump = if data.len() > 4 { data[4] } else { 0 };

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
    let next_idx = 8 + num_commitments + num_portfolios;
    let next_batch_account = accounts
        .get(next_idx)
        .ok_or(ProgramError::NotEnoughAccountKeys)?;
    validate_writable(next_batch_account)?;

    // Create next batch PDA if not yet allocated (CPI CreateAccount, 160 bytes).
    const BATCH_SPACE: usize = 160;
    if next_batch_account.data_len() < BATCH_SPACE {
        let payer = accounts
            .get(next_idx + 1)
            .ok_or(ProgramError::NotEnoughAccountKeys)?;
        let _system = accounts
            .get(next_idx + 2)
            .ok_or(ProgramError::NotEnoughAccountKeys)?;
        if !payer.is_signer() {
            return Err(ProgramError::MissingRequiredSignature);
        }
        // next_batch_id = current.batch_id + 1
        let current_batch_id = unsafe {
            let b =
                &*(batch_account.borrow_data_unchecked().as_ptr() as *const crate::state::Batch);
            b.batch_id
        };
        let next_id = current_batch_id.saturating_add(1);
        let next_id_le = next_id.to_le_bytes();

        use pinocchio::instruction::{AccountMeta, Instruction, Signer};
        use pinocchio::program::invoke_signed;
        use pinocchio::pubkey::find_program_address;
        use pinocchio::sysvars::{rent::Rent, Sysvar};

        let rent = Rent::get()?;
        let lamports = rent.minimum_balance(BATCH_SPACE);
        let (expected_pda, _) = find_program_address(&[b"batch", &next_id_le], program_id);
        if next_batch_account.key() != &expected_pda {
            msg!("Error: next_batch PDA mismatch");
            return Err(ProgramError::InvalidSeeds);
        }

        let mut ix_data = [0u8; 52];
        ix_data[0..4].copy_from_slice(&0u32.to_le_bytes());
        ix_data[4..12].copy_from_slice(&lamports.to_le_bytes());
        ix_data[12..20].copy_from_slice(&(BATCH_SPACE as u64).to_le_bytes());
        ix_data[20..52].copy_from_slice(program_id.as_ref());
        let sys_id = Pubkey::from([0u8; 32]);
        let metas = [
            AccountMeta::writable_signer(payer.key()),
            AccountMeta::writable_signer(next_batch_account.key()),
        ];
        let ix = Instruction {
            program_id: &sys_id,
            accounts: &metas,
            data: &ix_data,
        };
        let bump_seed = [next_batch_bump];
        let signer_seeds = pinocchio::seeds!(b"batch", next_id_le.as_slice(), &bump_seed);
        let signer = Signer::from(&signer_seeds);
        invoke_signed::<2>(&ix, &[payer, next_batch_account], &[signer])?;
        msg!("SettleBatch: next batch PDA created");
    } else {
        validate_owner(next_batch_account, program_id)?;
    }

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

/// Liquidate an underwater portfolio (M7 7.7 + DFBA mark gate).
///
/// Accounts (fixed + variable):
/// - index 0: writable Portfolio PDA
/// - index 1: read-only Registry
/// - index 2: writable Vault PDA
/// - index 3: signer Liquidator
/// - index 4: read-only Batch (Settled; `mark_valid` / `liq_paused`)
/// - indices 5..5+num_instruments: read-only Instrument accounts
/// - index 5+num_instruments: read-only fallback oracle account
///
/// Data: num_instruments(2)
fn process_liquidate_user_inner(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 6 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.len() < 2 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let portfolio_account = &accounts[0];
    let registry_account = &accounts[1];
    let vault_account = &accounts[2];
    let liquidator_account = &accounts[3];
    let batch_account = &accounts[4];

    let num_instruments = u16::from_le_bytes(data[0..2].try_into().unwrap()) as usize;
    let inst_end = 5usize
        .checked_add(num_instruments)
        .ok_or(ProgramError::InvalidInstructionData)?;
    if accounts.len() < inst_end + 1 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let instrument_accounts = &accounts[5..inst_end];
    let oracle_account = &accounts[inst_end];

    validate_owner(portfolio_account, program_id)?;
    validate_writable(portfolio_account)?;
    validate_owner(registry_account, program_id)?;
    validate_owner(vault_account, program_id)?;
    validate_writable(vault_account)?;
    validate_owner(batch_account, program_id)?;

    process_liquidate_user(
        program_id,
        portfolio_account,
        registry_account,
        vault_account,
        liquidator_account,
        batch_account,
        instrument_accounts,
        oracle_account,
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
fn process_set_pause_flags_inner(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
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

/// Initialize the Vault (disc 15).
///
/// Accounts:
/// 0. [writable] Vault account (pre-created via SystemProgram.createAccount)
///
/// Data: bump(1)
fn process_init_vault_inner(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.is_empty() {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.is_empty() {
        return Err(ProgramError::InvalidInstructionData);
    }

    let vault_account = &accounts[0];
    validate_owner(vault_account, program_id)?;
    validate_writable(vault_account)?;

    let bump = data[0];
    process_init_vault(vault_account, bump)
}

/// Create the first batch (disc 16).
///
/// Accounts:
/// 0. [writable] Batch PDA (created via invoke_signed if not yet existing)
/// 1. [writable] Registry
/// 2. [signer, writable] Payer (optional; required if batch PDA not yet created)
///
/// Data: bump(1)
fn process_create_batch_inner(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.is_empty() {
        return Err(ProgramError::InvalidInstructionData);
    }

    let batch_account = &accounts[0];
    let registry_account = &accounts[1];
    let payer_account = if accounts.len() > 2 {
        Some(&accounts[2])
    } else {
        None
    };

    let bump = data[0];
    process_create_batch(
        program_id,
        batch_account,
        registry_account,
        payer_account,
        bump,
    )
}

/// M7 7.7: cancel every resting order owned by `user` across one or more
/// matcher-owned book accounts.
///
/// Wire format: disc(1) + num_books(2) = 3 bytes (the disc is stripped
/// before this inner fn is called).
///
/// Accounts (fixed + variable):
/// - index 0: writable Portfolio PDA
/// - index 1: signer + writable User wallet (must match `portfolio.user`)
/// - index 2: read-only Matcher program
/// - indices 3..3+num_books: writable Book accounts (one per instrument the
///   user has resting orders on; each is matcher-owned, derived as
///   `["book", instrument_id_le]`)
///
/// Dispatches a `CancelAll` (disc 4) CPI to the matcher program for each
/// book, carrying the user's pubkey as payload. The matcher removes every
/// resting order with that owner. Un-revealed commitments are NOT touched
/// (they expire via `CloseCommitting` / `SettleBatch` slash flow, M7 7.2).
fn process_cancel_all_resting_orders_inner(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 4 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.len() < 2 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let portfolio_account = &accounts[0];
    let user_account = &accounts[1];
    let matcher_program = &accounts[2];
    let num_books = u16::from_le_bytes(data[0..2].try_into().unwrap()) as usize;

    if accounts.len() < 3 + num_books {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let book_accounts = &accounts[3..3 + num_books];

    process_cancel_all_resting_orders(
        program_id,
        portfolio_account,
        user_account,
        matcher_program,
        book_accounts,
    )
}

/// SetBatchCounter — disc 17. Governance-only. Resets `batch_id_counter`
/// to 0 so `CreateBatch` can bootstrap batch 0.
///
/// Accounts:
///   0: [writable] Registry
///   1: [signer]   Governance (must equal registry.governance)
///
/// Data: none
fn process_set_batch_counter_inner(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    _data: &[u8],
) -> ProgramResult {
    if accounts.len() < 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let registry_account = &accounts[0];
    let governance_account = &accounts[1];

    validate_owner(registry_account, program_id)?;
    validate_writable(registry_account)?;

    if !governance_account.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    process_set_batch_counter(registry_account, governance_account)
}

/// Create and initialize a Portfolio PDA for a user.
///
/// Accounts:
///   0: [writable] Portfolio PDA (created by this instruction via CPI)
///   1: [signer]   User wallet
///   2: []         System program
///
/// Data: disc(1) + bump(1) = 2 bytes total (full data passed to inner fn)
fn process_create_portfolio_inner(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 3 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    // data[0] = disc, data[1] = bump; inner reads bump from data[1]
    process_create_portfolio(program_id, accounts, data)
}
