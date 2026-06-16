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
    // M7 7.4: funding rate parameters (design L527-532 — Aligned with
    // Bulk.Trade). All three are integer bps; the funding rate formula
    // `F = clamp(P_mu + clamp(interest_rate - P_mu, -deviation_cap,
    // deviation_cap), -funding_cap, funding_cap)` is computed in pure
    // functions in `state/funding.rs` and applied in `SettleBatch`.
    /// Base interest rate in bps (signed). Default 1 bp.
    pub interest_rate_bps: i64,
    /// Max deviation of interest from the premium SMA in bps. Default 5 bp.
    pub deviation_cap_bps: i64,
    /// Absolute clamp on the funding rate in bps. Default 50 bp.
    pub funding_cap_bps: i64,
    /// Target contract qty for the funding premium sweep (P_bid, P_ask).
    /// Default 10_000 contracts (matches design L532).
    pub funding_sample_qty: u64,
    /// Number of premium samples used in the SMA (1..=16). Default 8.
    /// Window of 0 means "use the latest sample only" — useful for
    /// tests and first-batch edges.
    pub funding_sma_window: u8,
    /// How many samples are currently populated in `premium_samples[]`.
    /// Saturates at 16. Capped at `funding_sma_window` for the SMA.
    pub premium_sample_count: u8,
    pub _pad_funding: [u8; 6],
    /// Ring buffer of the most recent premium samples (bps × 1_000_000
    /// for 6 decimal places of precision). Capacity 16. New samples are
    /// written at `index = premium_sample_count % 16`; the SMA uses the
    /// most recent `min(premium_sample_count, funding_sma_window)`.
    pub premium_samples: [i64; 16],
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
        // M7 7.4 — funding rate params (design L527-532)
        interest_rate_bps: i64,
        deviation_cap_bps: i64,
        funding_cap_bps: i64,
        funding_sample_qty: u64,
        funding_sma_window: u8,
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
        self.interest_rate_bps = interest_rate_bps;
        self.deviation_cap_bps = deviation_cap_bps;
        self.funding_cap_bps = funding_cap_bps;
        self.funding_sample_qty = funding_sample_qty;
        self.funding_sma_window = funding_sma_window;
        self.premium_sample_count = 0;
        self._pad_funding = [0; 6];
        self.premium_samples = [0; 16];
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
            maker_fee_bps: -2,
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
            interest_rate_bps: 1,
            deviation_cap_bps: 5,
            funding_cap_bps: 50,
            funding_sample_qty: 10_000,
            funding_sma_window: 8,
            premium_sample_count: 0,
            _pad_funding: [0; 6],
            premium_samples: [0; 16],
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
            -2,
            10,
            Pubkey::default(),
            100,
            1_000,
            150,
            0,
            1,        // interest_rate_bps
            5,        // deviation_cap_bps
            50,       // funding_cap_bps
            10_000,   // funding_sample_qty
            8,        // funding_sma_window
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
        assert_eq!(inst.maker_fee_bps, -2);
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
        assert_eq!(inst.interest_rate_bps, 1);
        assert_eq!(inst.deviation_cap_bps, 5);
        assert_eq!(inst.funding_cap_bps, 50);
        assert_eq!(inst.funding_sample_qty, 10_000);
        assert_eq!(inst.funding_sma_window, 8);
        assert_eq!(inst.premium_sample_count, 0);
        assert_eq!(inst.premium_samples, [0i64; 16]);
        assert_eq!(inst.last_funding_slot, 0);
        assert_eq!(inst.cum_funding, 0);
        assert_eq!(inst.funding_interval_slots, 100);
    }
}
