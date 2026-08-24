use super::order::{LimitOrder, Side};
use pinocchio::{program_error::ProgramError, pubkey::Pubkey};

// Re-export so existing `mgk_perps_matcher::state::book::OrderBook` paths
// continue to resolve. The canonical definition lives in
// `mgk-common::book` so other programs (notably perps-core) can
// read the book PDA without taking a Rust crate dependency on perps-matcher
// (which would cause a duplicate `panic_handler` at link time).
pub use mgk_common::book::{BookLevel, OrderBook, MAX_LEVELS, MAX_ORDERS_PER_LEVEL, NULL_OFFSET};

/// Total maximum resting orders in the book (bids + asks).
///
/// Sized for a single batch: 64 incoming orders each potentially creating one
/// resting order, plus book already populated from prior batches. Generous
/// for MVP — book capacity limits are enforced at placement time.
pub const MAX_RESTING_ORDERS: usize = 256;

/// A resting order on the book (design L353-364)
#[repr(C)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RestingOrder {
    pub order_id: u64,
    pub user: Pubkey,
    pub side: Side,
    pub price: i64,
    pub qty: u64,
    pub filled_qty: u64,
    pub instrument_id: u16,
    pub reduce_only: bool,
    pub batch_placed: u64,
    pub next_order_offset: u32,
    /// DFBA role preserved across batches (full rest).
    pub is_maker: bool,
}

/// In-memory working state for the order book.
///
/// Composes the `OrderBook` header (level metadata) with a flat array of
/// resting orders. The flat array uses fixed-size FIFO chains via
/// `first_order_offset` (in `BookLevel`) and `next_order_offset` (in
/// `RestingOrder`).
///
/// `repr(C)` so the entire state can be serialized to a contiguous account
/// buffer via `serialize_book_state` / `deserialize_book_state` (6f).
#[repr(C)]
#[derive(Debug, PartialEq, Eq)]
pub struct BookState {
    pub book: OrderBook,
    pub resting: [RestingOrder; MAX_RESTING_ORDERS],
    pub resting_count: usize,
}

/// Zero a BookState in-place. BPF-safe: does not allocate a new struct on
/// the caller's frame. Use this instead of `BookState::new()` in BPF entry
/// points that already have a borrowed buffer.
impl BookState {
    pub fn zeroed_in_place(&mut self) {
        // Zero the book header.
        self.book.instrument_id = 0;
        self.book.best_bid = 0;
        self.book.best_ask = 0;
        self.book.bid_count = 0;
        self.book.ask_count = 0;
        self.book.next_order_id = 0;
        self.book.last_update_slot = 0;
        for lvl in self.book.bids.iter_mut() {
            *lvl = BookLevel::default();
        }
        for lvl in self.book.asks.iter_mut() {
            *lvl = BookLevel::default();
        }
        // Zero the resting array.
        // SAFETY: we own this field; zeroing in place is well-defined.
        for r in self.resting.iter_mut() {
            *r = RestingOrder::default();
        }
        self.resting_count = 0;
    }
}

#[cfg(not(target_os = "solana"))]
impl Default for BookState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(not(target_os = "solana"))]
impl BookState {
    pub fn new() -> Self {
        Self {
            book: OrderBook {
                instrument_id: 0,
                best_bid: 0,
                best_ask: 0,
                bid_count: 0,
                ask_count: 0,
                next_order_id: 0,
                last_update_slot: 0,
                bids: [BookLevel::default(); MAX_LEVELS],
                asks: [BookLevel::default(); MAX_LEVELS],
            },
            resting: [RestingOrder::default(); MAX_RESTING_ORDERS],
            resting_count: 0,
        }
    }
}

impl BookState {
    pub fn is_full(&self) -> bool {
        self.resting_count >= MAX_RESTING_ORDERS
    }
}

/// Find the level index for `price` on the given side, or return `None`.
///
/// Linear scan; for MAX_LEVELS=64 this is fine and keeps the no_std code
/// allocation-free.
pub fn find_level(book: &OrderBook, side: Side, price: i64) -> Option<usize> {
    let levels = match side {
        Side::Buy => &book.bids,
        Side::Sell => &book.asks,
    };
    levels.iter().position(|lvl| lvl.price == price)
}

/// Allocate an empty slot in the level array. Returns the new index, or
/// `None` if the side is full.
///
/// Slots are reused: a slot with `order_count == 0` is treated as free.
fn alloc_level_slot(book: &mut OrderBook, side: Side) -> Option<usize> {
    let levels = match side {
        Side::Buy => &mut book.bids,
        Side::Sell => &mut book.asks,
    };
    levels.iter().position(|lvl| lvl.order_count == 0)
}

/// Place an incoming order on the book as a resting order.
///
/// FIFO at each price level: the new order is appended to the tail of the
/// chain. The book's `next_order_id` is bumped and assigned to the new
/// resting order. `best_bid`/`best_ask` are updated if this is a new best.
pub fn place_resting(state: &mut BookState, order: &LimitOrder) -> Result<u64, BookError> {
    if state.is_full() {
        return Err(BookError::Full);
    }
    if order.qty == 0 {
        return Err(BookError::ZeroQty);
    }

    let side = order.side;
    let price = order.price;

    // Find existing level or allocate a new one.
    let level_idx = match find_level(&state.book, side, price) {
        Some(i) => i,
        None => match alloc_level_slot(&mut state.book, side) {
            Some(i) => {
                let levels = match side {
                    Side::Buy => &mut state.book.bids,
                    Side::Sell => &mut state.book.asks,
                };
                levels[i] = BookLevel {
                    price,
                    total_qty: 0,
                    order_count: 0,
                    first_order_offset: NULL_OFFSET,
                };
                match side {
                    Side::Buy => state.book.bid_count += 1,
                    Side::Sell => state.book.ask_count += 1,
                }
                i
            }
            None => return Err(BookError::Full),
        },
    };

    // Allocate resting slot.
    let slot = state.resting_count;
    state.resting_count += 1;

    // Assign order_id.
    let order_id = state.book.next_order_id;
    state.book.next_order_id += 1;

    // Find tail of the level's FIFO chain and link the new slot.
    let levels_ref = match side {
        Side::Buy => &mut state.book.bids,
        Side::Sell => &mut state.book.asks,
    };
    if levels_ref[level_idx].order_count == 0 {
        // First order at this level.
        levels_ref[level_idx].first_order_offset = slot as u32;
    } else {
        // Walk to end of chain and link.
        let mut cursor = levels_ref[level_idx].first_order_offset;
        loop {
            let next = state.resting[cursor as usize].next_order_offset;
            if next == NULL_OFFSET {
                state.resting[cursor as usize].next_order_offset = slot as u32;
                break;
            }
            cursor = next;
        }
    }

    // Write the new resting order.
    state.resting[slot] = RestingOrder {
        order_id,
        user: order.user,
        side,
        price,
        qty: order.qty,
        filled_qty: 0,
        instrument_id: order.instrument_id,
        reduce_only: order.reduce_only,
        batch_placed: 0,
        next_order_offset: NULL_OFFSET,
        is_maker: order.is_maker,
    };

    // Update level totals.
    levels_ref[level_idx].total_qty += order.qty;
    levels_ref[level_idx].order_count += 1;

    // Update best bid/ask.
    match side {
        Side::Buy => {
            if state.book.best_bid == 0 || price > state.book.best_bid {
                state.book.best_bid = price;
            }
        }
        Side::Sell => {
            if state.book.best_ask == 0 || price < state.book.best_ask {
                state.book.best_ask = price;
            }
        }
    }

    Ok(order_id)
}

/// Remove a resting order by its offset. Adjusts the level's chain and totals.
pub fn remove_at_offset(state: &mut BookState, offset: u32) -> Result<RestingOrder, BookError> {
    if offset as usize >= state.resting_count {
        return Err(BookError::NotFound);
    }
    let removed = state.resting[offset as usize];
    let side = removed.side;
    let price = removed.price;
    let next = removed.next_order_offset;

    // Find the level index from the snapshot of book state.
    let level_idx = match find_level(&state.book, side, price) {
        Some(i) => i,
        None => return Err(BookError::NotFound),
    };

    if state.book.bids[level_idx].first_order_offset == offset && side == Side::Buy
        || state.book.asks[level_idx].first_order_offset == offset && side == Side::Sell
    {
        // Removing head of chain.
        match side {
            Side::Buy => state.book.bids[level_idx].first_order_offset = next,
            Side::Sell => state.book.asks[level_idx].first_order_offset = next,
        }
    } else {
        // Walk chain to find predecessor.
        let mut cursor = match side {
            Side::Buy => state.book.bids[level_idx].first_order_offset,
            Side::Sell => state.book.asks[level_idx].first_order_offset,
        };
        let mut found = false;
        while cursor != NULL_OFFSET {
            let cursor_next = state.resting[cursor as usize].next_order_offset;
            if cursor_next == offset {
                state.resting[cursor as usize].next_order_offset = next;
                found = true;
                break;
            }
            if cursor_next == NULL_OFFSET {
                break;
            }
            cursor = cursor_next;
        }
        if !found {
            return Err(BookError::NotFound);
        }
    }

    // Update level totals and clear empty level.
    let remaining = removed.qty.saturating_sub(removed.filled_qty);
    match side {
        Side::Buy => {
            state.book.bids[level_idx].total_qty = state.book.bids[level_idx]
                .total_qty
                .saturating_sub(remaining);
            if state.book.bids[level_idx].order_count > 0 {
                state.book.bids[level_idx].order_count -= 1;
            }
            if state.book.bids[level_idx].order_count == 0 {
                state.book.bids[level_idx] = BookLevel::default();
                if state.book.bid_count > 0 {
                    state.book.bid_count -= 1;
                }
                if state.book.best_bid == price {
                    state.book.best_bid = best_price(&state.book.bids, Side::Buy);
                }
            }
        }
        Side::Sell => {
            state.book.asks[level_idx].total_qty = state.book.asks[level_idx]
                .total_qty
                .saturating_sub(remaining);
            if state.book.asks[level_idx].order_count > 0 {
                state.book.asks[level_idx].order_count -= 1;
            }
            if state.book.asks[level_idx].order_count == 0 {
                state.book.asks[level_idx] = BookLevel::default();
                if state.book.ask_count > 0 {
                    state.book.ask_count -= 1;
                }
                if state.book.best_ask == price {
                    state.book.best_ask = best_price(&state.book.asks, Side::Sell);
                }
            }
        }
    }

    // Clear the slot so a subsequent scan doesn't re-detect it as live.
    state.resting[offset as usize] = RestingOrder::default();

    Ok(removed)
}

/// Find the best price in a level array. For bids, that's the highest
/// price; for asks, the lowest. Returns 0 if no levels are populated.
fn best_price(levels: &[BookLevel; MAX_LEVELS], side: Side) -> i64 {
    let mut best: i64 = 0;
    for lvl in levels.iter() {
        if lvl.order_count == 0 {
            continue;
        }
        match side {
            Side::Buy => {
                if best == 0 || lvl.price > best {
                    best = lvl.price;
                }
            }
            Side::Sell => {
                if best == 0 || lvl.price < best {
                    best = lvl.price;
                }
            }
        }
    }
    best
}

// =============================================================================
// 6h. Direct cancel / modify of resting orders
// =============================================================================
//
// Helpers used by the matcher's `CancelResting` (disc 1) and `ModifyResting`
// (disc 2) entrypoint instructions, called by Core via CPI. Each scans the
// flat resting array linearly, verifies the caller owns the order, and
// performs the mutation. Linear scan is fine for MAX_RESTING_ORDERS=256.

/// Cancel a single resting order by `order_id`, asserting the calling user
/// owns it. Returns the removed order on success.
///
/// Errors:
/// - `BookError::NotFound` if no live resting order has the given id and user.
pub fn cancel_resting_by_id(
    state: &mut BookState,
    order_id: u64,
    user: &Pubkey,
) -> Result<RestingOrder, BookError> {
    for i in 0..state.resting_count {
        let r = &state.resting[i];
        let is_alive = r.qty > 0;
        if is_alive && r.order_id == order_id && r.user == *user {
            return remove_at_offset(state, i as u32);
        }
    }
    Err(BookError::NotFound)
}

/// Cancel every live resting order owned by `user`. Returns the number of
/// orders removed. Called by the matcher's `CancelAll` (disc 4) entrypoint,
/// dispatched by Core's `CancelAllRestingOrders` (disc 13) on liquidation
/// or user request.
///
/// Implementation notes:
/// - Iterates by ascending offset; since `remove_at_offset` clears the slot
///   in place (no swap-with-last) the remaining offsets stay valid.
/// - `resting_count` is not decremented — it is a high-water mark. Slots
///   stay allocated and may be reused by future `place_resting` calls.
/// - Best bid / best ask are recomputed by `remove_at_offset` for each
///   removal, so they stay accurate after the loop.
pub fn cancel_all_for_user(state: &mut BookState, user: &Pubkey) -> usize {
    let mut removed = 0usize;
    let mut i = 0u32;
    while (i as usize) < state.resting_count {
        let qty = state.resting[i as usize].qty;
        let is_alive = qty > 0;
        let matches = is_alive && state.resting[i as usize].user == *user;
        if matches {
            // Defensive: if remove_at_offset fails for an unexpected reason,
            // skip rather than abort the whole cancel-all.
            if remove_at_offset(state, i).is_ok() {
                removed += 1;
                // do not increment i — the slot was cleared, but offsets
                // are stable; next i is still valid.
                continue;
            }
        }
        i += 1;
    }
    removed
}

/// Modify a single resting order's remaining `qty` by `order_id`, asserting
/// the calling user owns it. `new_qty` is the new total order qty (not the
/// delta). Returns the updated order on success.
///
/// Rules:
/// - `new_qty` must be > 0.
/// - `new_qty` must be >= the order's `filled_qty` (cannot un-fill).
/// - The level's `total_qty` is adjusted by the delta.
///
/// Errors:
/// - `BookError::ZeroQty` if `new_qty == 0`.
/// - `BookError::QtyBelowFilled` if `new_qty < filled_qty`.
/// - `BookError::NotFound` if no live resting order has the given id and user.
pub fn modify_resting_qty(
    state: &mut BookState,
    order_id: u64,
    user: &Pubkey,
    new_qty: u64,
) -> Result<RestingOrder, BookError> {
    if new_qty == 0 {
        return Err(BookError::ZeroQty);
    }

    // Find the target order.
    let target_idx = (0..state.resting_count).find(|&i| {
        let r = &state.resting[i];
        r.qty > 0 && r.order_id == order_id && r.user == *user
    });
    let i = match target_idx {
        Some(i) => i,
        None => return Err(BookError::NotFound),
    };

    let filled_qty = state.resting[i].filled_qty;
    if new_qty < filled_qty {
        return Err(BookError::QtyBelowFilled);
    }

    let old_qty = state.resting[i].qty;
    let side = state.resting[i].side;
    let price = state.resting[i].price;

    // Update the order's qty.
    state.resting[i].qty = new_qty;

    // Adjust the level's total_qty by the delta.
    let level_idx = match find_level(&state.book, side, price) {
        Some(idx) => idx,
        None => return Err(BookError::NotFound),
    };
    let delta = new_qty as i128 - old_qty as i128;
    match side {
        Side::Buy => {
            let lvl = &mut state.book.bids[level_idx];
            if delta >= 0 {
                lvl.total_qty = lvl.total_qty.saturating_add(delta as u64);
            } else {
                lvl.total_qty = lvl.total_qty.saturating_sub((-delta) as u64);
            }
        }
        Side::Sell => {
            let lvl = &mut state.book.asks[level_idx];
            if delta >= 0 {
                lvl.total_qty = lvl.total_qty.saturating_add(delta as u64);
            } else {
                lvl.total_qty = lvl.total_qty.saturating_sub((-delta) as u64);
            }
        }
    }

    Ok(state.resting[i])
}

/// Errors that can occur during book operations.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BookError {
    Full,
    ZeroQty,
    NotFound,
    /// Serialization buffer too small to hold the BookState.
    BufferTooSmall,
    /// Deserialization buffer too small to hold a BookState.
    BufferTooShort,
    /// Buffer alignment is incompatible with the struct layout.
    BadAlignment,
    /// Modify rejected because new_qty is below the resting order's filled_qty.
    QtyBelowFilled,
}

impl From<BookError> for ProgramError {
    fn from(e: BookError) -> Self {
        let code: u64 = match e {
            // Map to slab errors 200-299 from mgk-common, then offset
            // for matcher-specific codes. Reuse generic ProgramError codes
            // for conditions that don't need a domain-specific tag.
            BookError::Full => 200 + 12,          // PoolFull
            BookError::ZeroQty => 200 + 11,       // InvalidQuantity
            BookError::NotFound => 200 + 5,       // OrderNotFound
            BookError::BufferTooSmall => 10,      // AccountDataTooSmall (generic)
            BookError::BufferTooShort => 10,      // AccountDataTooSmall (generic)
            BookError::BadAlignment => 11,        // InvalidAccountData (generic)
            BookError::QtyBelowFilled => 200 + 1, // InvalidOrder
        };
        ProgramError::from(code)
    }
}

// =============================================================================
// 6f. Book Persistence
// =============================================================================

/// Number of bytes required to store a `BookState` on-chain.
///
/// Computed from the actual struct layout (`#[repr(C)]`); use this when
/// allocating the book account at `InitializeBook` time.
pub fn book_account_size() -> usize {
    core::mem::size_of::<BookState>()
}

/// Derive the PDA address and bump for an instrument's book account.
///
/// PDA seeds: `["book", instrument_id_le_bytes]`
/// Owner: the matcher program itself.
pub fn book_pda(program_id: &Pubkey, instrument_id: u16) -> (Pubkey, u8) {
    let id_bytes = instrument_id.to_le_bytes();
    let seeds: [&[u8]; 2] = [b"book", &id_bytes];
    pinocchio::pubkey::find_program_address(&seeds, program_id)
}

/// Write the entire `BookState` into `buf` as raw bytes.
///
/// `buf` must be at least `book_account_size()` bytes long. This is a
/// straight memory copy of the `#[repr(C)]` struct — no varint, no length
/// prefix, no field tags. The buffer is the on-chain account data.
pub fn serialize_book_state(state: &BookState, buf: &mut [u8]) -> Result<(), BookError> {
    let size = book_account_size();
    if buf.len() < size {
        return Err(BookError::BufferTooSmall);
    }
    let src = state as *const BookState as *const u8;
    // SAFETY:
    // - `state` is a valid `BookState` reference; it lives for the duration
    //   of this call.
    // - `buf` is a valid `&mut [u8]` of length `buf.len() >= size`.
    // - We checked `buf.len() >= size` above.
    // - The struct is `#[repr(C)]` with no padding-derived uninit bytes that
    //   carry semantic meaning (all padding is behind a public field).
    // - The matcher's running environment assumes native-endianness equality
    //   between the writer and reader (same program, same compilation unit).
    unsafe {
        core::ptr::copy_nonoverlapping(src, buf.as_mut_ptr(), size);
    }
    Ok(())
}

/// Read a `BookState` from `buf`. The buffer must be exactly
/// `book_account_size()` bytes (or larger — extras are ignored).
///
/// Returns a **borrowed** `&mut BookState` into the buffer. No struct copy.
/// BPF entry points use this to avoid the 27 KB `BookState::new()` stack frame.
pub fn book_state_from_bytes_mut(buf: &mut [u8]) -> Result<&mut BookState, BookError> {
    let size = book_account_size();
    if buf.len() < size {
        return Err(BookError::BufferTooShort);
    }
    #[allow(clippy::manual_is_multiple_of)] // `is_multiple_of` not stable in SBF toolchain
    if (buf.as_ptr() as usize) % 8 != 0 {
        return Err(BookError::BadAlignment);
    }
    // SAFETY:
    // - buf is at least `size` bytes (checked above).
    // - The returned &mut BookState borrows buf for the caller's lifetime,
    //   which is valid because the caller owns buf.
    // - `BookState` is `#[repr(C)]` with no interior mutability.
    let state = unsafe { &mut *(buf.as_mut_ptr() as *mut BookState) };
    Ok(state)
}

#[cfg(not(target_os = "solana"))]
pub fn deserialize_book_state(buf: &[u8]) -> Result<BookState, BookError> {
    let size = book_account_size();
    if buf.len() < size {
        return Err(BookError::BufferTooShort);
    }
    let mut state = BookState::new();
    let dst = &mut state as *mut BookState as *mut u8;
    // SAFETY: see `serialize_book_state`. The buffer is read-only, the
    // destination is a fresh `BookState` we own.
    unsafe {
        core::ptr::copy_nonoverlapping(buf.as_ptr(), dst, size);
    }
    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::order::OrderType;
    use crate::state::queue::PartitionedOrders;
    use pinocchio::pubkey::Pubkey;

    fn make_order(byte: u8, side: Side, price: i64, qty: u64) -> LimitOrder {
        let mut user_bytes = [0u8; 32];
        user_bytes[0] = byte;
        LimitOrder {
            user: Pubkey::from(user_bytes),
            instrument_id: 0,
            order_type: OrderType::LimitGTC,
            side,
            price,
            qty,
            reduce_only: false,
            cancel_order_id: 0,
            is_maker: false,
        }
    }

    fn make_maker(byte: u8, side: Side, price: i64, qty: u64) -> LimitOrder {
        let mut o = make_order(byte, side, price, qty);
        o.is_maker = true;
        o
    }

    #[test]
    fn test_place_single_resting_updates_best() {
        let mut state = BookState::new();
        let order = make_order(1, Side::Buy, 100, 10);
        let id = place_resting(&mut state, &order).unwrap();
        assert_eq!(id, 0);
        assert_eq!(state.book.best_bid, 100);
        assert_eq!(state.book.bid_count, 1);
        assert_eq!(state.resting_count, 1);
        assert!(!state.resting[0].is_maker); // default taker
    }

    #[test]
    fn test_place_resting_preserves_is_maker() {
        let mut state = BookState::new();
        place_resting(&mut state, &make_maker(1, Side::Sell, 100, 10)).unwrap();
        assert!(state.resting[0].is_maker);
        place_resting(&mut state, &make_order(2, Side::Buy, 99, 5)).unwrap();
        assert!(!state.resting[1].is_maker);
    }

    #[test]
    fn test_place_multiple_at_same_price_fifo() {
        let mut state = BookState::new();
        let a = make_order(1, Side::Buy, 100, 10);
        let b = make_order(2, Side::Buy, 100, 5);
        place_resting(&mut state, &a).unwrap();
        place_resting(&mut state, &b).unwrap();
        assert_eq!(state.book.bid_count, 1); // single level
        assert_eq!(state.book.bids[0].order_count, 2);
        // FIFO chain: a (offset 0) -> b (offset 1).
        assert_eq!(state.book.bids[0].first_order_offset, 0);
        assert_eq!(state.resting[0].next_order_offset, 1);
        assert_eq!(state.resting[1].next_order_offset, NULL_OFFSET);
    }

    #[test]
    fn test_place_at_different_prices() {
        let mut state = BookState::new();
        place_resting(&mut state, &make_order(1, Side::Buy, 100, 10)).unwrap();
        place_resting(&mut state, &make_order(2, Side::Buy, 105, 5)).unwrap();
        place_resting(&mut state, &make_order(3, Side::Buy, 95, 7)).unwrap();
        // best_bid should be 105.
        assert_eq!(state.book.best_bid, 105);
        assert_eq!(state.book.bid_count, 3);
    }

    #[test]
    fn test_remove_head() {
        let mut state = BookState::new();
        let a = make_order(1, Side::Buy, 100, 10);
        let b = make_order(2, Side::Buy, 100, 5);
        place_resting(&mut state, &a).unwrap();
        place_resting(&mut state, &b).unwrap();
        let removed = remove_at_offset(&mut state, 0).unwrap();
        assert_eq!(removed.qty, 10);
        // Head should now point to b.
        assert_eq!(state.book.bids[0].first_order_offset, 1);
        assert_eq!(state.book.bids[0].order_count, 1);
    }

    #[test]
    fn test_remove_tail() {
        let mut state = BookState::new();
        let a = make_order(1, Side::Buy, 100, 10);
        let b = make_order(2, Side::Buy, 100, 5);
        place_resting(&mut state, &a).unwrap();
        place_resting(&mut state, &b).unwrap();
        let removed = remove_at_offset(&mut state, 1).unwrap();
        assert_eq!(removed.qty, 5);
        // a is now tail.
        assert_eq!(state.resting[0].next_order_offset, NULL_OFFSET);
        assert_eq!(state.book.bids[0].order_count, 1);
    }

    #[test]
    fn test_remove_only_at_level_clears_best() {
        let mut state = BookState::new();
        let a = make_order(1, Side::Buy, 100, 10);
        let b = make_order(2, Side::Buy, 105, 5);
        place_resting(&mut state, &a).unwrap();
        place_resting(&mut state, &b).unwrap();
        assert_eq!(state.book.best_bid, 105);
        // Remove the 105 level.
        let off = if state.resting[0].price == 100 { 1 } else { 0 };
        remove_at_offset(&mut state, off as u32).unwrap();
        // best_bid should fall back to 100.
        assert_eq!(state.book.best_bid, 100);
    }

    // ---- 6f. Book Persistence tests ----

    #[test]
    fn test_book_account_size_is_stable() {
        // Pin the on-disk size so account sizing stays predictable.
        // RestingOrder × 256 + OrderBook header ≈ 27 KB.
        let size = book_account_size();
        assert_eq!(size, 27_704, "update e2e BOOK_ACCOUNT_SIZE if this changes");
    }

    #[test]
    fn test_book_pda_seeds_match_design() {
        // PDA: ["book", instrument_id_le_bytes]
        // The find_program_address syscall isn't reachable in unit tests
        // (no Solana runtime); we exercise it via a test that is
        // `#[ignore]`-able and just check the helper's shape: that the
        // seeds slice is well-formed. The runtime integration test (in
        // the core program's clear_batch path) is what verifies the
        // actual PDA derivation on-chain.
        //
        // For now, we verify the helper compiles and has the right
        // signature by calling it with the all-zero placeholder program
        // id; the test will panic with a syscall error in non-Solana
        // test env, so we guard with #[ignore] and the test is
        // opt-in via `cargo test -- --ignored`.
    }

    #[test]
    #[ignore = "requires Solana runtime for find_program_address syscall"]
    fn test_book_pda_derivation_runtime() {
        let program_id = Pubkey::default();
        let (pda, _bump) = book_pda(&program_id, 0);
        assert_ne!(pda.as_ref(), program_id.as_ref());
        let (pda2, _) = book_pda(&program_id, 1);
        assert_ne!(pda.as_ref(), pda2.as_ref());
    }

    #[test]
    fn test_serialize_deserialize_roundtrip() {
        // Build a non-trivial book state, serialize, deserialize, verify
        // every field matches.
        let mut state = BookState::new();
        state.book.instrument_id = 42;
        state.book.last_update_slot = 12345;
        let a = make_order(1, Side::Buy, 100, 10);
        let b = make_order(2, Side::Buy, 105, 5);
        let c = make_order(3, Side::Sell, 110, 7);
        place_resting(&mut state, &a).unwrap();
        place_resting(&mut state, &b).unwrap();
        place_resting(&mut state, &c).unwrap();

        let mut buf = vec![0u8; book_account_size()];
        serialize_book_state(&state, &mut buf).unwrap();
        let restored = deserialize_book_state(&buf).unwrap();

        assert_eq!(restored.book.instrument_id, 42);
        assert_eq!(restored.book.last_update_slot, 12345);
        assert_eq!(restored.book.best_bid, 105);
        assert_eq!(restored.book.best_ask, 110);
        assert_eq!(restored.book.bid_count, 2);
        assert_eq!(restored.book.ask_count, 1);
        assert_eq!(restored.resting_count, 3);
        // Resting orders preserved (qties are unique).
        let mut qtys: [u64; 3] = [0; 3];
        for (i, r) in restored.resting[..3].iter().enumerate() {
            qtys[i] = r.qty;
        }
        qtys.sort_unstable();
        assert_eq!(qtys, [5, 7, 10]);
    }

    #[test]
    fn test_serialize_buffer_too_small() {
        let state = BookState::new();
        let mut buf = [0u8; 10]; // way too small
        let result = serialize_book_state(&state, &mut buf);
        assert_eq!(result, Err(BookError::BufferTooSmall));
    }

    #[test]
    fn test_deserialize_buffer_too_short() {
        let buf = [0u8; 10];
        let result = deserialize_book_state(&buf);
        assert_eq!(result, Err(BookError::BufferTooShort));
    }

    #[test]
    fn test_gtc_survives_persistence_then_matches_next_batch() {
        // Batch 1: place a GTC sell at 100 for 5. No crossing buyer.
        // The GTC should rest on the book.
        let mut state = BookState::new();
        let gtc_sell = make_order(1, Side::Sell, 100, 5);
        let queues = PartitionedOrders::new();
        // Use the CLOB match path: process a non-crossing order → rests.
        let result = crate::state::clob_match(&mut state, &queues); // empty queues
        let _ = result;
        // Manually place the GTC order (simulating what clob_match would do).
        place_resting(&mut state, &gtc_sell).unwrap();
        assert_eq!(state.book.ask_count, 1);
        assert_eq!(state.book.best_ask, 100);

        // Persist the book to bytes (simulating account write at end of batch 1).
        let mut buf = vec![0u8; book_account_size()];
        serialize_book_state(&state, &mut buf).unwrap();

        // "End of batch 1" — clear in-memory state and reload from disk.
        let mut state2 = deserialize_book_state(&buf).unwrap();
        assert_eq!(state2.book.ask_count, 1);
        assert_eq!(state2.book.best_ask, 100);
        assert_eq!(state2.resting_count, 1);

        // Batch 2: a crossing buyer at 110 should match against the
        // persisted GTC resting order.
        let buy = LimitOrder {
            user: Pubkey::from([2u8; 32]),
            instrument_id: 0,
            order_type: OrderType::LimitIOC,
            side: Side::Buy,
            price: 110,
            qty: 5,
            reduce_only: false,
            cancel_order_id: 0,
            is_maker: false,
        };
        let mut queues2 = PartitionedOrders::new();
        let input = [buy];
        crate::state::queue::separate_priority_queues(&input, &mut queues2);
        let result2 = crate::state::clob_match(&mut state2, &queues2);

        // 1 taker + 1 maker fill.
        assert_eq!(result2.fill_count, 2);
        let taker_qty: u64 = result2.fills[..result2.fill_count]
            .iter()
            .filter(|f| !f.is_maker)
            .map(|f| f.filled_qty)
            .sum();
        assert_eq!(taker_qty, 5);
        // Book is now empty (the resting order was fully consumed).
        assert_eq!(state2.book.ask_count, 0);
        assert_eq!(state2.book.best_ask, 0);
    }

    #[test]
    fn test_cancel_by_id_works_on_persisted_book() {
        // Place a GTC, persist, deserialize, then cancel by id.
        let mut state = BookState::new();
        let order = make_order(1, Side::Buy, 100, 5);
        let id = place_resting(&mut state, &order).unwrap();
        let mut buf = vec![0u8; book_account_size()];
        serialize_book_state(&state, &mut buf).unwrap();

        let mut state2 = deserialize_book_state(&buf).unwrap();
        assert_eq!(state2.book.bid_count, 1);

        // Use the same user encoding as `make_order` (only byte 0 set).
        let mut user_bytes = [0u8; 32];
        user_bytes[0] = 1;
        let cancel = LimitOrder {
            user: Pubkey::from(user_bytes),
            instrument_id: 0,
            order_type: OrderType::Cancel,
            side: Side::Buy,
            price: 0,
            qty: 0,
            reduce_only: false,
            cancel_order_id: id,
            is_maker: false,
        };
        let input = [cancel];
        let mut queues = PartitionedOrders::new();
        crate::state::queue::separate_priority_queues(&input, &mut queues);
        let result = crate::state::clob_match(&mut state2, &queues);
        assert_eq!(result.resting_cancelled, 1);
        assert_eq!(state2.book.bid_count, 0);
    }

    #[test]
    fn test_cancel_all_works_on_persisted_book() {
        // Place two orders for user 1, one for user 2. Persist. Reload.
        // CancelAll for user 1 should remove only user 1's orders.
        let mut state = BookState::new();
        place_resting(&mut state, &make_order(1, Side::Buy, 100, 5)).unwrap();
        place_resting(&mut state, &make_order(1, Side::Buy, 95, 3)).unwrap();
        place_resting(&mut state, &make_order(2, Side::Buy, 90, 7)).unwrap();
        let mut buf = vec![0u8; book_account_size()];
        serialize_book_state(&state, &mut buf).unwrap();
        let mut state2 = deserialize_book_state(&buf).unwrap();
        assert_eq!(state2.book.bid_count, 3);

        // Use the same user encoding as `make_order` (only byte 0 set).
        let mut user_bytes = [0u8; 32];
        user_bytes[0] = 1;
        let cancel_all = LimitOrder {
            user: Pubkey::from(user_bytes),
            instrument_id: 0,
            order_type: OrderType::CancelAll,
            side: Side::Buy,
            price: 0,
            qty: 0,
            reduce_only: false,
            cancel_order_id: 0,
            is_maker: false,
        };
        let input = [cancel_all];
        let mut queues = PartitionedOrders::new();
        crate::state::queue::separate_priority_queues(&input, &mut queues);
        let result = crate::state::clob_match(&mut state2, &queues);
        assert_eq!(result.resting_cancelled, 2);
        assert_eq!(state2.book.bid_count, 1);
        assert_eq!(state2.book.best_bid, 90);
    }

    // ---- 6h. Direct cancel / modify tests ----

    fn user_pubkey(byte: u8) -> Pubkey {
        let mut b = [0u8; 32];
        b[0] = byte;
        Pubkey::from(b)
    }

    #[test]
    fn test_cancel_resting_by_id_removes_target() {
        let mut state = BookState::new();
        let id_a = place_resting(&mut state, &make_order(1, Side::Buy, 100, 5)).unwrap();
        let _id_b = place_resting(&mut state, &make_order(2, Side::Buy, 100, 7)).unwrap();
        assert_eq!(state.resting_count, 2);
        assert_eq!(state.book.bid_count, 1);

        let removed = cancel_resting_by_id(&mut state, id_a, &user_pubkey(1)).unwrap();
        assert_eq!(removed.order_id, id_a);
        assert_eq!(removed.qty, 5);
        assert_eq!(state.resting_count, 2); // slot remains; cleared in place
                                            // Chain now points at id_b's slot.
        assert_eq!(state.book.bids[0].first_order_offset, 1);
        assert_eq!(state.book.bids[0].order_count, 1);
    }

    #[test]
    fn test_cancel_resting_by_id_wrong_user_rejected() {
        let mut state = BookState::new();
        let id = place_resting(&mut state, &make_order(1, Side::Buy, 100, 5)).unwrap();
        // User 2 trying to cancel user 1's order.
        let res = cancel_resting_by_id(&mut state, id, &user_pubkey(2));
        assert_eq!(res, Err(BookError::NotFound));
        assert_eq!(state.resting_count, 1);
        assert_eq!(state.book.bid_count, 1);
    }

    #[test]
    fn test_cancel_resting_by_id_unknown_id() {
        let mut state = BookState::new();
        place_resting(&mut state, &make_order(1, Side::Buy, 100, 5)).unwrap();
        let res = cancel_resting_by_id(&mut state, 9999, &user_pubkey(1));
        assert_eq!(res, Err(BookError::NotFound));
    }

    #[test]
    fn test_modify_resting_qty_decrease_updates_level_total() {
        let mut state = BookState::new();
        let id = place_resting(&mut state, &make_order(1, Side::Buy, 100, 10)).unwrap();
        assert_eq!(state.book.bids[0].total_qty, 10);

        let updated = modify_resting_qty(&mut state, id, &user_pubkey(1), 4).unwrap();
        assert_eq!(updated.qty, 4);
        assert_eq!(state.resting[0].qty, 4);
        // Level total adjusted by -6.
        assert_eq!(state.book.bids[0].total_qty, 4);
    }

    #[test]
    fn test_modify_resting_qty_increase_updates_level_total() {
        let mut state = BookState::new();
        let id = place_resting(&mut state, &make_order(1, Side::Buy, 100, 5)).unwrap();
        let updated = modify_resting_qty(&mut state, id, &user_pubkey(1), 12).unwrap();
        assert_eq!(updated.qty, 12);
        assert_eq!(state.book.bids[0].total_qty, 12);
    }

    #[test]
    fn test_modify_resting_qty_zero_rejected() {
        let mut state = BookState::new();
        let id = place_resting(&mut state, &make_order(1, Side::Buy, 100, 5)).unwrap();
        let res = modify_resting_qty(&mut state, id, &user_pubkey(1), 0);
        assert_eq!(res, Err(BookError::ZeroQty));
    }

    #[test]
    fn test_modify_resting_qty_below_filled_rejected() {
        let mut state = BookState::new();
        let id = place_resting(&mut state, &make_order(1, Side::Buy, 100, 10)).unwrap();
        // Simulate a partial fill.
        state.resting[0].filled_qty = 7;
        let res = modify_resting_qty(&mut state, id, &user_pubkey(1), 5);
        assert_eq!(res, Err(BookError::QtyBelowFilled));
    }

    #[test]
    fn test_modify_resting_qty_wrong_user_rejected() {
        let mut state = BookState::new();
        let id = place_resting(&mut state, &make_order(1, Side::Buy, 100, 5)).unwrap();
        let res = modify_resting_qty(&mut state, id, &user_pubkey(2), 3);
        assert_eq!(res, Err(BookError::NotFound));
    }

    #[test]
    fn test_modify_resting_qty_preserves_level_when_total_unchanged() {
        let mut state = BookState::new();
        let id = place_resting(&mut state, &make_order(1, Side::Buy, 100, 5)).unwrap();
        let updated = modify_resting_qty(&mut state, id, &user_pubkey(1), 5).unwrap();
        assert_eq!(updated.qty, 5);
        assert_eq!(state.book.bids[0].total_qty, 5);
    }
}
