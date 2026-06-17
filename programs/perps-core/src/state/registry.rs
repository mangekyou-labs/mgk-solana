use pinocchio::pubkey::Pubkey;

/// M7 7.8: bit positions for `Registry::pause_flags`.
///
/// | Bit  | Name                  | Effect                                                |
/// |------|-----------------------|-------------------------------------------------------|
/// | 0    | `trading_paused`      | Blocks `CommitOrder`, `RevealOrder`                   |
/// | 1    | `withdrawals_paused`  | Blocks `Withdraw` (deposits stay open — user safety)  |
/// | 2    | `liquidations_paused` | Blocks `LiquidateUser`                                |
/// | 3    | `funding_paused`      | Skips funding accrual step in `SettleBatch`           |
/// | 4..7 | reserved              | Set to 0; future use                                  |
pub const PAUSE_TRADING: u8 = 1 << 0;
pub const PAUSE_WITHDRAWALS: u8 = 1 << 1;
pub const PAUSE_LIQUIDATIONS: u8 = 1 << 2;
pub const PAUSE_FUNDING: u8 = 1 << 3;
pub const PAUSE_RESERVED_MASK: u8 = 0b_1111_0000; // bits 4..7 must be 0

#[repr(C)]
#[derive(Clone, Copy)]
pub struct Registry {
    pub governance: Pubkey,
    pub instrument_count: u16,
    pub volatility_multiplier: u16,
    pub batch_id_counter: u64,
    pub base_deposit: u64,
    pub n_min: u32,
    pub t_min_slots: u64,
    pub t_max_slots: u64,
    pub t_reveal_slots: u64,
    pub bump: u8,
    pub pause_flags: u8,
    pub _padding: [u8; 4],
}

impl Registry {
    #[allow(clippy::too_many_arguments)]
    pub fn initialize_in_place(
        &mut self,
        governance: Pubkey,
        base_deposit: u64,
        n_min: u32,
        t_min_slots: u64,
        t_max_slots: u64,
        t_reveal_slots: u64,
        bump: u8,
    ) {
        self.governance = governance;
        self.instrument_count = 0;
        self.volatility_multiplier = 10_000; // 1.0x default
        self.batch_id_counter = 0;
        self.base_deposit = base_deposit;
        self.n_min = n_min;
        self.t_min_slots = t_min_slots;
        self.t_max_slots = t_max_slots;
        self.t_reveal_slots = t_reveal_slots;
        self.bump = bump;
        self.pause_flags = 0;
        self._padding = [0; 4];
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

    /// Write a new `pause_flags` value. Reserved bits 4..7 are masked off
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
            _padding: [0; 4],
        };
        r.initialize_in_place(governance, 10_000_000, 5, 10, 150, 25, 0);
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
        assert_eq!(r.governance, gov);
        assert_eq!(r.instrument_count, 0);
        assert_eq!(r.base_deposit, 10_000_000);
        assert_eq!(r.n_min, 5);
    }

    #[test]
    fn test_pause_flags_default_zero() {
        let r = Registry::new(Pubkey::from([1u8; 32]));
        assert_eq!(r.pause_flags, 0);
        assert!(!r.is_trading_paused());
        assert!(!r.is_withdrawals_paused());
        assert!(!r.is_liquidations_paused());
        assert!(!r.is_funding_paused());
    }

    #[test]
    fn test_pause_flag_bit_positions_are_stable() {
        // Pin the bit layout so a refactor that renumbers them is caught.
        assert_eq!(PAUSE_TRADING, 0b_0000_0001);
        assert_eq!(PAUSE_WITHDRAWALS, 0b_0000_0010);
        assert_eq!(PAUSE_LIQUIDATIONS, 0b_0000_0100);
        assert_eq!(PAUSE_FUNDING, 0b_0000_1000);
        assert_eq!(PAUSE_RESERVED_MASK, 0b_1111_0000);
    }

    #[test]
    fn test_set_pause_flags_writes_value() {
        let mut r = Registry::new(Pubkey::from([2u8; 32]));
        r.set_pause_flags(PAUSE_TRADING | PAUSE_WITHDRAWALS);
        assert_eq!(r.pause_flags, 0b_0000_0011);
        assert!(r.is_trading_paused());
        assert!(r.is_withdrawals_paused());
        assert!(!r.is_liquidations_paused());
        assert!(!r.is_funding_paused());
    }

    #[test]
    fn test_set_pause_flags_masks_reserved_bits() {
        // Bits 4..7 are reserved for future use and must be silently
        // dropped on write so a malformed instruction cannot enable
        // features that don't exist yet.
        let mut r = Registry::new(Pubkey::from([3u8; 32]));
        r.set_pause_flags(0xFF);
        assert_eq!(r.pause_flags, 0x0F);
    }

    #[test]
    fn test_set_pause_flags_clear_round_trip() {
        let mut r = Registry::new(Pubkey::from([4u8; 32]));
        r.set_pause_flags(PAUSE_LIQUIDATIONS);
        assert!(r.is_liquidations_paused());
        r.set_pause_flags(0);
        assert_eq!(r.pause_flags, 0);
        assert!(!r.is_liquidations_paused());
    }

    #[test]
    fn test_each_pause_bit_is_independent() {
        // Set one bit at a time and assert only that bit fires.
        for (bit, expected) in [
            (PAUSE_TRADING, "trading"),
            (PAUSE_WITHDRAWALS, "withdrawals"),
            (PAUSE_LIQUIDATIONS, "liquidations"),
            (PAUSE_FUNDING, "funding"),
        ] {
            let mut r = Registry::new(Pubkey::from([5u8; 32]));
            r.set_pause_flags(bit);
            assert_eq!(r.pause_flags, bit, "set {}", expected);
            // Count the bits that are 1 — must be exactly 1.
            assert_eq!(r.pause_flags.count_ones(), 1, "{}", expected);
        }
    }

    #[test]
    fn test_pause_flags_pin_percolator_error_variant() {
        // Pin the error variant that callers will see when a paused
        // instruction is rejected, so a refactor reassigning it would
        // be caught.
        use percolator_common::PercolatorError;
        assert_eq!(PercolatorError::OperationPaused as u32, 602);
    }
}
