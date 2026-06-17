
#[repr(C)]
#[derive(Clone, Copy)]
pub struct Vault {
    pub balance: u64,
    pub insurance_fund: u128,
    pub uncovered_bad_debt: u128,
    pub adl_debt: u128,
    pub adl_pending: bool,
    pub bump: u8,
    pub _padding: [u8; 6],
}

impl Vault {
    pub fn initialize_in_place(&mut self, bump: u8) {
        self.balance = 0;
        self.insurance_fund = 0;
        self.uncovered_bad_debt = 0;
        self.adl_debt = 0;
        self.adl_pending = false;
        self.bump = bump;
        self._padding = [0; 6];
    }

    #[cfg(test)]
    pub fn new() -> Self {
        let mut v = Self {
            balance: 0,
            insurance_fund: 0,
            uncovered_bad_debt: 0,
            adl_debt: 0,
            adl_pending: false,
            bump: 0,
            _padding: [0; 6],
        };
        v.initialize_in_place(0);
        v
    }

    pub fn mark_adl_pending(&mut self, debt: u128) {
        self.adl_pending = true;
        self.adl_debt = self.adl_debt.saturating_add(debt);
    }

    pub fn clear_adl_pending(&mut self) {
        self.adl_pending = false;
        self.adl_debt = 0;
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
            adl_debt: u128::MAX,
            adl_pending: true,
            bump: 255,
            _padding: [0; 6],
        };
        v.initialize_in_place(42);
        assert_eq!(v.balance, 0);
        assert_eq!(v.adl_debt, 0);
        assert!(!v.adl_pending);
        assert_eq!(v.bump, 42);
    }

    #[test]
    fn test_mark_adl_pending_sets_flag_and_debt() {
        let mut v = Vault::new();
        v.mark_adl_pending(500);
        assert!(v.adl_pending);
        assert_eq!(v.adl_debt, 500);
    }

    #[test]
    fn test_mark_adl_pending_accumulates() {
        let mut v = Vault::new();
        v.mark_adl_pending(500);
        v.mark_adl_pending(300);
        assert!(v.adl_pending);
        assert_eq!(v.adl_debt, 800);
    }

    #[test]
    fn test_mark_adl_pending_saturates_at_overflow() {
        let mut v = Vault::new();
        v.mark_adl_pending(u128::MAX);
        v.mark_adl_pending(1);
        assert_eq!(v.adl_debt, u128::MAX);
        assert!(v.adl_pending);
    }

    #[test]
    fn test_clear_adl_pending_resets() {
        let mut v = Vault::new();
        v.mark_adl_pending(500);
        v.clear_adl_pending();
        assert!(!v.adl_pending);
        assert_eq!(v.adl_debt, 0);
    }

    #[test]
    fn test_initialize_in_place_resets_adl_fields() {
        let mut v = Vault::new();
        v.mark_adl_pending(999);
        v.initialize_in_place(7);
        assert!(!v.adl_pending);
        assert_eq!(v.adl_debt, 0);
        assert_eq!(v.bump, 7);
    }

    #[test]
    fn test_vault_size() {
        assert_eq!(core::mem::size_of::<Vault>(), 80);
    }
}
