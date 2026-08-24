//! Error types

/// Program errors
#[repr(u32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MgkError {
    // Common errors (0-99)
    InvalidInstruction = 0,
    InvalidAccount = 1,
    InvalidAccountOwner = 2,
    InvalidMint = 3,
    InsufficientFunds = 4,
    Overflow = 5,
    Underflow = 6,
    Unauthorized = 7,

    // Router errors (100-199)
    InvalidSlab = 100,
    SlabNotRegistered = 101,
    SlabVersionMismatch = 102,
    CapExpired = 103,
    CapInvalidScope = 104,
    CapInsufficientRemaining = 105,
    EscrowInsufficientBalance = 106,
    PortfolioInsufficientMargin = 107,
    InvalidPortfolio = 108,
    CpiFailed = 109,
    PortfolioHealthy = 110,
    LiquidationCooldown = 111,
    InvalidAmount = 112,
    InsufficientBalance = 113,
    StalePrice = 114,
    AlreadyInitialized = 115,

    // Slab errors (200-299)
    InvalidInstrument = 200,
    InvalidOrder = 201,
    InvalidReservation = 202,
    ReservationExpired = 203,
    ReservationNotFound = 204,
    OrderNotFound = 205,
    PositionNotFound = 206,
    InsufficientLiquidity = 207,
    PriceNotAligned = 208,
    QuantityNotAligned = 209,
    InvalidPrice = 210,
    InvalidQuantity = 211,
    PoolFull = 212,
    SeqnoMismatch = 213,

    // Matching errors (300-399)
    InvalidSide = 300,
    InvalidTimeInForce = 301,
    InvalidMakerClass = 302,
    InvalidOrderState = 303,
    BookCorrupted = 304,
    ReservedQtyExceeded = 305,

    // Risk errors (400-499)
    InsufficientMargin = 400,
    BelowMaintenanceMargin = 401,
    InvalidRiskParams = 402,

    // Anti-toxicity errors (500-599)
    KillBandExceeded = 500,
    OrderFrozen = 501,
    BatchNotOpen = 502,
    InvalidCommitment = 503,
    JitPenaltyApplied = 504,
    RoundtripDetected = 505,

    // Perps-core errors (600-699) — M7 onwards
    RevealDeadlineExpired = 600,
    InstrumentMissingForLiquidation = 601,
    OperationPaused = 602,
    // DFBA-specific errors (603–609) — M9
    /// Orders exceed `max_orders_per_batch` (T9.0.3).
    DfbaCapExceeded = 603,
    /// Liquidation requires a valid dual-clear mark (T9.0.3).
    MarkInvalidForLiquidation = 604,
    /// Batch must be Settled before this operation (T9.0.3).
    BatchNotSettled = 605,
    /// T9.10.7: Reduce-only order violates position constraints.
    /// Flat position, wrong side, or qty exceeds absolute position.
    ReduceOnlyViolation = 606,
}

impl From<MgkError> for u64 {
    fn from(e: MgkError) -> u64 {
        e as u64
    }
}

impl From<MgkError> for pinocchio::program_error::ProgramError {
    fn from(e: MgkError) -> Self {
        pinocchio::program_error::ProgramError::from(e as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pin the M7.8 error variant's discriminator so a refactor that
    /// reassigns it is caught. See `state::registry` for the pause-flag
    /// pattern that produces this error.
    #[test]
    fn test_operation_paused_error_pinned_to_perps_core_range() {
        assert_eq!(MgkError::OperationPaused as u32, 602);
    }

    /// Pin the M9 DFBA error discriminators.
    #[test]
    fn test_dfba_error_codes_pinned() {
        assert_eq!(MgkError::DfbaCapExceeded as u32, 603);
        assert_eq!(MgkError::MarkInvalidForLiquidation as u32, 604);
        assert_eq!(MgkError::BatchNotSettled as u32, 605);
    }

    /// T9.10.7: Pin the ReduceOnlyViolation discriminator.
    #[test]
    fn test_reduce_only_violation_pinned() {
        assert_eq!(MgkError::ReduceOnlyViolation as u32, 606);
    }
}
