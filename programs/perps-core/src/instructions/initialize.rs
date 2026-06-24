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
    governance_account: &AccountInfo,
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
    // Instrument layout (all little-endian):
    //   @0   instrument_id       u16
    //   @2   base_symbol         [u8; 16]
    //   @18  contract_size       u64
    //   @26  tick_size           u64
    //   @34  lot_size            u64
    //   @42  imr_bps             u16
    //   @44  mmr_bps             u16
    //   @46  taker_fee_bps       u16
    //   @48  maker_fee_bps       i16
    //   @50  max_leverage        u16
    //   @52  _pad_ml             [u8; 2]
    //   @54  oracle_addr         Pubkey (32 bytes)
    //   @86  cum_funding         i128
    //   @102 last_funding_slot   u64
    //   @110 funding_interval    u64
    //   @118 is_active           bool (1 byte)
    //   @119 bump                u8
    //   @120 _padding            [u8; 6]
    //   @126 mark_price          i64
    //   @134 mark_reference_qty  u64
    //   @142 mark_decay_window   u64
    //   @150 interest_rate_bps   i64
    //   @158 deviation_cap_bps   i64
    //   @166 funding_cap_bps     i64
    //   @174 funding_sample_qty  u64
    //   @182 funding_sma_window  u8
    //   @183 premium_sample_cnt  u8
    //   @184 _pad_funding        [u8; 6]
    //   @190 premium_samples     [i64; 16] (128 bytes)
    let mut sym = [0u8; 16];
    sym[0] = b'S';
    sym[1] = b'O';
    sym[2] = b'L';
    sym[3] = b'P';
    let dst = unsafe { instrument_account.borrow_mut_data_unchecked().as_ptr() as *mut u8 };
    unsafe {
        *(dst as *mut u16) = instrument_id;                                // @0
        dst.add(2).copy_from_nonoverlapping(sym.as_ptr(), 16);            // @2 base_symbol
        *(dst.add(18) as *mut u64) = 1u64;                                // @18 contract_size
        *(dst.add(26) as *mut u64) = tick_size;                           // @26 tick_size
        *(dst.add(34) as *mut u64) = lot_size;                            // @34 lot_size
        *(dst.add(42) as *mut u16) = imr_bps;                             // @42 imr_bps
        *(dst.add(44) as *mut u16) = mmr_bps;                             // @44 mmr_bps
        *(dst.add(46) as *mut u16) = taker_fee_bps;                       // @46 taker_fee_bps
        *(dst.add(48) as *mut i16) = maker_fee_bps;                       // @48 maker_fee_bps
        *(dst.add(50) as *mut u16) = 10u16;                               // @50 max_leverage
        // _pad_ml @52..54 left zero
        dst.add(54).copy_from_nonoverlapping(oracle_addr.as_ref().as_ptr(), 32); // @54 oracle_addr
        // cum_funding @86..102 left zero (i128 zeroed)
        *(dst.add(102) as *mut u64) = 0;                                  // @102 last_funding_slot
        *(dst.add(110) as *mut u64) = 100u64;                             // @110 funding_interval_slots
        *(dst.add(118) as *mut u8) = 1;                                   // @118 is_active = true
        *(dst.add(119) as *mut u8) = instrument_bump;                     // @119 bump
        // _padding @120..126 left zero
        *(dst.add(126) as *mut i64) = 0;                                  // @126 mark_price
        *(dst.add(134) as *mut u64) = 1_000u64;                           // @134 mark_reference_qty
        *(dst.add(142) as *mut u64) = 150u64;                             // @142 mark_decay_window_slots
        *(dst.add(150) as *mut i64) = 1;                                  // @150 interest_rate_bps
        *(dst.add(158) as *mut i64) = 5;                                  // @158 deviation_cap_bps
        *(dst.add(166) as *mut i64) = 50;                                 // @166 funding_cap_bps
        *(dst.add(174) as *mut u64) = 10_000u64;                          // @174 funding_sample_qty
        *(dst.add(182) as *mut u8) = 8;                                   // @182 funding_sma_window
        // premium_sample_count @183 left zero
        // _pad_funding @184..190 left zero
        // premium_samples @190..318 left zero ([0; 16] i128s)
    }
    msg!("Default instrument initialized");

    Ok(())
}
