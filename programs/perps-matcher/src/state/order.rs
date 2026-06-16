use pinocchio::pubkey::Pubkey;

/// Buy or sell side
#[repr(u8)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Side {
    #[default]
    Buy = 0,
    Sell = 1,
}

impl Side {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Side::Buy),
            1 => Some(Side::Sell),
            _ => None,
        }
    }
}

/// Order type (aligned with design L319-327)
#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrderType {
    LimitGTC = 0,
    LimitIOC = 1,
    LimitALO = 2,
    Market = 3,
    Cancel = 4,
    CancelAll = 5,
}

impl OrderType {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(OrderType::LimitGTC),
            1 => Some(OrderType::LimitIOC),
            2 => Some(OrderType::LimitALO),
            3 => Some(OrderType::Market),
            4 => Some(OrderType::Cancel),
            5 => Some(OrderType::CancelAll),
            _ => None,
        }
    }

    pub fn is_cancel(&self) -> bool {
        matches!(self, OrderType::Cancel | OrderType::CancelAll)
    }
}

/// A revealed order ready for clearing
#[derive(Debug, Clone, Copy)]
pub struct LimitOrder {
    pub user: Pubkey,
    pub instrument_id: u16,
    pub order_type: OrderType,
    pub side: Side,
    pub price: i64,
    pub qty: u64,
    pub reduce_only: bool,
    pub cancel_order_id: u64,
}

/// A fill receipt for a matched order
#[derive(Debug, Clone, Copy, Default)]
pub struct FillReceipt {
    pub user: Pubkey,
    pub filled_qty: u64,
    pub notional: u64,
    /// `true` if this fill was on the resting (maker) side, `false` for the
    /// incoming (taker) side. Set to `false` by the uniform-clearing path.
    pub is_maker: bool,
}

/// Result of clearing a batch
#[derive(Debug, Clone, Copy)]
pub struct ClearingResult {
    pub clearing_price: i64,
    pub total_filled_qty: u64,
    pub total_notional: u128,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_side_from_u8() {
        assert_eq!(Side::from_u8(0), Some(Side::Buy));
        assert_eq!(Side::from_u8(1), Some(Side::Sell));
        assert_eq!(Side::from_u8(2), None);
        assert_eq!(Side::from_u8(255), None);
    }

    #[test]
    fn test_order_type_from_u8() {
        assert_eq!(OrderType::from_u8(0), Some(OrderType::LimitGTC));
        assert_eq!(OrderType::from_u8(1), Some(OrderType::LimitIOC));
        assert_eq!(OrderType::from_u8(2), Some(OrderType::LimitALO));
        assert_eq!(OrderType::from_u8(3), Some(OrderType::Market));
        assert_eq!(OrderType::from_u8(4), Some(OrderType::Cancel));
        assert_eq!(OrderType::from_u8(5), Some(OrderType::CancelAll));
        assert_eq!(OrderType::from_u8(6), None);
        assert_eq!(OrderType::from_u8(255), None);
    }

    #[test]
    fn test_is_cancel() {
        assert!(OrderType::Cancel.is_cancel());
        assert!(OrderType::CancelAll.is_cancel());
        assert!(!OrderType::LimitGTC.is_cancel());
        assert!(!OrderType::LimitIOC.is_cancel());
        assert!(!OrderType::LimitALO.is_cancel());
        assert!(!OrderType::Market.is_cancel());
    }
}
