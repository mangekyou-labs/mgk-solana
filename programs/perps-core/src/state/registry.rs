use pinocchio::pubkey::Pubkey;

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
    pub _padding: [u8; 5],
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
        self._padding = [0; 5];
    }

    pub fn deposit_amount(&self) -> u64 {
        let deposit = self.base_deposit as u128;
        let multiplier = self.volatility_multiplier as u128;
        ((deposit * multiplier) / 10_000) as u64
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
            _padding: [0; 5],
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
}
