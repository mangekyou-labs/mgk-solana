//! Order book data types shared between `perps-core` (mark price sweep,
//! `SettleBatch` funding premium) and `perps-matcher` (matching engine).
//!
//! These types live in `mgk-common` so the perps-core program can
//! read the order book PDA (owned by perps-matcher) without taking a Rust
//! crate dependency on perps-matcher. The crate dependency would cause
//! duplicate `panic_handler` lang items at link time, since each program
//! needs its own `#[panic_handler]` and `cargo build-sbf` compiles both
//! crates as cdylibs.
//!
//! Behaviors (place / cancel / match) live in `perps-matcher` and are
//! intentionally NOT re-exported from here.

/// Sentinel "no link" offset for end of a FIFO chain.
pub const NULL_OFFSET: u32 = u32::MAX;

/// Maximum number of price levels per side of the book.
pub const MAX_LEVELS: usize = 64;
/// Maximum resting orders at a single price level.
pub const MAX_ORDERS_PER_LEVEL: usize = 16;

/// Persistent order book header for a single instrument.
///
/// PDA: `["book", instrument_id]`. Lives in the matcher program account
/// space; perps-core reads it read-only for mark price and funding
/// premium computation.
///
/// This is the **header only** — the resting-order FIFO chains are owned
/// by perps-matcher. Callers that need to walk the resting orders must
/// go through the matcher's `place_resting` / `cancel_resting_by_id`
/// instructions, not by reading the account directly.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OrderBook {
    pub instrument_id: u16,
    pub best_bid: i64,
    pub best_ask: i64,
    pub bid_count: u32,
    pub ask_count: u32,
    pub next_order_id: u64,
    pub last_update_slot: u64,
    pub bids: [BookLevel; MAX_LEVELS],
    pub asks: [BookLevel; MAX_LEVELS],
}

/// A price level on one side of the book.
#[repr(C)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct BookLevel {
    pub price: i64,
    pub total_qty: u64,
    pub order_count: u16,
    pub first_order_offset: u32,
}

/// Size of the `OrderBook` header struct (the on-chain book account's
/// persistent part — level arrays, but **not** the in-memory resting-order
/// FIFO chains owned by the matcher).
#[inline]
pub const fn book_header_size() -> usize {
    core::mem::size_of::<OrderBook>()
}

/// Derive the PDA address for a book account.
///
/// Seeds: `["book", instrument_id_le_bytes]`. Owner: the matcher program.
/// Used by `perps-core` to verify that a `SettleBatch` caller passed the
/// real book account (not a malicious lookalike) for the given instrument.
#[inline]
pub fn book_pda(program_id: &pinocchio::pubkey::Pubkey, instrument_id: u16) -> (pinocchio::pubkey::Pubkey, u8) {
    let id_bytes = instrument_id.to_le_bytes();
    let seeds: [&[u8]; 2] = [b"book", &id_bytes];
    pinocchio::pubkey::find_program_address(&seeds, program_id)
}
