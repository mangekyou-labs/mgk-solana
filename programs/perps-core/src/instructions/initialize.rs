use crate::state::{Instrument, Registry};
use pinocchio::{
    account_info::AccountInfo,
    msg,
    pubkey::Pubkey,
    ProgramResult,
};

#[allow(clippy::too_many_arguments)]
pub fn process_initialize(
    registry_account: &AccountInfo,
    governance: &Pubkey,
    base_deposit: u64,
    n_min: u32,
    t_min_slots: u64,
    t_max_slots: u64,
    t_reveal_slots: u64,
    bump: u8,
    instrument_account: &AccountInfo,
    instrument_id: u16,
    tick_size: u64,
    lot_size: u64,
    imr_bps: u16,
    mmr_bps: u16,
    taker_fee_bps: u16,
    maker_fee_bps: i16,
    oracle_addr: Pubkey,
    instrument_bump: u8,
) -> ProgramResult {
    let registry_data = unsafe {
        &mut *(registry_account.borrow_mut_data_unchecked().as_ptr() as *mut Registry)
    };
    registry_data.initialize_in_place(*governance, base_deposit, n_min, t_min_slots, t_max_slots, t_reveal_slots, bump);
    msg!("Registry initialized");

    // Initialize first instrument
    let mut sym = [0u8; 16];
    sym[0] = b'S';
    sym[1] = b'O';
    sym[2] = b'L';
    sym[3] = b'P';
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
        100,        // funding_interval_slots
        1_000,      // mark_reference_qty (M7 7.5)
        150,        // mark_decay_window_slots (M7 7.5)
        instrument_bump,
    );
    registry_data.instrument_count = 1;
    msg!("Default instrument initialized");

    Ok(())
}
