pub mod add_instrument;
pub mod cancel_all_resting_orders;
pub mod cancel_resting_order;
pub mod clear_batch;
pub mod close_committing;
pub mod commit_order;
pub mod create_batch;
pub mod create_portfolio;
pub mod deposit;
pub mod init_portfolio;
pub mod init_portfolio_for_user;
pub mod init_vault;
pub mod initialize;
pub mod liquidate_user;
pub mod modify_resting_order;
pub mod post_order;
pub mod reveal_order;
pub mod set_pause_flags;
pub mod settle_batch;
pub mod withdraw;

pub use add_instrument::*;
pub use cancel_all_resting_orders::*;
pub use cancel_resting_order::*;
pub use clear_batch::*;
pub use close_committing::*;
pub use commit_order::*;
pub use create_batch::*;
pub use create_portfolio::*;
pub use deposit::*;
pub use init_portfolio::*;
pub use init_portfolio_for_user::*;
pub use init_vault::*;
pub use initialize::*;
pub use liquidate_user::*;
pub use modify_resting_order::*;
pub use post_order::*;
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
    /// M7 7.7: cancel every resting order for `user` across one or more
    /// books (CPI to matcher `CancelAll` disc 4). User must sign.
    CancelAllRestingOrders = 13,
    /// M7 7.8: governance-only pause-flag setter.
    SetPauseFlags = 14,
    /// Initialize the Vault account (disc 15). Vault must be pre-created
    /// via SystemProgram.createAccount (keypair signs on Solana 4.x).
    InitVault = 15,
    /// Create the first batch in Committing state (disc 16). Used to
    /// bootstrap the batch lifecycle when batch_id_counter == 0.
    CreateBatch = 16,
    /// Reset `batch_id_counter` to 0 so CreateBatch can bootstrap the
    /// first batch. Governance-only. Needed when counter drifted after
    /// failed init runs.
    SetBatchCounter = 17,
    /// Create and initialize a Portfolio PDA for a user (disc 18).
    /// Atomic create via invoke_signed — browser wallets can call this
    /// directly without pre-creating the portfolio account.
    CreatePortfolio = 18,
    /// InitPortfolioForUser (disc 19) — keeper creates + initializes a
    /// Portfolio PDA for a user via SystemProgram.createAccount (keeper
    /// signs). Browser wallet then calls InitPortfolio (disc 1) on the
    /// pre-created account (idempotent, skips if already initialized).
    InitPortfolioForUser = 19,
    /// DFBA open post (disc 20) — single-tx place on book with maker/taker flag.
    /// Replaces CommitOrder+RevealOrder for the DFBA path.
    PostOrder = 20,
}
