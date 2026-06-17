pub mod add_instrument;
pub mod cancel_resting_order;
pub mod clear_batch;
pub mod close_committing;
pub mod commit_order;
pub mod deposit;
pub mod init_portfolio;
pub mod initialize;
pub mod liquidate_user;
pub mod modify_resting_order;
pub mod reveal_order;
pub mod set_pause_flags;
pub mod settle_batch;
pub mod withdraw;

pub use add_instrument::*;
pub use cancel_resting_order::*;
pub use clear_batch::*;
pub use close_committing::*;
pub use commit_order::*;
pub use deposit::*;
pub use init_portfolio::*;
pub use initialize::*;
pub use liquidate_user::*;
pub use modify_resting_order::*;
pub use reveal_order::*;
pub use set_pause_flags::*;
pub use settle_batch::*;
pub use withdraw::*;

#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoreInstruction {
    Initialize = 0,
    InitPortfolio = 1,
    Deposit = 2,
    Withdraw = 3,
    CommitOrder = 4,
    RevealOrder = 5,
    CloseCommitting = 6,
    ClearBatch = 7,
    SettleBatch = 8,
    LiquidateUser = 9,
    AddInstrument = 10,
    CancelRestingOrder = 11,
    ModifyRestingOrder = 12,
    /// M7 7.8: governance-only pause-flag setter. Disc 14 (skips 13 to
    /// leave room for the future per-instrument `AddInstrument` variant
    /// if needed; no instruction currently uses 13).
    SetPauseFlags = 14,
}
