use super::book::{place_resting, remove_at_offset, BookState};
use super::order::{FillReceipt, LimitOrder, OrderType, Side};
use super::queue::PartitionedOrders;
use pinocchio::pubkey::Pubkey;

/// Maximum fills that can be produced in a single batch.
///
/// Sized to comfortably hold multi-level walks for the maximum batch (64
/// incoming orders each potentially producing multiple fills).
pub const MAX_FILLS_PER_BATCH: usize = 128;

/// Context passed to the per-fill risk callback.
///
/// Provides enough information for the caller to compute the resulting
/// position notional and compare it against the instrument's IMR. The
/// caller (typically the Core program via a function pointer in the CPI
/// instruction data) maintains the user's portfolio state externally.
#[derive(Debug, Clone, Copy)]
pub struct RiskContext {
    pub user: Pubkey,
    pub instrument_id: u16,
    /// Running total of qty filled for this order so far (across all walks).
    pub cumulative_filled_qty: u64,
    /// Running total of notional (qty * price) for this order so far.
    pub cumulative_notional: u128,
    /// Qty of the just-completed fill.
    pub this_fill_qty: u64,
    /// Price of the just-completed fill (at the resting/maker price).
    pub this_fill_price: i64,
}

/// Decision returned by the risk callback after each fill.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RiskDecision {
    /// No breach; continue matching the order against more resting liquidity.
    Continue,
    /// Margin breach detected; cancel the remainder of the order.
    Cancel,
}

/// Function pointer for the per-fill risk check.
///
/// Called after every fill with a `RiskContext`. Returning `Cancel` causes
/// `walk_against_book` to stop filling the current incoming order and leave
/// the remaining qty unfilled (treated the same as IOC remainder).
pub type RiskCheckFn = fn(ctx: &RiskContext) -> RiskDecision;

/// Default risk check that never breaches. Used by `clob_match` when no
/// custom callback is provided.
pub fn default_risk_check(_ctx: &RiskContext) -> RiskDecision {
    RiskDecision::Continue
}

/// Result of running the CLOB matching algorithm on a batch.
pub struct MatchResult {
    pub fills: [FillReceipt; MAX_FILLS_PER_BATCH],
    pub fill_count: usize,
    /// Number of ALO/post-only orders rejected because they would cross the
    /// spread (returned to user, no resting).
    pub rejected_crossing: u32,
    /// Number of orders placed on the book as resting.
    pub resting_added: u32,
    /// Number of resting orders removed (cancels + self-trade cancellations).
    pub resting_cancelled: u32,
    /// Self-trade prevention cancellations (subset of resting_cancelled).
    pub self_trade_cancellations: u32,
    /// Per-fill risk callbacks that returned `Cancel`.
    pub risk_breach_cancellations: u32,
}

impl Default for MatchResult {
    fn default() -> Self {
        Self::new()
    }
}

impl MatchResult {
    pub fn new() -> Self {
        Self {
            fills: [FillReceipt::default(); MAX_FILLS_PER_BATCH],
            fill_count: 0,
            rejected_crossing: 0,
            resting_added: 0,
            resting_cancelled: 0,
            self_trade_cancellations: 0,
            risk_breach_cancellations: 0,
        }
    }
}

/// Run the CLOB matching algorithm on a partitioned batch against the book
/// with the default (always-passing) per-fill risk check.
///
/// See `clob_match_with_risk` for the full algorithm description.
pub fn clob_match(state: &mut BookState, queues: &PartitionedOrders) -> MatchResult {
    clob_match_with_risk(state, queues, default_risk_check)
}

/// Run the CLOB matching algorithm with a custom per-fill risk callback.
///
/// Order of operations (per design L158-169):
/// 1. Cancels — remove resting orders by id (Cancel) or by user (CancelAll).
/// 2. ALO / Post-only — reject if would cross spread, otherwise rest.
/// 3. Regulars (GTC, IOC, Market) — process in shuffled order, walking the
///    book for crossing orders, resting the remainder for GTC.
///
/// After every fill, `risk_check` is invoked with the running cumulative
/// fill context. If it returns `RiskDecision::Cancel`, the current order's
/// walk stops and its remaining qty is treated as unfilled (GTC may still
/// rest the remainder; IOC and Market drop it).
pub fn clob_match_with_risk(
    state: &mut BookState,
    queues: &PartitionedOrders,
    risk_check: RiskCheckFn,
) -> MatchResult {
    let mut result = MatchResult::new();

    // 1. Cancels.
    for cancel in queues.cancels() {
        process_cancel(state, cancel, &mut result);
    }

    // 2. ALO / Post-only.
    for alo in queues.alos() {
        process_alo(state, alo, &mut result);
    }

    // 3. Regulars.
    for order in queues.regulars() {
        match order.order_type {
            OrderType::LimitGTC => process_gtc(state, order, &mut result, risk_check),
            OrderType::LimitIOC => process_ioc(state, order, &mut result, risk_check),
            OrderType::Market => process_market(state, order, &mut result, risk_check),
            _ => {
                // Defensive: should not appear in the regular queue.
            }
        }
    }

    result
}

/// Cancel: remove a single resting order by id, or all resting orders for
/// the user (CancelAll).
fn process_cancel(state: &mut BookState, cancel: &LimitOrder, result: &mut MatchResult) {
    if cancel.order_type == OrderType::CancelAll {
        // Scan all resting orders, remove those owned by this user.
        // `remove_at_offset` clears the chain link but leaves a sentinel
        // shape in the slot; we detect that by checking if the slot's level
        // can still be found. To be defensive and avoid the case where a
        // slot is "removed" but not yet compacted, we check if the resting
        // order is still linked in the level chain by checking the order's
        // qty (which is zero for empty default slots).
        let mut i: u32 = 0;
        while (i as usize) < state.resting_count {
            let r = &state.resting[i as usize];
            let is_alive = r.qty > 0;
            let belongs = is_alive
                && r.user == cancel.user
                && r.instrument_id == cancel.instrument_id;
            if belongs && remove_at_offset(state, i).is_ok() {
                result.resting_cancelled += 1;
            }
            i += 1;
        }
    } else {
        // Cancel by id: linear scan.
        for i in 0..state.resting_count {
            if state.resting[i].order_id == cancel.cancel_order_id
                && state.resting[i].user == cancel.user
            {
                if remove_at_offset(state, i as u32).is_ok() {
                    result.resting_cancelled += 1;
                }
                return;
            }
        }
    }
}

/// ALO / Post-only: reject if the order would cross the spread, otherwise
/// rest on the book.
fn process_alo(state: &mut BookState, alo: &LimitOrder, result: &mut MatchResult) {
    if would_cross_spread(state, alo) {
        result.rejected_crossing += 1;
        return;
    }
    if place_resting(state, alo).is_ok() {
        result.resting_added += 1;
    }
}

/// LimitGTC: if aggressive, walk the book and rest the unfilled remainder.
fn process_gtc(
    state: &mut BookState,
    order: &LimitOrder,
    result: &mut MatchResult,
    risk_check: RiskCheckFn,
) {
    let remaining = walk_against_book(state, order, result, risk_check);
    if remaining > 0 && !state.is_full() {
        // Rest the unfilled portion at the order's limit price.
        let mut rest = *order;
        rest.qty = remaining;
        if place_resting(state, &rest).is_ok() {
            result.resting_added += 1;
        }
    }
}

/// LimitIOC: walk the book; whatever doesn't fill is cancelled (not rested).
fn process_ioc(
    state: &mut BookState,
    order: &LimitOrder,
    result: &mut MatchResult,
    risk_check: RiskCheckFn,
) {
    let _ = walk_against_book(state, order, result, risk_check);
}

/// Market: walk the book with no price limit. Anything not filled remains
/// un-rested (market orders don't rest).
fn process_market(
    state: &mut BookState,
    order: &LimitOrder,
    result: &mut MatchResult,
    risk_check: RiskCheckFn,
) {
    let _ = walk_against_book(state, order, result, risk_check);
}

/// Returns true if `order` would cross the spread when placed on the book.
fn would_cross_spread(state: &BookState, order: &LimitOrder) -> bool {
    match order.side {
        Side::Buy => {
            // Buy crosses if its price >= best ask.
            state.book.best_ask != 0 && order.price >= state.book.best_ask
        }
        Side::Sell => {
            // Sell crosses if its price <= best bid.
            state.book.best_bid != 0 && order.price <= state.book.best_bid
        }
    }
}

/// Walk the book, matching `order` against resting liquidity. Returns the
/// unfilled remainder.
///
/// Buy orders walk the asks from best_ask upward, stopping when no ask
/// crosses the limit. Sell orders walk the bids from best_bid downward.
/// Each fill is at the resting (maker) order's price.
///
/// After every fill, `risk_check` is invoked. If it returns
/// `RiskDecision::Cancel`, the walk stops and the unfilled remainder is
/// returned (caller decides whether to rest, e.g. for GTC).
fn walk_against_book(
    state: &mut BookState,
    order: &LimitOrder,
    result: &mut MatchResult,
    risk_check: RiskCheckFn,
) -> u64 {
    let mut remaining = order.qty;
    if remaining == 0 {
        return 0;
    }
    let limit = order.price;

    // For Market orders, treat limit as +∞ (Buy) or -∞ (Sell) so any
    // available liquidity is matched.
    let limit = match order.order_type {
        OrderType::Market => match order.side {
            Side::Buy => i64::MAX,
            Side::Sell => i64::MIN,
        },
        _ => limit,
    };

    while remaining > 0 {
        // Find the next price level to match against.
        let (level_idx, level_price) = match order.side {
            Side::Buy => match next_ask_level(state, limit) {
                Some((i, p)) => (i, p),
                None => break,
            },
            Side::Sell => match next_bid_level(state, limit) {
                Some((i, p)) => (i, p),
                None => break,
            },
        };

        // Walk resting orders at this level (FIFO via the chain).
        let first_offset = match order.side {
            Side::Buy => state.book.asks[level_idx].first_order_offset,
            Side::Sell => state.book.bids[level_idx].first_order_offset,
        };
        if first_offset == super::book::NULL_OFFSET {
            break;
        }

        // Iterate the chain. We need to be careful with mutation during
        // iteration: if a resting order is fully filled, we remove it. We
        // use a cursor that follows `next_order_offset` directly.
        let mut cursor = first_offset;
        let mut prev: u32 = super::book::NULL_OFFSET;
        while cursor != super::book::NULL_OFFSET && remaining > 0 {
            let next = state.resting[cursor as usize].next_order_offset;
            let resting_qty_remaining =
                state.resting[cursor as usize].qty - state.resting[cursor as usize].filled_qty;

            if resting_qty_remaining == 0 {
                // Already fully filled (shouldn't normally happen, but
                // defensive — clean up).
                if remove_at_offset(state, cursor).is_ok() {
                    result.resting_cancelled += 1;
                }
                // After removal, prev is still valid; cursor is invalidated
                // by the chain rewrite. Bail to outer re-scan.
                break;
            }

            // Self-trade prevention: cancel resting if same user.
            if state.resting[cursor as usize].user == order.user {
                if remove_at_offset(state, cursor).is_ok() {
                    result.resting_cancelled += 1;
                    result.self_trade_cancellations += 1;
                }
                // Continue from the next slot, since `cursor` was removed.
                if prev == super::book::NULL_OFFSET {
                    // Head was removed; first_order_offset now points to next.
                    cursor = match order.side {
                        Side::Buy => state.book.asks[level_idx].first_order_offset,
                        Side::Sell => state.book.bids[level_idx].first_order_offset,
                    };
                } else {
                    cursor = next;
                }
                continue;
            }

            // Match the smaller of remaining vs resting_qty_remaining.
            let fill_qty = remaining.min(resting_qty_remaining);
            // Fill at the resting (maker) order's price.
            let fill_price = level_price;

            // Update resting order's filled_qty.
            state.resting[cursor as usize].filled_qty += fill_qty;
            // Update level total_qty.
            match order.side {
                Side::Buy => state.book.asks[level_idx].total_qty -= fill_qty,
                Side::Sell => state.book.bids[level_idx].total_qty -= fill_qty,
            }
            remaining -= fill_qty;

            // Emit taker fill.
            if result.fill_count < MAX_FILLS_PER_BATCH {
                let idx = result.fill_count;
                result.fills[idx] = make_fill(order.user, fill_qty, fill_price, false);
                result.fill_count += 1;
            }
            // Emit maker fill.
            if result.fill_count < MAX_FILLS_PER_BATCH {
                let idx = result.fill_count;
                let maker_user = state.resting[cursor as usize].user;
                result.fills[idx] = make_fill(maker_user, fill_qty, fill_price, true);
                result.fill_count += 1;
            }

            // Per-fill risk check: if the resulting position would breach
            // margin, cancel the remainder of the order.
            let cumulative_filled_qty = order.qty - remaining;
            let cumulative_notional =
                (cumulative_filled_qty as u128) * (fill_price.unsigned_abs() as u128);
            let ctx = RiskContext {
                user: order.user,
                instrument_id: order.instrument_id,
                cumulative_filled_qty,
                cumulative_notional,
                this_fill_qty: fill_qty,
                this_fill_price: fill_price,
            };
            if risk_check(&ctx) == RiskDecision::Cancel {
                result.risk_breach_cancellations += 1;
                return remaining;
            }

            // If resting order is fully filled, remove it.
            if state.resting[cursor as usize].filled_qty == state.resting[cursor as usize].qty {
                if remove_at_offset(state, cursor).is_ok() {
                    result.resting_cancelled += 1;
                }
                // After removal, the chain has shifted. If prev was the
                // head, the new first_order_offset is the new head. If
                // prev was a middle node, its next has been updated.
                if prev == super::book::NULL_OFFSET {
                    cursor = match order.side {
                        Side::Buy => state.book.asks[level_idx].first_order_offset,
                        Side::Sell => state.book.bids[level_idx].first_order_offset,
                    };
                } else {
                    cursor = next;
                }
                continue;
            }

            prev = cursor;
            cursor = next;
        }
    }

    remaining
}

/// Find the next ask level with price <= limit. Returns (level_index, price).
fn next_ask_level(state: &BookState, limit: i64) -> Option<(usize, i64)> {
    let mut best_idx: Option<usize> = None;
    let mut best_price: i64 = i64::MAX;
    for (i, lvl) in state.book.asks.iter().enumerate() {
        if lvl.order_count == 0 {
            continue;
        }
        if lvl.price <= limit && lvl.price < best_price {
            best_price = lvl.price;
            best_idx = Some(i);
        }
    }
    best_idx.map(|i| (i, best_price))
}

/// Find the next bid level with price >= limit. Returns (level_index, price).
fn next_bid_level(state: &BookState, limit: i64) -> Option<(usize, i64)> {
    let mut best_idx: Option<usize> = None;
    let mut best_price: i64 = i64::MIN;
    for (i, lvl) in state.book.bids.iter().enumerate() {
        if lvl.order_count == 0 {
            continue;
        }
        if lvl.price >= limit && lvl.price > best_price {
            best_price = lvl.price;
            best_idx = Some(i);
        }
    }
    best_idx.map(|i| (i, best_price))
}

/// Build a `FillReceipt` with notional = qty * price / 1_000_000 (consistent
/// with the existing clearing path's notional convention).
fn make_fill(user: Pubkey, qty: u64, price: i64, is_maker: bool) -> FillReceipt {
    FillReceipt {
        user,
        filled_qty: qty,
        notional: (qty as u128 * price.unsigned_abs() as u128 / 1_000_000) as u64,
        is_maker,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::order::OrderType;

    fn make_order(byte: u8, side: Side, price: i64, qty: u64, order_type: OrderType) -> LimitOrder {
        let mut user_bytes = [0u8; 32];
        user_bytes[0] = byte;
        LimitOrder {
            user: Pubkey::from(user_bytes),
            instrument_id: 0,
            order_type,
            side,
            price,
            qty,
            reduce_only: false,
            cancel_order_id: 0,
        }
    }

    fn seed_book_with_ask(byte: u8, price: i64, qty: u64) -> BookState {
        let mut state = BookState::new();
        place_resting(&mut state, &make_order(byte, Side::Sell, price, qty, OrderType::LimitGTC))
            .unwrap();
        state
    }

    fn partition_with(orders: &[LimitOrder]) -> PartitionedOrders {
        let mut out = PartitionedOrders::new();
        super::super::queue::separate_priority_queues(orders, &mut out);
        out
    }

    #[test]
    fn test_crossing_buy_fills_against_resting_ask() {
        // Resting ask at 100 for 5. Buy at 110 for 5 — should fill at 100 (maker price).
        let mut state = seed_book_with_ask(1, 100, 5);
        let buy = make_order(2, Side::Buy, 110, 5, OrderType::LimitIOC);
        let queues = partition_with(&[buy]);
        let result = clob_match(&mut state, &queues);

        assert_eq!(result.fill_count, 2); // taker + maker
        let taker = &result.fills[0];
        let maker = &result.fills[1];
        assert_eq!(taker.user.as_ref()[0], 2);
        assert_eq!(taker.filled_qty, 5);
        assert!(!taker.is_maker);
        assert_eq!(maker.user.as_ref()[0], 1);
        assert_eq!(maker.filled_qty, 5);
        assert!(maker.is_maker);
        // Notional at 100: 5 * 100 / 1_000_000 = 0 (integer div).
        assert_eq!(taker.notional, 0);
    }

    #[test]
    fn test_non_crossing_limit_rests_on_book() {
        // Resting ask at 100. Buy at 95 — should rest on bid side at 95.
        let mut state = seed_book_with_ask(1, 100, 5);
        let buy = make_order(2, Side::Buy, 95, 3, OrderType::LimitGTC);
        let queues = partition_with(&[buy]);
        let result = clob_match(&mut state, &queues);

        assert_eq!(result.fill_count, 0);
        assert_eq!(result.resting_added, 1);
        assert_eq!(state.book.best_bid, 95);
        assert_eq!(state.book.bid_count, 1);
    }

    #[test]
    fn test_alo_rejected_when_crossing() {
        // Resting ask at 100. ALO buy at 110 — should be rejected (would cross).
        let mut state = seed_book_with_ask(1, 100, 5);
        let alo = make_order(2, Side::Buy, 110, 3, OrderType::LimitALO);
        let queues = partition_with(&[alo]);
        let result = clob_match(&mut state, &queues);

        assert_eq!(result.rejected_crossing, 1);
        assert_eq!(result.resting_added, 0);
        assert_eq!(result.fill_count, 0);
    }

    #[test]
    fn test_alo_rests_when_not_crossing() {
        // Resting ask at 100. ALO buy at 95 — should rest on book.
        let mut state = seed_book_with_ask(1, 100, 5);
        let alo = make_order(2, Side::Buy, 95, 3, OrderType::LimitALO);
        let queues = partition_with(&[alo]);
        let result = clob_match(&mut state, &queues);

        assert_eq!(result.rejected_crossing, 0);
        assert_eq!(result.resting_added, 1);
        assert_eq!(state.book.best_bid, 95);
    }

    #[test]
    fn test_ioc_partial_fill_cancels_remainder() {
        // Resting ask at 100 for 3. IOC buy at 110 for 10 — fills 3, remainder 7 cancelled.
        let mut state = seed_book_with_ask(1, 100, 3);
        let buy = make_order(2, Side::Buy, 110, 10, OrderType::LimitIOC);
        let queues = partition_with(&[buy]);
        let result = clob_match(&mut state, &queues);

        assert_eq!(result.fill_count, 2); // 1 taker + 1 maker
        assert_eq!(result.fills[0].filled_qty, 3);
        // IOC does not rest the remainder.
        assert_eq!(state.book.bid_count, 0);
        assert_eq!(state.book.best_bid, 0);
    }

    #[test]
    fn test_self_trade_prevention_cancels_maker() {
        // Resting ask at 100 from user 1. Same user (1) submits IOC buy at 110.
        // Self-trade prevention: cancel the resting order instead of matching.
        let mut state = seed_book_with_ask(1, 100, 5);
        let buy = make_order(1, Side::Buy, 110, 5, OrderType::LimitIOC);
        let queues = partition_with(&[buy]);
        let result = clob_match(&mut state, &queues);

        assert_eq!(result.self_trade_cancellations, 1);
        assert_eq!(result.fill_count, 0);
        // Resting order was removed; book is empty.
        assert_eq!(state.book.ask_count, 0);
        assert_eq!(state.book.best_ask, 0);
    }

    #[test]
    fn test_multi_level_walk() {
        // Two asks: 100 for 3, 105 for 4. Buy at 110 for 6 — should walk both levels.
        let mut state = BookState::new();
        place_resting(
            &mut state,
            &make_order(1, Side::Sell, 100, 3, OrderType::LimitGTC),
        )
        .unwrap();
        place_resting(
            &mut state,
            &make_order(2, Side::Sell, 105, 4, OrderType::LimitGTC),
        )
        .unwrap();
        let buy = make_order(3, Side::Buy, 110, 6, OrderType::LimitIOC);
        let queues = partition_with(&[buy]);
        let result = clob_match(&mut state, &queues);

        // 2 levels * 2 fills (taker + maker) = 4 fills.
        assert_eq!(result.fill_count, 4);
        // First level (100): 3 qty. Second level (105): 3 qty (limited by buy's remaining).
        let mut total_taker_qty = 0u64;
        for fill in &result.fills[..result.fill_count] {
            if !fill.is_maker {
                total_taker_qty += fill.filled_qty;
            }
        }
        assert_eq!(total_taker_qty, 6);
        // First level fully consumed, second still has 1 qty remaining.
        assert_eq!(state.book.ask_count, 1);
        assert_eq!(state.book.asks[1].total_qty, 1);
    }

    #[test]
    fn test_gtc_partial_fill_then_rests() {
        // Resting ask at 100 for 3. GTC buy at 110 for 10 — fills 3, rests 7 at 110.
        let mut state = seed_book_with_ask(1, 100, 3);
        let buy = make_order(2, Side::Buy, 110, 10, OrderType::LimitGTC);
        let queues = partition_with(&[buy]);
        let result = clob_match(&mut state, &queues);

        assert_eq!(result.fill_count, 2);
        assert_eq!(result.fills[0].filled_qty, 3);
        assert_eq!(result.resting_added, 1);
        // Resting portion should be on the book at 110.
        assert_eq!(state.book.best_bid, 110);
    }

    #[test]
    fn test_market_walks_all_levels() {
        // Two asks: 100 for 3, 105 for 4. Market buy for 5 — should fill 3 + 2.
        let mut state = BookState::new();
        place_resting(
            &mut state,
            &make_order(1, Side::Sell, 100, 3, OrderType::LimitGTC),
        )
        .unwrap();
        place_resting(
            &mut state,
            &make_order(2, Side::Sell, 105, 4, OrderType::LimitGTC),
        )
        .unwrap();
        let buy = make_order(3, Side::Buy, 0, 5, OrderType::Market);
        let queues = partition_with(&[buy]);
        let result = clob_match(&mut state, &queues);

        let mut total_taker = 0u64;
        for fill in &result.fills[..result.fill_count] {
            if !fill.is_maker {
                total_taker += fill.filled_qty;
            }
        }
        assert_eq!(total_taker, 5);
    }

    #[test]
    fn test_cancel_by_id_removes_resting() {
        // Place a GTC order, get its id, then cancel it.
        let mut state = BookState::new();
        let placed = make_order(1, Side::Buy, 100, 5, OrderType::LimitGTC);
        let id = place_resting(&mut state, &placed).unwrap();
        assert_eq!(state.book.bid_count, 1);

        let mut cancel = make_order(1, Side::Buy, 0, 0, OrderType::Cancel);
        cancel.cancel_order_id = id;
        let queues = partition_with(&[cancel]);
        let result = clob_match(&mut state, &queues);

        assert_eq!(result.resting_cancelled, 1);
        assert_eq!(state.book.bid_count, 0);
    }

    #[test]
    fn test_cancel_all_removes_user_resting() {
        // Place two resting orders for user 1, one for user 2.
        let mut state = BookState::new();
        place_resting(
            &mut state,
            &make_order(1, Side::Buy, 100, 5, OrderType::LimitGTC),
        )
        .unwrap();
        place_resting(
            &mut state,
            &make_order(1, Side::Buy, 95, 3, OrderType::LimitGTC),
        )
        .unwrap();
        place_resting(
            &mut state,
            &make_order(2, Side::Buy, 90, 7, OrderType::LimitGTC),
        )
        .unwrap();
        assert_eq!(state.book.bid_count, 3);

        let cancel_all = make_order(1, Side::Buy, 0, 0, OrderType::CancelAll);
        let queues = partition_with(&[cancel_all]);
        let result = clob_match(&mut state, &queues);

        assert_eq!(result.resting_cancelled, 2);
        assert_eq!(state.book.bid_count, 1);
        // User 2's order at 90 should remain.
        assert_eq!(state.book.best_bid, 90);
    }

    /// Test-only risk callback. Reads the breach cap from a shared static
    /// atomic that each test sets via `risk_breach_after(cap)`. Production
    /// would pass the user's portfolio context through the CPI instruction
    /// data instead.
    use core::sync::atomic::{AtomicU64, Ordering};
    static RISK_CAP: AtomicU64 = AtomicU64::new(u64::MAX);

    fn risk_breach_after(cap: u64) -> RiskCheckFn {
        RISK_CAP.store(cap, Ordering::SeqCst);
        risk_breach_callback
    }

    fn risk_breach_callback(ctx: &RiskContext) -> RiskDecision {
        let cap = RISK_CAP.load(Ordering::SeqCst);
        if ctx.cumulative_notional > cap as u128 {
            RiskDecision::Cancel
        } else {
            RiskDecision::Continue
        }
    }

    #[test]
    fn test_risk_breach_cancels_remainder() {
        // Two asks at the same price: total 10 qty. Buyer wants 10.
        // Risk callback breaches when cumulative notional > 499. After the
        // first fill (5 qty @ 100 = 500 notional), 500 > 499, so the
        // remainder (5) is cancelled.
        let mut state = BookState::new();
        place_resting(
            &mut state,
            &make_order(1, Side::Sell, 100, 5, OrderType::LimitGTC),
        )
        .unwrap();
        place_resting(
            &mut state,
            &make_order(2, Side::Sell, 100, 5, OrderType::LimitGTC),
        )
        .unwrap();
        let buy = make_order(3, Side::Buy, 100, 10, OrderType::LimitIOC);
        let queues = partition_with(&[buy]);
        let risk = risk_breach_after(499);
        let result = clob_match_with_risk(&mut state, &queues, risk);

        // 5 qty filled (taker side). One maker fill.
        let taker_qty: u64 = result.fills[..result.fill_count]
            .iter()
            .filter(|f| !f.is_maker)
            .map(|f| f.filled_qty)
            .sum();
        assert_eq!(taker_qty, 5);
        // Risk callback fired once.
        assert_eq!(result.risk_breach_cancellations, 1);
        // Second ask at the same price still has 5 qty remaining.
        assert_eq!(state.book.ask_count, 1);
        assert_eq!(state.book.asks[0].total_qty, 5);
    }

    #[test]
    fn test_risk_breach_does_not_trigger_when_under_cap() {
        // Risk cap high enough to never breach — full fill should complete.
        let mut state = seed_book_with_ask(1, 100, 5);
        let buy = make_order(2, Side::Buy, 100, 5, OrderType::LimitIOC);
        let queues = partition_with(&[buy]);
        let risk = risk_breach_after(u64::MAX);
        let result = clob_match_with_risk(&mut state, &queues, risk);

        let taker_qty: u64 = result.fills[..result.fill_count]
            .iter()
            .filter(|f| !f.is_maker)
            .map(|f| f.filled_qty)
            .sum();
        assert_eq!(taker_qty, 5);
        assert_eq!(result.risk_breach_cancellations, 0);
    }

    #[test]
    fn test_default_risk_check_always_continues() {
        let mut state = seed_book_with_ask(1, 100, 10);
        let buy = make_order(2, Side::Buy, 100, 10, OrderType::LimitIOC);
        let queues = partition_with(&[buy]);
        // clob_match uses default_risk_check — should fill completely.
        let result = clob_match(&mut state, &queues);
        assert_eq!(result.risk_breach_cancellations, 0);
        let taker_qty: u64 = result.fills[..result.fill_count]
            .iter()
            .filter(|f| !f.is_maker)
            .map(|f| f.filled_qty)
            .sum();
        assert_eq!(taker_qty, 10);
    }
}
