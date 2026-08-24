use pinocchio::pubkey::Pubkey;

/// M7 7.8: bit positions for `Registry::pause_flags`.
///
/// | Bit  | Name                  | Effect                                                |
/// |------|-----------------------|-------------------------------------------------------|
/// | 0    | `trading_paused`      | Blocks `CommitOrder`, `RevealOrder`                   |
/// | 1    | `withdrawals_paused`  | Blocks `Withdraw` (deposits stay open — user safety)  |
/// | 2    | `liquidations_paused` | Blocks `LiquidateUser`                                |
/// | 3    | `funding_paused`      | Skips funding accrual step in `SettleBatch`           |
/// | 4    | `posts_paused`        | Blocks `PostOrder` (DFBA order posts)                 |
/// | 5    | `clears_paused`       | Blocks `CloseCollecting` + `ClearBatch`               |
/// | 6..7 | reserved              | Set to 0; future use                                  |
pub const PAUSE_TRADING: u8 = 1 << 0;
pub const PAUSE_WITHDRAWALS: u8 = 1 << 1;
pub const PAUSE_LIQUIDATIONS: u8 = 1 << 2;
pub const PAUSE_FUNDING: u8 = 1 << 3;
pub const PAUSE_POST: u8 = 1 << 4;
pub const PAUSE_CLEAR: u8 = 1 << 5;
pub const PAUSE_RESERVED_MASK: u8 = 0b_1100_0000; // bits 6..7 must be 0

#[repr(C, packed)]
#[derive(Clone, Copy)]
pub struct Registry {
    pub governance: Pubkey,         // offset 0 (32 bytes)
    pub instrument_count: u16,      // offset 32 (2 bytes)
    pub volatility_multiplier: u16, // offset 34 (2 bytes)
    pub batch_id_counter: u64,      // offset 36 (8 bytes)
    pub base_deposit: u64,          // offset 44 (8 bytes)
    pub n_min: u32,                 // offset 52 (4 bytes)
    pub t_min_slots: u64,           // offset 56 (8 bytes)
    pub t_max_slots: u64,           // offset 64 (8 bytes)
    pub t_reveal_slots: u64,        // offset 72 (8 bytes)
    pub bump: u8,                   // offset 80 (1 byte)
    pub pause_flags: u8,            // offset 81 (1 byte)
    /// Max orders per DFBA batch (design D2). Default 64; governance can
    /// adjust up to DFBA_SCRATCH_MAX (128). Stored as u8 to fit in
    /// Registry's existing 96-byte layout.
    pub max_orders_per_batch: u8, // offset 82 (1 byte)
    /// Marginal size cap for DFBA overflow selection (design D8). Orders
    /// at the marginal price are capped to this size for pro-rata.
    /// Stored as u8; 0 means "use max_orders_per_batch".
    pub marginal_size_cap: u8, // offset 83 (1 byte)
    pub _padding: [u8; 2],          // offset 84 (2 bytes) — total 86
}

impl Registry {
    /// Initialize in place. Struct field order: governance, instrument_count,
    /// volatility_multiplier, batch_id_counter, base_deposit, n_min, t_min_slots,
    /// t_max_slots, t_reveal_slots, bump.
    #[allow(clippy::too_many_arguments)]
    pub fn initialize_in_place(
        &mut self,
        governance: Pubkey,
        instrument_count: u16,
        volatility_multiplier: u16,
        base_deposit: u64,
        n_min: u32,
        t_min_slots: u64,
        t_max_slots: u64,
        t_reveal_slots: u64,
        bump: u8,
    ) {
        self.governance = governance;
        self.instrument_count = instrument_count;
        self.volatility_multiplier = volatility_multiplier;
        self.batch_id_counter = 0;
        self.base_deposit = base_deposit;
        self.n_min = n_min;
        self.t_min_slots = t_min_slots;
        self.t_max_slots = t_max_slots;
        self.t_reveal_slots = t_reveal_slots;
        self.bump = bump;
        self.pause_flags = 0;
        self.max_orders_per_batch = 64; // DFBA_MAX_ORDERS default
        self.marginal_size_cap = 64; // same as max_orders default
        self._padding = [0; 2];
    }

    pub fn deposit_amount(&self) -> u64 {
        let deposit = self.base_deposit as u128;
        let multiplier = self.volatility_multiplier as u128;
        ((deposit * multiplier) / 10_000) as u64
    }

    /// True if the `trading_paused` bit is set in `pause_flags`.
    #[inline]
    pub fn is_trading_paused(&self) -> bool {
        self.pause_flags & PAUSE_TRADING != 0
    }

    /// True if the `withdrawals_paused` bit is set in `pause_flags`.
    #[inline]
    pub fn is_withdrawals_paused(&self) -> bool {
        self.pause_flags & PAUSE_WITHDRAWALS != 0
    }

    /// True if the `liquidations_paused` bit is set in `pause_flags`.
    #[inline]
    pub fn is_liquidations_paused(&self) -> bool {
        self.pause_flags & PAUSE_LIQUIDATIONS != 0
    }

    /// True if the `funding_paused` bit is set in `pause_flags`.
    #[inline]
    pub fn is_funding_paused(&self) -> bool {
        self.pause_flags & PAUSE_FUNDING != 0
    }

    /// True if the `posts_paused` bit is set in `pause_flags`.
    /// When set, `PostOrder` (DFBA order posts) is blocked.
    #[inline]
    pub fn is_posts_paused(&self) -> bool {
        self.pause_flags & PAUSE_POST != 0
    }

    /// True if the `clears_paused` bit is set in `pause_flags`.
    /// When set, `CloseCollecting` and `ClearBatch` are blocked.
    #[inline]
    pub fn is_clears_paused(&self) -> bool {
        self.pause_flags & PAUSE_CLEAR != 0
    }

    /// Write a new `pause_flags` value. Reserved bits 6..7 are masked off
    /// so a malformed instruction cannot set future flags. Governance-only;
    /// the caller is responsible for the authority check.
    #[inline]
    pub fn set_pause_flags(&mut self, flags: u8) {
        self.pause_flags = flags & !PAUSE_RESERVED_MASK;
    }

    #[cfg(test)]
    pub fn new(governance: Pubkey) -> Self {
        let mut r = Self {
            governance,
            instrument_count: 0,
            volatility_multiplier: 10_000,
            batch_id_counter: 0,
            base_deposit: 10_000_000,
            n_min: 5,
            t_min_slots: 10,
            t_max_slots: 150,
            t_reveal_slots: 25,
            bump: 0,
            pause_flags: 0,
            max_orders_per_batch: 64,
            marginal_size_cap: 64,
            _padding: [0; 2],
        };
        r.initialize_in_place(governance, 0, 10_000, 10_000_000, 5, 10, 150, 25, 0);
        r
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_registry_new() {
        let gov = Pubkey::from([1u8; 32]);
        let r = Registry::new(gov);
        let instrument_count = r.instrument_count;
        let base_deposit = r.base_deposit;
        let n_min = r.n_min;
        assert_eq!(r.governance, gov);
        assert_eq!(instrument_count, 0);
        assert_eq!(base_deposit, 10_000_000);
        assert_eq!(n_min, 5);
    }

    /// M7 7.8: `Registry::new` must initialize `pause_flags` to 0.
    /// Without this, the system boots in a paused state.
    #[test]
    fn test_pause_flags_default_zero() {
        let r = Registry::new(Pubkey::from([1u8; 32]));
        assert_eq!(r.pause_flags, 0);
        assert!(!r.is_trading_paused());
        assert!(!r.is_withdrawals_paused());
        assert!(!r.is_liquidations_paused());
        assert!(!r.is_funding_paused());
        assert!(!r.is_posts_paused());
        assert!(!r.is_clears_paused());
    }

    /// M7 7.8: pin the bit positions for each pause flag. A refactor
    /// that reassigns a bit (e.g. swaps trading and withdrawals) would
    /// be caught here.
    #[test]
    fn test_pause_bit_positions_pinned() {
        assert_eq!(PAUSE_TRADING, 0b_0000_0001);
        assert_eq!(PAUSE_WITHDRAWALS, 0b_0000_0010);
        assert_eq!(PAUSE_LIQUIDATIONS, 0b_0000_0100);
        assert_eq!(PAUSE_FUNDING, 0b_0000_1000);
        assert_eq!(PAUSE_POST, 0b_0001_0000);
        assert_eq!(PAUSE_CLEAR, 0b_0010_0000);
        assert_eq!(PAUSE_RESERVED_MASK, 0b_1100_0000);
    }

    /// M7 7.8: `set_pause_flags` writes the supplied value (low 6 bits).
    #[test]
    fn test_set_pause_flags_writes_value() {
        let mut r = Registry::new(Pubkey::from([2u8; 32]));
        r.set_pause_flags(PAUSE_TRADING | PAUSE_FUNDING);
        assert_eq!(r.pause_flags, 0b_0000_1001);
        assert!(r.is_trading_paused());
        assert!(r.is_funding_paused());
        assert!(!r.is_withdrawals_paused());
        assert!(!r.is_liquidations_paused());
        assert!(!r.is_posts_paused());
        assert!(!r.is_clears_paused());
    }

    /// M7 7.8: writing 0xFF must mask off the reserved high bits (6..7).
    /// Bits 4..5 (PAUSE_POST, PAUSE_CLEAR) are now valid flags.
    #[test]
    fn test_set_pause_flags_masks_reserved_bits() {
        let mut r = Registry::new(Pubkey::from([3u8; 32]));
        r.set_pause_flags(0xFF);
        assert_eq!(r.pause_flags, 0x3F);
        assert!(r.is_posts_paused());
        assert!(r.is_clears_paused());
    }

    /// M7 7.8: clearing all bits must reset to zero and the helpers
    /// must all return false.
    #[test]
    fn test_set_pause_flags_clears_round_trip() {
        let mut r = Registry::new(Pubkey::from([4u8; 32]));
        r.set_pause_flags(
            PAUSE_TRADING
                | PAUSE_WITHDRAWALS
                | PAUSE_LIQUIDATIONS
                | PAUSE_FUNDING
                | PAUSE_POST
                | PAUSE_CLEAR,
        );
        assert_eq!(r.pause_flags, 0x3F);
        r.set_pause_flags(0);
        assert_eq!(r.pause_flags, 0);
        assert!(!r.is_trading_paused());
        assert!(!r.is_withdrawals_paused());
        assert!(!r.is_liquidations_paused());
        assert!(!r.is_funding_paused());
        assert!(!r.is_posts_paused());
        assert!(!r.is_clears_paused());
    }

    /// M7 7.8: writing a single bit must not set any other bit. Pinned
    /// because the masked-write happens inside `set_pause_flags`, not
    /// in the entrypoint.
    #[test]
    fn test_set_pause_flags_each_bit_independent() {
        for (bit, expected) in [
            (PAUSE_TRADING, 0b_0000_0001),
            (PAUSE_WITHDRAWALS, 0b_0000_0010),
            (PAUSE_LIQUIDATIONS, 0b_0000_0100),
            (PAUSE_FUNDING, 0b_0000_1000),
            (PAUSE_POST, 0b_0001_0000),
            (PAUSE_CLEAR, 0b_0010_0000),
        ] {
            let mut r = Registry::new(Pubkey::from([5u8; 32]));
            r.set_pause_flags(bit);
            assert_eq!(r.pause_flags, expected, "bit {bit:#x} write");
        }
    }

    /// M7 7.8: `set_pause_flags` must not alter any other Registry
    /// field. Catches accidental field drift in future refactors.
    #[test]
    fn test_set_pause_flags_does_not_alter_other_fields() {
        let mut r = Registry::new(Pubkey::from([6u8; 32]));
        let snap_instrument_count = r.instrument_count;
        let snap_batch_id_counter = r.batch_id_counter;
        let snap_base_deposit = r.base_deposit;
        let snap_bump = r.bump;
        r.set_pause_flags(PAUSE_TRADING | PAUSE_LIQUIDATIONS);
        let instrument_count = r.instrument_count;
        let batch_id_counter = r.batch_id_counter;
        let base_deposit = r.base_deposit;
        assert_eq!(instrument_count, snap_instrument_count);
        assert_eq!(batch_id_counter, snap_batch_id_counter);
        assert_eq!(base_deposit, snap_base_deposit);
        assert_eq!(r.bump, snap_bump);
    }
}
