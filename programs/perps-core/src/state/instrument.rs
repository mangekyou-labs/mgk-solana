use pinocchio::pubkey::Pubkey;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct Instrument {
    pub instrument_id: u16,
    pub base_symbol: [u8; 16],
    pub contract_size: u64,
    pub tick_size: u64,
    pub lot_size: u64,
    pub imr_bps: u16,
    pub mmr_bps: u16,
    pub taker_fee_bps: u16,
    /// Maker fee in bps. Signed (i16): positive = fee, negative = rebate (design L379).
    pub maker_fee_bps: i16,
    pub max_leverage: u16,
    pub _pad_ml: [u8; 2],
    pub oracle_addr: Pubkey,
    pub cum_funding: i128,
    /// Last slot at which `cum_funding` was accrued (u64 slot — fixed
    /// from i64 in M7 7.4 to match `Clock.slot`). 0 = uninitialized /
    /// never accrued.
    pub last_funding_slot: u64,
    pub funding_interval_slots: u64,
    pub is_active: bool,
    pub bump: u8,
    pub _padding: [u8; 6],
    // M7 7.5: mark price fields (decision D3 — stored on Instrument, not
    // Batch). The current mark is written by SettleBatch after computing
    // the depth-weighted book sweep + oracle blend (design L468-501).
    pub mark_price: i64,
    /// Target contract qty for the depth-weighted sweep. The sweep walks
    /// the book until it has accumulated this many contracts on each
    /// side; the price at the level that crosses the threshold is the
    /// sweep price. Default 1_000 contracts.
    pub mark_reference_qty: u64,
    /// Number of slots after which the book is considered stale and the
    /// mark price falls back to the oracle. Default 150 slots (~60s at
    /// 400ms/slot on mainnet, ~75s on devnet).
    pub mark_decay_window_slots: u64,
    // D7: Funding rate parameters (replaces legacy SMA-based formula).
    // The funding rate formula is:
    //   rate_bps = clamp(((mark - index) * coefficient_bps) / index, ±max_rate_bps)
    //
    // Layout-compatible with M7 7.4 fields at the same offsets.
    // Unused legacy fields (deviation_cap, sample_qty, sma_window,
    // premium_samples) are retained as inert reserved bytes.

    /// D7: Funding coefficient in bps (signed non-negative). 10_000 = 1×.
    /// At offset 160 (was `interest_rate_bps`). Default 10_000.
    pub funding_coefficient_bps: i64,
    /// Legacy field — unused by D7. Retained as inert reserved bytes
    /// for on-chain layout compatibility. Was `deviation_cap_bps`.
    pub _reserved_deviation_cap: i64,
    /// D7: Max absolute funding rate in bps (signed non-negative).
    /// At offset 176 (was `funding_cap_bps`). Default 50.
    pub max_funding_rate_bps: i64,
    /// Legacy field — unused by D7. Was `funding_sample_qty`.
    pub _reserved_sample_qty: u64,
    /// Legacy field — unused by D7. Was `funding_sma_window`.
    pub _reserved_sma_window: u8,
    /// Legacy field — unused by D7. Was `premium_sample_count`.
    pub _reserved_sample_count: u8,
    pub _pad_funding: [u8; 6],
    /// Legacy field — unused by D7. Retained as inert reserved bytes.
    /// Was `premium_samples` (16-entry ring buffer).
    pub _reserved_premium_samples: [i64; 16],
}

impl Instrument {
    #[allow(clippy::too_many_arguments)]
    pub fn initialize_in_place(
        &mut self,
        instrument_id: u16,
        base_symbol: [u8; 16],
        contract_size: u64,
        tick_size: u64,
        lot_size: u64,
        imr_bps: u16,
        mmr_bps: u16,
        taker_fee_bps: u16,
        maker_fee_bps: i16,
        max_leverage: u16,
        oracle_addr: Pubkey,
        funding_interval_slots: u64,
        mark_reference_qty: u64,
        mark_decay_window_slots: u64,
        bump: u8,
        // D7 — funding rate params (replaces M7 7.4 SMA-based formula)
        funding_coefficient_bps: i64,
        _reserved_deviation_cap: i64,
        max_funding_rate_bps: i64,
        _reserved_sample_qty: u64,
        _reserved_sma_window: u8,
    ) {
        self.instrument_id = instrument_id;
        self.base_symbol = base_symbol;
        self.contract_size = contract_size;
        self.tick_size = tick_size;
        self.lot_size = lot_size;
        self.imr_bps = imr_bps;
        self.mmr_bps = mmr_bps;
        self.taker_fee_bps = taker_fee_bps;
        self.maker_fee_bps = maker_fee_bps;
        self.max_leverage = max_leverage;
        self._pad_ml = [0; 2];
        self.oracle_addr = oracle_addr;
        self.cum_funding = 0;
        self.last_funding_slot = 0;
        self.funding_interval_slots = funding_interval_slots;
        self.is_active = true;
        self.bump = bump;
        self._padding = [0; 6];
        self.mark_price = 0;
        self.mark_reference_qty = mark_reference_qty;
        self.mark_decay_window_slots = mark_decay_window_slots;
        self.funding_coefficient_bps = funding_coefficient_bps;
        self._reserved_deviation_cap = _reserved_deviation_cap;
        self.max_funding_rate_bps = max_funding_rate_bps;
        self._reserved_sample_qty = _reserved_sample_qty;
        self._reserved_sma_window = _reserved_sma_window;
        self._reserved_sample_count = 0;
        self._pad_funding = [0; 6];
        self._reserved_premium_samples = [0; 16];
    }

    #[cfg(test)]
    pub fn new(instrument_id: u16, tick_size: u64, lot_size: u64, imr_bps: u16, mmr_bps: u16) -> Self {
        let mut sym = [0u8; 16];
        sym[0] = b'T';
        sym[1] = b'E';
        sym[2] = b'S';
        sym[3] = b'T';
        let mut inst = Self {
            instrument_id,
            base_symbol: sym,
            contract_size: 1,
            tick_size,
            lot_size,
            imr_bps,
            mmr_bps,
            taker_fee_bps: 5,
            maker_fee_bps: 0,
            max_leverage: 10,
            _pad_ml: [0; 2],
            oracle_addr: Pubkey::default(),
            cum_funding: 0,
            last_funding_slot: 0,
            funding_interval_slots: 100,
            is_active: true,
            bump: 0,
            _padding: [0; 6],
            mark_price: 0,
            mark_reference_qty: 1_000,
            mark_decay_window_slots: 150,
            funding_coefficient_bps: 10_000,
            _reserved_deviation_cap: 0,
            max_funding_rate_bps: 50,
            _reserved_sample_qty: 0,
            _reserved_sma_window: 0,
            _reserved_sample_count: 0,
            _pad_funding: [0; 6],
            _reserved_premium_samples: [0; 16],
        };
        inst.initialize_in_place(
            instrument_id,
            sym,
            1,
            tick_size,
            lot_size,
            imr_bps,
            mmr_bps,
            5,
            0,
            10,
            Pubkey::default(),
            100,
            1_000,
            150,
            0,
            10_000,   // funding_coefficient_bps (D7: 10_000 = 1×)
            0,        // _reserved_deviation_cap
            50,       // max_funding_rate_bps (D7: 50 bps cap)
            0,        // _reserved_sample_qty
            0,        // _reserved_sma_window
        );
        inst
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use core::mem::size_of;

    #[test]
    fn test_instrument_new() {
        let inst = Instrument::new(1, 1_000_000, 1_000, 100, 50);
        assert_eq!(inst.instrument_id, 1);
        assert_eq!(inst.imr_bps, 100);
        assert_eq!(inst.mmr_bps, 50);
        assert!(inst.is_active);
        assert_eq!(inst.cum_funding, 0);
        // Locked D3: makers 0 bps (not a rebate), taker 5 bps.
        assert_eq!(inst.maker_fee_bps, 0);
        assert_eq!(inst.taker_fee_bps, 5);
    }

    #[test]
    fn test_maker_fee_rebate() {
        // Negative maker_fee_bps = rebate; positive = fee.
        let mut inst = Instrument::new(1, 1, 1, 100, 50);
        inst.maker_fee_bps = -5;
        assert_eq!(inst.maker_fee_bps, -5);
        inst.maker_fee_bps = 5;
        assert_eq!(inst.maker_fee_bps, 5);
    }

    /// Pin the struct size so a refactor that adds/removes a field is
    /// caught at compile time. e2e tests and on-chain account allocations
    /// depend on this number.
    #[test]
    fn test_instrument_size() {
        // Pre-7.5 size was 144 (rounded up to 16 from 130 logical bytes
        // with 14 bytes of natural-alignment padding for i128 at offset
        // 96). After adding mark_price (i64) + mark_reference_qty (u64)
        // + mark_decay_window_slots (u64) at the tail, the size grows by
        // 24 → 168, but since the trailing fields sit on 8-byte alignment
        // immediately after _padding, the struct is 160 bytes.
        // M7 7.4: 160 + 176 (8 new funding fields + 128-byte ring
        // buffer) = 336 bytes, 16-aligned due to cum_funding: i128.
        assert_eq!(size_of::<Instrument>(), 336);
    }

    /// M7 7.4: `last_funding_slot` is `u64` (slot type), not `i64`. Pinned
    /// at compile time by the struct definition; this runtime check is a
    /// regression guard against a future "fix" that reverts it to i64.
    #[test]
    fn test_last_funding_slot_is_u64() {
        let mut inst = Instrument::new(1, 1_000_000, 1_000, 100, 50);
        inst.last_funding_slot = u64::MAX;
        assert_eq!(inst.last_funding_slot, u64::MAX);
        inst.last_funding_slot = 0;
        assert_eq!(inst.last_funding_slot, 0);
    }

    /// M7 7.4: all new funding fields start at documented defaults
    /// (design L527-532) and the premium ring buffer is zeroed.
    #[test]
    fn test_funding_defaults() {
        let inst = Instrument::new(1, 1_000_000, 1_000, 100, 50);
        assert_eq!(inst.funding_coefficient_bps, 10_000); // D7 default
        assert_eq!(inst._reserved_deviation_cap, 0);      // reserved
        assert_eq!(inst.max_funding_rate_bps, 50);         // D7 default
        assert_eq!(inst._reserved_sample_qty, 0);          // reserved
        assert_eq!(inst._reserved_sma_window, 0);          // reserved
        assert_eq!(inst._reserved_sample_count, 0);        // reserved
        assert_eq!(inst._reserved_premium_samples, [0i64; 16]);
        assert_eq!(inst.last_funding_slot, 0);
        assert_eq!(inst.cum_funding, 0);
        assert_eq!(inst.funding_interval_slots, 100);
    }
}
