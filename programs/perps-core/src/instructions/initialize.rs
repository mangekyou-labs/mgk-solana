use pinocchio::{
    account_info::AccountInfo,
    msg,
    pubkey::Pubkey,
    ProgramResult,
};

#[allow(clippy::too_many_arguments)]
pub fn process_initialize(
    registry_account: &AccountInfo,
    _governance_account: &AccountInfo,
    governance: &Pubkey,
    instrument_count: u16,
    volatility_multiplier: u16,
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
    msg!("INIT_RUST_V2"); // Unique marker to verify correct binary
    // ─────────────────────────────────────────────────────────────────────────
    // Initialize Registry state (accounts must be pre-created externally)
    // ─────────────────────────────────────────────────────────────────────────
    // Write fields directly using byte offsets — bypasses struct layout entirely
    unsafe {
        let dst = registry_account.borrow_mut_data_unchecked().as_ptr() as *mut u8;
        // governance @ 0 (32 bytes)
        *(dst as *mut [u8; 32]) = *governance;
        // instrument_count @ 32 (2 bytes)
        *(dst.add(32) as *mut u16) = instrument_count;
        // volatility_multiplier @ 34 (2 bytes)
        *(dst.add(34) as *mut u16) = volatility_multiplier;
        // batch_id_counter @ 36 (8 bytes)
        *(dst.add(36) as *mut u64) = 0u64;
        // base_deposit @ 44 (8 bytes)
        *(dst.add(44) as *mut u64) = base_deposit;
        // n_min @ 52 (4 bytes)
        *(dst.add(52) as *mut u32) = n_min;
        // t_min_slots @ 56 (8 bytes)
        *(dst.add(56) as *mut u64) = t_min_slots;
        // t_max_slots @ 64 (8 bytes)
        *(dst.add(64) as *mut u64) = t_max_slots;
        // t_reveal_slots @ 72 (8 bytes)
        *(dst.add(72) as *mut u64) = t_reveal_slots;
        // bump @ 80 (1 byte)
        *dst.add(80) = bump;
        // pause_flags @ 81 (1 byte)
        *dst.add(81) = 0u8;
        // padding @ 82..86 (4 bytes) — already zero from createAccount
    }
    msg!("INIT_DONE_214");
    msg!("Registry initialized");

    // ─────────────────────────────────────────────────────────────────────────
    // Initialize Instrument state — direct byte-offset writes to avoid SBF
    // compiler bug with struct field assignment (same root cause as registry
    // and batch init bugs).
    //
    // Instrument `#[repr(C)]` offsets (pinned by `print_instrument_offsets` host test):
    //   @0 id, @2 symbol[16], @24 contract, @32 tick, @40 lot,
    //   @48 imr, @50 mmr, @52 taker_fee, @54 maker_fee, @56 max_lev, @58 pad2,
    //   @60 oracle[32], @92 cum_funding i128, @108 last_funding, @116 interval,
    //   @124 is_active, @125 bump, @126 pad6+align, @136 mark_price, @144 ref_qty,
    //   @152 decay, @160 interest, @168 deviation, @176 funding_cap, @184 sample_qty,
    //   @192 sma_window, @193 sample_count, @200 premium_samples[16]
    let mut sym = [0u8; 16];
    sym[0] = b'S';
    sym[1] = b'O';
    sym[2] = b'L';
    sym[3] = b'P';
    let dst = unsafe { instrument_account.borrow_mut_data_unchecked().as_ptr() as *mut u8 };
    unsafe {
        *(dst as *mut u16) = instrument_id;
        dst.add(2).copy_from_nonoverlapping(sym.as_ptr(), 16);
        *(dst.add(24) as *mut u64) = 1u64; // contract_size
        *(dst.add(32) as *mut u64) = tick_size;
        *(dst.add(40) as *mut u64) = lot_size;
        *(dst.add(48) as *mut u16) = imr_bps;
        *(dst.add(50) as *mut u16) = mmr_bps;
        *(dst.add(52) as *mut u16) = taker_fee_bps;
        *(dst.add(54) as *mut i16) = maker_fee_bps;
        *(dst.add(56) as *mut u16) = 10u16; // max_leverage
        dst.add(60)
            .copy_from_nonoverlapping(oracle_addr.as_ref().as_ptr(), 32);
        *(dst.add(108) as *mut u64) = 0; // last_funding_slot
        *(dst.add(116) as *mut u64) = 100u64; // funding_interval_slots
        *dst.add(124) = 1; // is_active
        *dst.add(125) = instrument_bump;
        *(dst.add(136) as *mut i64) = 0; // mark_price
        *(dst.add(144) as *mut u64) = 1_000u64; // mark_reference_qty
        *(dst.add(152) as *mut u64) = 150u64; // mark_decay_window_slots
        *(dst.add(160) as *mut i64) = 1; // interest_rate_bps
        *(dst.add(168) as *mut i64) = 5; // deviation_cap_bps
        *(dst.add(176) as *mut i64) = 50; // funding_cap_bps
        *(dst.add(184) as *mut u64) = 10_000u64; // funding_sample_qty
        *dst.add(192) = 8; // funding_sma_window
    }
    msg!("Default instrument initialized");

    Ok(())
}
