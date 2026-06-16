/// Order side
#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
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

/// Order type (aligned with design L319-327, mirrored from perps-matcher)
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

#[cfg(test)]
mod tests {
    use super::*;

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
