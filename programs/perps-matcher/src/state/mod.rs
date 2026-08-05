pub mod book;
pub mod clearing;
pub mod clob;
pub mod dfba;
pub mod order;
pub mod queue;
pub mod shuffle;
pub use book::*;
pub use clearing::*;
pub use clob::*;
// Named DFBA exports — rename into-fns so they do not collide with legacy clearing.
pub use dfba::{
    AllocScratch, AllocationResult, AuctionKind, AuctionResult, DFBA_MAX_ORDERS, DFBA_SCRATCH_MAX,
    DfbaOrder, DualAuctionResult, DualClearScratch, FLAT_ORDER_BYTES, OrderFill, REGION_COUNT,
    REGION_MAKER_BUY, REGION_MAKER_SELL, REGION_TAKER_BUY, REGION_TAKER_SELL,
    compute_allocation_into as dfba_allocate_into,
    compute_clearing_into as dfba_clear_into, pack_orders, region_offset, run_dual_dfba_into,
    scratch_bytes_for_cap, select_by_price_priority,
};
#[cfg(not(target_os = "solana"))]
pub use dfba::{
    compute_allocation as dfba_allocate, compute_clearing as compute_dfba_clearing, run_dual_dfba,
};
pub use order::*;
pub use queue::*;
pub use shuffle::*;
