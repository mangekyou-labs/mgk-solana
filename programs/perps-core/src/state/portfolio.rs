use pinocchio::pubkey::Pubkey;

pub const MAX_POSITIONS: usize = 32;
pub const MAX_INSTRUMENTS: usize = 32;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct Portfolio {
    pub user: Pubkey,
    pub equity: i128,
    pub principal: i128,
    pub pnl: i128,
    pub im: u128,
    pub mm: u128,
    pub free_collateral: i128,
    pub health: i128,
    pub positions_len: u16,
    pub positions: [Position; MAX_POSITIONS],
    pub last_funding_checkpoint: [i128; MAX_INSTRUMENTS],
    pub last_batch_id: u64,
    pub last_slot: u64,
    pub bump: u8,
    pub _padding: [u8; 7],
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct Position {
    pub instrument_id: u16,
    pub qty: i64,
    pub entry_vwap: i64,
}

impl Portfolio {
    pub fn initialize_in_place(&mut self, user: Pubkey, bump: u8) {
        self.user = user;
        self.equity = 0;
        self.principal = 0;
        self.pnl = 0;
        self.im = 0;
        self.mm = 0;
        self.free_collateral = 0;
        self.health = 0;
        self.positions_len = 0;
        self.positions = [Position::default(); MAX_POSITIONS];
        self.last_funding_checkpoint = [0; MAX_INSTRUMENTS];
        self.last_batch_id = 0;
        self.last_slot = 0;
        self.bump = bump;
        self._padding = [0; 7];
    }

    pub fn recalc_margin(&mut self) {
        self.free_collateral = self.equity - self.im as i128;
        self.health = self.equity - self.mm as i128;
    }

    /// Returns `true` if the portfolio is underwater (`health < 0`) and
    /// should be liquidated. M7 7.6 (decision D2): after all fills in a
    /// batch are applied, `SettleBatch` calls this to flag eligible
    /// portfolios for the keeper; the actual liquidation is a separate
    /// `LiquidateUser` transaction (which already enforces `health >= 0`).
    pub fn needs_liquidation(&self) -> bool {
        self.health < 0
    }

    pub fn find_position(&self, instrument_id: u16) -> Option<(usize, &Position)> {
        for i in 0..self.positions_len as usize {
            if self.positions[i].instrument_id == instrument_id {
                return Some((i, &self.positions[i]));
            }
        }
        None
    }

    pub fn find_position_mut(&mut self, instrument_id: u16) -> Option<(usize, &mut Position)> {
        for i in 0..self.positions_len as usize {
            if self.positions[i].instrument_id == instrument_id {
                return Some((i, &mut self.positions[i]));
            }
        }
        None
    }

    #[cfg(test)]
    pub fn new(user: Pubkey) -> Self {
        let mut p = Self {
            user,
            equity: 0,
            principal: 0,
            pnl: 0,
            im: 0,
            mm: 0,
            free_collateral: 0,
            health: 0,
            positions_len: 0,
            positions: [Position::default(); MAX_POSITIONS],
            last_funding_checkpoint: [0; MAX_INSTRUMENTS],
            last_batch_id: 0,
            last_slot: 0,
            bump: 0,
            _padding: [0; 7],
        };
        p.recalc_margin();
        p
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_portfolio_new() {
        let user = Pubkey::default();
        let p = Portfolio::new(user);
        assert_eq!(p.user, user);
        assert_eq!(p.equity, 0);
        assert_eq!(p.free_collateral, 0);
    }

    #[test]
    fn test_recalc_margin() {
        let mut p = Portfolio::new(Pubkey::default());
        p.equity = 1000;
        p.im = 100;
        p.mm = 50;
        p.recalc_margin();
        assert_eq!(p.free_collateral, 900);
        assert_eq!(p.health, 950);
    }

    #[test]
    fn test_needs_liquidation_healthy_portfolio() {
        let mut p = Portfolio::new(Pubkey::default());
        p.equity = 1000;
        p.mm = 50;
        p.recalc_margin();
        assert_eq!(p.health, 950);
        assert!(!p.needs_liquidation());
    }

    #[test]
    fn test_needs_liquidation_underwater_portfolio() {
        // M7 7.6 (D2): post-hoc check. equity < mm → health < 0 → liquidate.
        let mut p = Portfolio::new(Pubkey::default());
        p.equity = 40;
        p.mm = 50;
        p.recalc_margin();
        assert_eq!(p.health, -10);
        assert!(p.needs_liquidation());
    }

    #[test]
    fn test_needs_liquidation_at_boundary() {
        // health == 0 is the boundary: still NOT eligible for liquidation
        // (LiquidateUser rejects health >= 0). M7 7.6 uses strict `< 0`.
        let mut p = Portfolio::new(Pubkey::default());
        p.equity = 50;
        p.mm = 50;
        p.recalc_margin();
        assert_eq!(p.health, 0);
        assert!(!p.needs_liquidation());
    }

    #[test]
    fn test_find_position() {
        let mut p = Portfolio::new(Pubkey::default());
        p.positions[0] = Position {
            instrument_id: 1,
            qty: 100,
            entry_vwap: 50_000_000,
        };
        p.positions_len = 1;

        let found = p.find_position(1).unwrap();
        assert_eq!(found.1.qty, 100);

        assert!(p.find_position(2).is_none());
    }
}
