use crate::state::{Instrument, Registry};
use mgk_common::MgkError;
use pinocchio::{
    account_info::AccountInfo,
    msg,
    pubkey::Pubkey,
    ProgramResult,
};

#[allow(clippy::too_many_arguments)]
pub fn process_add_instrument(
    registry: &mut Registry,
    governance_account: &AccountInfo,
    instrument_account: &AccountInfo,
    instrument_id: u16,
    tick_size: u64,
    lot_size: u64,
    imr_bps: u16,
    mmr_bps: u16,
    taker_fee_bps: u16,
    maker_fee_bps: i16,
    oracle_addr: Pubkey,
    bump: u8,
) -> ProgramResult {
    if !governance_account.is_signer() {
        msg!("Error: Governance must be a signer");
        return Err(MgkError::Unauthorized.into());
    }

    if registry.governance != *governance_account.key() {
        msg!("Error: Invalid governance");
        return Err(MgkError::Unauthorized.into());
    }

    if registry.instrument_count >= 32 {
        msg!("Error: Instrument registry full");
        return Err(MgkError::InvalidInstruction.into());
    }

    let mut sym = [0u8; 16];
    // Set first 4 bytes as "INST"
    sym[0] = b'I';
    sym[1] = b'N';
    sym[2] = b'S';
    sym[3] = b'T';

    let inst_data = unsafe {
        &mut *(instrument_account.borrow_mut_data_unchecked().as_ptr() as *mut Instrument)
    };
    inst_data.initialize_in_place(
        instrument_id,
        sym,
        1,
        tick_size,
        lot_size,
        imr_bps,
        mmr_bps,
        taker_fee_bps,
        maker_fee_bps,
        10,
        oracle_addr,
        100,
        1_000,   // mark_reference_qty (M7 7.5)
        150,     // mark_decay_window_slots (M7 7.5)
        bump,
        // M7 7.4 — funding rate params (design L527-532, defaults)
        1,        // interest_rate_bps
        5,        // deviation_cap_bps
        50,       // funding_cap_bps
        10_000,   // funding_sample_qty
        8,        // funding_sma_window
    );
    registry.instrument_count += 1;

    msg!("Instrument added");
    Ok(())
}
