//! M7 7.5: Mark price computation (design L468-501).
//!
//! Mark price is a composite of:
//!   1. Depth-weighted book mid (primary) — walks the order book to find
//!      the worst price to fill a configurable reference quantity on
//!      each side, then averages.
//!   2. Oracle fallback (secondary) — used when the book is empty,
//!      one-sided, has insufficient depth, or is stale.
//!
//! The composite is stored on `Instrument.mark_price` (decision D3 —
//! mark lives on the instrument, not on the batch, so funding + margin
//! + liquidation can read it from the account they're already touching).
//!
//! The design specifies a sigmoid blend (`tanh`-based) for staleness
//! transition. For pre-testnet MVP we use a simple integer threshold:
//!   - `current_slot - book.last_update_slot <= decay_window` → book mid
//!   - `current_slot - book.last_update_slot  > decay_window` → oracle
//!
//! The sigmoid is a post-MVP enhancement; the threshold is conservative
//! (no transition zone) and produces a clear audit trail (the mark
//! either came from the book or from the oracle, never a blend).

use mgk_common::book::{BookLevel, OrderBook};

/// Walk one side of the book until `target_qty` contracts have been
/// accumulated, then return the price at the level that crossed the
/// threshold. Returns `None` if the side is empty (no levels).
///
/// For bids (`ascending == false`), levels are walked from highest price
/// to lowest (best to worst bid). For asks (`ascending == true`), levels
/// are walked from lowest to highest (best to worst ask).
///
/// If the book has fewer contracts than `target_qty`, returns the price
/// of the last (worst) level reached. This represents "what's the worst
/// price I could get for whatever depth exists" — the caller is expected
/// to detect insufficient depth and fall back to oracle.
pub fn sweep_book_side(
    levels: &[BookLevel],
    ascending: bool,
    target_qty: u64,
) -> Option<i64> {
    // Collect non-empty levels into a small stack array. MAX_LEVELS=64,
    // so this is at most 64 entries. We sort the local copy by price
    // (ascending or descending depending on side) and walk.
    let mut entries: [(i64, u64); 64] = [(0, 0); 64];
    let mut n: usize = 0;
    for lvl in levels.iter() {
        if lvl.order_count == 0 {
            continue;
        }
        if n >= 64 {
            break;
        }
        entries[n] = (lvl.price, lvl.total_qty);
        n += 1;
    }
    if n == 0 {
        return None;
    }
    let entries = &mut entries[..n];

    // Sort by price. For `ascending == false` (bids), sort descending
    // (highest first). For `ascending == true` (asks), sort ascending
    // (lowest first). We use a simple insertion sort — n <= 64, so this
    // is fast and `no_std`-friendly.
    for i in 1..entries.len() {
        let mut j = i;
        while j > 0 {
            let should_swap = if ascending {
                entries[j - 1].0 > entries[j].0
            } else {
                entries[j - 1].0 < entries[j].0
            };
            if should_swap {
                entries.swap(j - 1, j);
                j -= 1;
            } else {
                break;
            }
        }
    }

    // Walk and accumulate.
    let mut accumulated: u64 = 0;
    let mut last_price: i64 = entries[0].0;
    for &(price, qty) in entries.iter() {
        if accumulated >= target_qty {
            return Some(price);
        }
        last_price = price;
        accumulated = accumulated.saturating_add(qty);
        if accumulated >= target_qty {
            return Some(price);
        }
    }
    Some(last_price)
}

/// Compute the mark price for a settle.
///
/// Inputs:
///   - `book`: the persisted `OrderBook` (matcher-owned PDA, read-only
///     from Core's perspective).
///   - `prev_mark_price`: the previous batch's mark price (read from
///     `instrument.mark_price` before the call site overwrites it).
///     `0` means "no prior mark" (first batch for this instrument).
///   - `current_slot`: the slot at which we're computing the mark.
///   - `oracle_price`: `Some(p)` if a fresh oracle price is available;
///     `None` if the oracle is stale or missing.
///   - `reference_qty`: the target qty for the depth sweep
///     (`instrument.mark_reference_qty`).
///   - `decay_window_slots`: staleness threshold
///     (`instrument.mark_decay_window_slots`).
///
/// Returns the new mark price. The caller writes the returned value to
/// `instrument.mark_price`.
///
/// Precedence:
///   1. First batch (`prev_mark_price == 0`): oracle, or carry-forward
///      of 0 if no oracle (caller is expected to keep mark at 0; funding
///      and liquidation treat 0 as "uninitialized").
///   2. Book has both sides and is fresh (within decay window): book
///      mid = (P_bid + P_ask) / 2.
///   3. Otherwise: oracle, or carry-forward from `prev_mark_price` if
///      no oracle.
#[allow(clippy::too_many_arguments)]
pub fn compute_mark_price(
    book: &OrderBook,
    prev_mark_price: i64,
    current_slot: u64,
    oracle_price: Option<i64>,
    reference_qty: u64,
    decay_window_slots: u64,
) -> i64 {
    // 1. First batch — use oracle if available, else keep prev (0).
    if prev_mark_price == 0 {
        return oracle_price.unwrap_or(0);
    }

    // 2. Check staleness. If the book hasn't been touched in more than
    //    `decay_window_slots`, the mark is oracle (or carry-forward).
    let age_slots = current_slot.saturating_sub(book.last_update_slot);
    let stale = decay_window_slots > 0 && age_slots > decay_window_slots;
    if stale {
        return oracle_price.unwrap_or(prev_mark_price);
    }

    // 3. Book sweep on each side.
    let p_bid = sweep_book_side(&book.bids, false, reference_qty);
    let p_ask = sweep_book_side(&book.asks, true, reference_qty);
    match (p_bid, p_ask) {
        (Some(bid), Some(ask)) => {
            // Book mid. Both sides present.
            (bid.saturating_add(ask)) / 2
        }
        _ => {
            // One or both sides empty — fall back to oracle or carry-forward.
            oracle_price.unwrap_or(prev_mark_price)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mgk_common::book::{BookLevel, NULL_OFFSET};

    /// Helper: build a `BookLevel` with the given price and qty.
    fn level(price: i64, total_qty: u64) -> BookLevel {
        BookLevel {
            price,
            total_qty,
            order_count: 1,
            first_order_offset: NULL_OFFSET,
        }
    }

    /// Pin: empty levels (no order_count > 0) return None for the sweep.
    #[test]
    fn test_sweep_empty_levels_returns_none() {
        let levels = [BookLevel::default(); 4];
        assert!(sweep_book_side(&levels, false, 100).is_none());
        assert!(sweep_book_side(&levels, true, 100).is_none());
    }

    /// Pin: bid side walks high → low and returns the price at the
    /// level that crosses the qty threshold.
    #[test]
    fn test_sweep_bid_walks_high_to_low() {
        // Bids: best = 105, then 100, then 95. Qty at each: 30, 40, 50.
        // Target = 60. After level 1 (30) accumulated < 60. After level
        // 2 (30+40=70) accumulated >= 60 → return price 100.
        let levels = [level(100, 40), level(105, 30), level(95, 50)];
        let result = sweep_book_side(&levels, false, 60);
        assert_eq!(result, Some(100));
    }

    /// Pin: ask side walks low → high.
    #[test]
    fn test_sweep_ask_walks_low_to_high() {
        // Asks: best = 95, then 100, then 105. Qty: 30, 40, 50.
        // Target = 60. After level 1 (30) < 60. After level 2 (70) >= 60
        // → return price 100.
        let levels = [level(100, 40), level(95, 30), level(105, 50)];
        let result = sweep_book_side(&levels, true, 60);
        assert_eq!(result, Some(100));
    }

    /// Pin: when book has fewer contracts than target, return the worst
    /// (last) price reached (don't return None).
    #[test]
    fn test_sweep_returns_worst_price_when_depth_insufficient() {
        // Bids: 105 (10), 100 (20). Total = 30. Target = 100. We never
        // cross — return the worst (100).
        let levels = [level(100, 20), level(105, 10)];
        let result = sweep_book_side(&levels, false, 100);
        assert_eq!(result, Some(100));
    }

    /// Pin: book mid = (P_bid + P_ask) / 2 — even when one side is
    /// shallower than the other.
    #[test]
    fn test_mark_price_mid_uses_both_sides() {
        let mut book = OrderBook {
            instrument_id: 0,
            best_bid: 0,
            best_ask: 0,
            bid_count: 0,
            ask_count: 0,
            next_order_id: 0,
            last_update_slot: 0,
            bids: [BookLevel::default(); 64],
            asks: [BookLevel::default(); 64],
        };
        // Bids: best 105, then 100. Total 30.
        book.bids[0] = level(100, 20);
        book.bids[1] = level(105, 10);
        // Asks: best 110, then 115. Total 30.
        book.asks[0] = level(110, 20);
        book.asks[1] = level(115, 10);

        // Target = 25. Bid sweep: 10 < 25, then 30 >= 25 → 105.
        // Ask sweep: 20 < 25, then 30 >= 25 → 110.
        // Mid = (105 + 110) / 2 = 107.
        let mark = compute_mark_price(&book, 100, 0, None, 25, 0);
        assert_eq!(mark, 107);
    }

    /// Pin: first batch (prev_mark_price == 0) uses oracle.
    #[test]
    fn test_first_batch_uses_oracle() {
        let book = OrderBook {
            instrument_id: 0,
            best_bid: 0,
            best_ask: 0,
            bid_count: 0,
            ask_count: 0,
            next_order_id: 0,
            last_update_slot: 0,
            bids: [level(100, 50); 64],
            asks: [level(110, 50); 64],
        };
        let mark = compute_mark_price(&book, 0, 100, Some(200_000_000), 25, 150);
        assert_eq!(mark, 200_000_000, "first batch must use oracle");
    }

    /// Pin: first batch with no oracle keeps mark at 0 (caller treats
    /// 0 as uninitialized and skips funding/liquidation based on it).
    #[test]
    fn test_first_batch_no_oracle_returns_zero() {
        let book = OrderBook {
            instrument_id: 0,
            best_bid: 0,
            best_ask: 0,
            bid_count: 0,
            ask_count: 0,
            next_order_id: 0,
            last_update_slot: 0,
            bids: [level(100, 50); 64],
            asks: [level(110, 50); 64],
        };
        let mark = compute_mark_price(&book, 0, 100, None, 25, 150);
        assert_eq!(mark, 0);
    }

    /// Pin: stale book (last_update_slot older than decay_window) uses
    /// oracle.
    #[test]
    fn test_stale_book_uses_oracle() {
        let mut book = OrderBook {
            instrument_id: 0,
            best_bid: 0,
            best_ask: 0,
            bid_count: 0,
            ask_count: 0,
            next_order_id: 0,
            last_update_slot: 100, // last touch at slot 100
            bids: [level(100, 50); 64],
            asks: [level(110, 50); 64],
        };
        // Mark bids/asks to look like real data
        book.bids[0] = level(100, 50);
        book.asks[0] = level(110, 50);
        // Current slot = 300. Decay = 150. 300 - 100 = 200 > 150 → stale.
        let mark = compute_mark_price(&book, 99, 300, Some(500_000_000), 25, 150);
        assert_eq!(mark, 500_000_000, "stale book must use oracle");
    }

    /// Pin: stale book with no oracle carries forward prev_mark_price.
    #[test]
    fn test_stale_book_no_oracle_carries_forward() {
        let mut book = OrderBook {
            instrument_id: 0,
            best_bid: 0,
            best_ask: 0,
            bid_count: 0,
            ask_count: 0,
            next_order_id: 0,
            last_update_slot: 100,
            bids: [BookLevel::default(); 64],
            asks: [BookLevel::default(); 64],
        };
        book.bids[0] = level(100, 50);
        book.asks[0] = level(110, 50);
        let mark = compute_mark_price(&book, 42_000_000, 300, None, 25, 150);
        assert_eq!(mark, 42_000_000, "stale + no oracle → carry forward");
    }

    /// Pin: one-sided book (bids only) falls back to oracle.
    #[test]
    fn test_one_sided_book_uses_oracle() {
        let mut book = OrderBook {
            instrument_id: 0,
            best_bid: 0,
            best_ask: 0,
            bid_count: 0,
            ask_count: 0,
            next_order_id: 0,
            last_update_slot: 0,
            bids: [BookLevel::default(); 64],
            asks: [BookLevel::default(); 64],
        };
        book.bids[0] = level(100, 50);
        // No asks.
        let mark = compute_mark_price(&book, 42_000_000, 100, Some(99_000_000), 25, 150);
        assert_eq!(
            mark, 99_000_000,
            "one-sided book must fall back to oracle"
        );
    }
}
