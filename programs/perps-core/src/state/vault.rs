
#[repr(C)]
#[derive(Clone, Copy)]
pub struct Vault {
    pub balance: u64,
    pub insurance_fund: u128,
    pub uncovered_bad_debt: u128,
    pub bump: u8,
    pub _padding: [u8; 7],
}

impl Vault {
    pub fn initialize_in_place(&mut self, bump: u8) {
        self.balance = 0;
        self.insurance_fund = 0;
        self.uncovered_bad_debt = 0;
        self.bump = bump;
        self._padding = [0; 7];
    }

    #[cfg(test)]
    pub fn new() -> Self {
        let mut v = Self {
            balance: 0,
            insurance_fund: 0,
            uncovered_bad_debt: 0,
            bump: 0,
            _padding: [0; 7],
        };
        v.initialize_in_place(0);
        v
    }
}

#[cfg(test)]
impl Default for Vault {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_vault_new() {
        let v = Vault::new();
        assert_eq!(v.balance, 0);
        assert_eq!(v.bump, 0);
    }

    #[test]
    fn test_vault_initialize() {
        let mut v = Vault {
            balance: u64::MAX,
            insurance_fund: u128::MAX,
            uncovered_bad_debt: u128::MAX,
            bump: 255,
            _padding: [0; 7],
        };
        v.initialize_in_place(42);
        assert_eq!(v.balance, 0);
        assert_eq!(v.bump, 42);
    }
}
