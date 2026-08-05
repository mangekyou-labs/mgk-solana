use super::order::{FillReceipt, LimitOrder, Side};
use pinocchio::pubkey::Pubkey;

/// Maximum number of orders per batch (for BPF stack safety)
pub const MAX_ORDERS: usize = 64;

/// Internal scratch types for `compute_clearing_into`.
#[derive(Debug, Clone, Copy)]
pub(crate) struct BuyEntry {
    pub(crate) idx: usize,
    pub(crate) price: i64,
    pub(crate) qty: u64,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct SellEntry {
    pub(crate) idx: usize,
    pub(crate) price: i64,
    pub(crate) qty: u64,
}

/// Compute the uniform clearing price and fill allocations.
///
/// Algorithm:
/// 1. Collect all unique price levels from orders
/// 2. For each price level, compute cumulative buy volume (buys with price >= P)
///    and cumulative sell volume (sells with price <= P)
/// 3. Match volume = min(cumulative_buy, cumulative_sell) at each price
/// 4. Select the price that maximizes match volume
/// 5. If tie, choose price closest to mid of best bid and best ask
/// 6. Allocate fills pro-rata at the clearing price
#[cfg(not(target_os = "solana"))]
pub fn compute_clearing(
    orders: &[LimitOrder],
    max_orders: usize,
) -> Option<(i64, usize, [FillReceipt; MAX_ORDERS])> {
    let n = orders.len();
    if n == 0 || n > max_orders {
        return None;
    }

    // Separate and index buys and sells
    let mut buys = [BuyEntry {
        idx: 0,
        price: 0,
        qty: 0,
    }; MAX_ORDERS];
    let mut sells = [SellEntry {
        idx: 0,
        price: 0,
        qty: 0,
    }; MAX_ORDERS];
    let mut buy_count: usize = 0;
    let mut sell_count: usize = 0;

    for (i, o) in orders.iter().enumerate() {
        match o.side {
            Side::Buy => {
                if buy_count < MAX_ORDERS {
                    buys[buy_count] = BuyEntry {
                        idx: i,
                        price: o.price,
                        qty: o.qty,
                    };
                    buy_count += 1;
                }
            }
            Side::Sell => {
                if sell_count < MAX_ORDERS {
                    sells[sell_count] = SellEntry {
                        idx: i,
                        price: o.price,
                        qty: o.qty,
                    };
                    sell_count += 1;
                }
            }
        }
    }

    if buy_count == 0 || sell_count == 0 {
        return None;
    }

    // Sort buys descending by price
    sort_buys_desc(&mut buys[..buy_count]);
    // Sort sells ascending by price
    sort_sells_asc(&mut sells[..sell_count]);

    // Collect unique price levels from both sides
    let mut prices = [0i64; MAX_ORDERS * 2];
    let mut price_count: usize = 0;
    for b in buys.iter().take(buy_count) {
        if price_count < prices.len() {
            prices[price_count] = b.price;
            price_count += 1;
        }
    }
    for s in sells.iter().take(sell_count) {
        if price_count < prices.len() {
            prices[price_count] = s.price;
            price_count += 1;
        }
    }

    // Sort and dedup prices
    if price_count > 0 {
        sort_i64_asc(&mut prices[..price_count]);
        price_count = dedup_i64(&mut prices[..price_count]);
    }

    // Compute cumulative volumes at each price level
    let mut best_price: i64 = 0;
    let mut best_matched: u64 = 0;

    for &price in prices.iter().take(price_count) {
        let buy_qty = cum_qty_above(&buys[..buy_count], price);
        let sell_qty = cum_qty_below(&sells[..sell_count], price);
        let matched = buy_qty.min(sell_qty);

        if matched > best_matched {
            best_matched = matched;
            best_price = price;
        } else if matched == best_matched && matched > 0 {
            // Tiebreaker: closest to mid of best bid / best ask
            let best_bid = buys[0].price;
            let best_ask = sells[0].price;
            let mid = best_bid / 2 + best_ask / 2;
            let new_dist = (price - mid).abs();
            let old_dist = (best_price - mid).abs();
            if new_dist < old_dist || (new_dist == old_dist && price > best_price) {
                best_price = price;
            }
        }
    }

    if best_matched == 0 {
        return None;
    }

    // Allocate fills at the clearing price
    let (fills, fill_count) = allocate_fills(
        orders,
        &buys[..buy_count],
        &sells[..sell_count],
        best_price,
        best_matched,
    );

    Some((best_price, fill_count, fills))
}

// Sorting helpers (no_std compatible)

fn sort_buys_desc(entries: &mut [BuyEntry]) {
    // Insertion sort — fine for small N
    for i in 1..entries.len() {
        let mut j = i;
        while j > 0 && entries[j].price > entries[j - 1].price {
            entries.swap(j, j - 1);
            j -= 1;
        }
    }
}

fn sort_sells_asc(entries: &mut [SellEntry]) {
    for i in 1..entries.len() {
        let mut j = i;
        while j > 0 && entries[j].price < entries[j - 1].price {
            entries.swap(j, j - 1);
            j -= 1;
        }
    }
}

fn sort_i64_asc(values: &mut [i64]) {
    for i in 1..values.len() {
        let mut j = i;
        while j > 0 && values[j] < values[j - 1] {
            values.swap(j, j - 1);
            j -= 1;
        }
    }
}

fn dedup_i64(values: &mut [i64]) -> usize {
    if values.is_empty() {
        return 0;
    }
    let mut j = 1;
    for i in 1..values.len() {
        if values[i] != values[j - 1] {
            values[j] = values[i];
            j += 1;
        }
    }
    j
}

// Cumulative quantity helpers

fn cum_qty_above(buys: &[BuyEntry], price: i64) -> u64 {
    let mut total: u64 = 0;
    for b in buys.iter() {
        if b.price >= price {
            total = total.saturating_add(b.qty);
        }
    }
    total
}

fn cum_qty_below(sells: &[SellEntry], price: i64) -> u64 {
    let mut total: u64 = 0;
    for s in sells.iter() {
        if s.price <= price {
            total = total.saturating_add(s.qty);
        }
    }
    total
}

// Fill allocation

fn allocate_fills(
    orders: &[LimitOrder],
    buys: &[BuyEntry],
    sells: &[SellEntry],
    clearing_price: i64,
    matched_qty: u64,
) -> ([FillReceipt; MAX_ORDERS], usize) {
    let mut fills = [FillReceipt {
        user: Pubkey::default(),
        filled_qty: 0,
        notional: 0,
        is_maker: false,
    }; MAX_ORDERS];
    let mut fill_count: usize = 0;

    // Filter buy entries eligible at clearing price and copy to stack
    let mut eligible_buys = [BuyEntry {
        idx: 0,
        price: 0,
        qty: 0,
    }; MAX_ORDERS];
    let mut eb_count: usize = 0;
    for b in buys.iter() {
        if b.price >= clearing_price && b.qty > 0 && eb_count < MAX_ORDERS {
            eligible_buys[eb_count] = *b;
            eb_count += 1;
        }
    }
    let buy_qty_total: u64 = eligible_buys[..eb_count].iter().map(|b| b.qty).sum();
    let buy_fill_total = matched_qty.min(buy_qty_total);

    // Filter sell entries eligible at clearing price
    let mut eligible_sells = [SellEntry {
        idx: 0,
        price: 0,
        qty: 0,
    }; MAX_ORDERS];
    let mut es_count: usize = 0;
    for s in sells.iter() {
        if s.price <= clearing_price && s.qty > 0 && es_count < MAX_ORDERS {
            eligible_sells[es_count] = *s;
            es_count += 1;
        }
    }
    let sell_qty_total: u64 = eligible_sells[..es_count].iter().map(|s| s.qty).sum();
    let sell_fill_total = matched_qty.min(sell_qty_total);

    // Allocate fills
    let mut per_order = [0u64; MAX_ORDERS];
    pro_rata_fill(
        orders,
        &eligible_buys[..eb_count],
        clearing_price,
        buy_qty_total,
        buy_fill_total,
        &mut fills,
        &mut fill_count,
        &mut per_order,
    );
    pro_rata_fill(
        orders,
        &eligible_sells[..es_count],
        clearing_price,
        sell_qty_total,
        sell_fill_total,
        &mut fills,
        &mut fill_count,
        &mut per_order,
    );

    (fills, fill_count)
}
///
/// Takes scratch arrays as parameters so the caller can place them in
/// BSS (static storage) instead of on the stack. The `buys`/`sells`
/// slice parameters are borrowed from `compute_clearing_into`'s scratch arrays.
fn allocate_fills_into(
    orders: &[LimitOrder],
    buys: &[BuyEntry],
    sells: &[SellEntry],
    clearing_price: i64,
    matched_qty: u64,
    fills: &mut [FillReceipt; MAX_ORDERS],
    fill_count: &mut usize,
    eligible_buys: &mut [BuyEntry; MAX_ORDERS],
    eligible_sells: &mut [SellEntry; MAX_ORDERS],
    per_order: &mut [u64; MAX_ORDERS],
) {
    // Zero fills output.
    *fills = [FillReceipt {
        user: Pubkey::default(),
        filled_qty: 0,
        notional: 0,
        is_maker: false,
    }; MAX_ORDERS];
    *fill_count = 0;

    // Filter buy entries eligible at clearing price.
    let mut eb_count: usize = 0;
    for b in buys.iter() {
        if b.price >= clearing_price && b.qty > 0 && eb_count < MAX_ORDERS {
            eligible_buys[eb_count] = *b;
            eb_count += 1;
        }
    }
    let buy_qty_total: u64 = eligible_buys[..eb_count].iter().map(|b| b.qty).sum();
    let buy_fill_total = matched_qty.min(buy_qty_total);

    // Filter sell entries eligible at clearing price.
    let mut es_count: usize = 0;
    for s in sells.iter() {
        if s.price <= clearing_price && s.qty > 0 && es_count < MAX_ORDERS {
            eligible_sells[es_count] = *s;
            es_count += 1;
        }
    }
    let sell_qty_total: u64 = eligible_sells[..es_count].iter().map(|s| s.qty).sum();
    let sell_fill_total = matched_qty.min(sell_qty_total);

    // Allocate fills using the scratch `per_order` array.
    pro_rata_fill(
        orders,
        &eligible_buys[..eb_count],
        clearing_price,
        buy_qty_total,
        buy_fill_total,
        fills,
        fill_count,
        per_order,
    );
    pro_rata_fill(
        orders,
        &eligible_sells[..es_count],
        clearing_price,
        sell_qty_total,
        sell_fill_total,
        fills,
        fill_count,
        per_order,
    );
}

/// In-place variant of `compute_clearing` for BPF entry points.
///
/// Takes scratch arrays as parameters so the caller can place them in
/// BSS (static storage) instead of on the stack.
///
/// Returns `(clearing_price, fill_count)`. The caller provides the
/// `fills` buffer which is written in place.
#[inline(always)]
pub fn compute_clearing_into(
    orders: &[LimitOrder],
    max_orders: usize,
    buys: &mut [BuyEntry; MAX_ORDERS],
    sells: &mut [SellEntry; MAX_ORDERS],
    prices: &mut [i64; MAX_ORDERS * 2],
    fills: &mut [FillReceipt; MAX_ORDERS],
    eligible_buys: &mut [BuyEntry; MAX_ORDERS],
    eligible_sells: &mut [SellEntry; MAX_ORDERS],
    per_order: &mut [u64; MAX_ORDERS],
) -> Option<(i64, usize)> {
    let n = orders.len();
    if n == 0 || n > max_orders {
        return None;
    }

    let mut buy_count: usize = 0;
    let mut sell_count: usize = 0;

    for (i, o) in orders.iter().enumerate() {
        match o.side {
            Side::Buy => {
                if buy_count < MAX_ORDERS {
                    buys[buy_count] = BuyEntry {
                        idx: i,
                        price: o.price,
                        qty: o.qty,
                    };
                    buy_count += 1;
                }
            }
            Side::Sell => {
                if sell_count < MAX_ORDERS {
                    sells[sell_count] = SellEntry {
                        idx: i,
                        price: o.price,
                        qty: o.qty,
                    };
                    sell_count += 1;
                }
            }
        }
    }

    if buy_count == 0 || sell_count == 0 {
        return None;
    }

    sort_buys_desc(&mut buys[..buy_count]);
    sort_sells_asc(&mut sells[..sell_count]);

    // Collect unique price levels.
    let mut price_count: usize = 0;
    for b in buys.iter().take(buy_count) {
        if price_count < prices.len() {
            prices[price_count] = b.price;
            price_count += 1;
        }
    }
    for s in sells.iter().take(sell_count) {
        if price_count < prices.len() {
            prices[price_count] = s.price;
            price_count += 1;
        }
    }

    if price_count > 0 {
        sort_i64_asc(&mut prices[..price_count]);
        price_count = dedup_i64(&mut prices[..price_count]);
    }

    let mut best_price: i64 = 0;
    let mut best_matched: u64 = 0;

    for &price in prices.iter().take(price_count) {
        let buy_qty = cum_qty_above(&buys[..buy_count], price);
        let sell_qty = cum_qty_below(&sells[..sell_count], price);
        let matched = buy_qty.min(sell_qty);

        if matched > best_matched {
            best_matched = matched;
            best_price = price;
        } else if matched == best_matched && matched > 0 {
            let best_bid = buys[0].price;
            let best_ask = sells[0].price;
            let mid = best_bid / 2 + best_ask / 2;
            let new_dist = (price - mid).abs();
            let old_dist = (best_price - mid).abs();
            if new_dist < old_dist || (new_dist == old_dist && price > best_price) {
                best_price = price;
            }
        }
    }

    if best_matched == 0 {
        return None;
    }

    let mut fill_count: usize = 0;
    allocate_fills_into(
        orders,
        &buys[..buy_count],
        &sells[..sell_count],
        best_price,
        best_matched,
        fills,
        &mut fill_count,
        eligible_buys,
        eligible_sells,
        per_order,
    );

    Some((best_price, fill_count))
}

/// Pro-rata fill allocation with remainder distribution.
/// Handles rounding so total filled_qty == fill_total exactly.
fn pro_rata_fill<T: FillEntry>(
    orders: &[LimitOrder],
    entries: &[T],
    clearing_price: i64,
    total_qty: u64,
    fill_total: u64,
    fills: &mut [FillReceipt; MAX_ORDERS],
    fill_count: &mut usize,
    per_order: &mut [u64; MAX_ORDERS],
) {
    if total_qty == 0 || fill_total == 0 {
        return;
    }

    let n = entries.len();
    // First pass: floor division, track total allocated
    let mut allocated: u64 = 0;
    // Zero per_order.
    for p in per_order.iter_mut() {
        *p = 0;
    }

    for i in 0..n {
        let e = &entries[i];
        if e.qty() > 0 && *fill_count < MAX_ORDERS {
            let raw = (e.qty() as u128 * fill_total as u128) / total_qty as u128;
            let filled = (raw as u64).min(e.qty());
            per_order[i] = filled;
            allocated = allocated.saturating_add(filled);
        }
    }

    // Second pass: distribute remainder to orders with capacity
    let mut remaining = fill_total.saturating_sub(allocated);
    let mut idx: usize = 0;
    while remaining > 0 && idx < n {
        let e = &entries[idx];
        if per_order[idx] < e.qty() && per_order[idx] > 0 {
            per_order[idx] += 1;
            remaining -= 1;
        }
        idx += 1;
        if idx >= n && remaining > 0 {
            idx = 0; // wrap around for remaining
        }
    }

    // Write fills
    for i in 0..n {
        if per_order[i] > 0 && *fill_count < MAX_ORDERS {
            let e = &entries[i];
            let order = &orders[e.idx()];
            fills[*fill_count] = FillReceipt {
                user: order.user,
                filled_qty: per_order[i],
                notional: (per_order[i] as u128 * clearing_price.unsigned_abs() as u128 / 1_000_000)
                    as u64,
                is_maker: false,
            };
            *fill_count += 1;
        }
    }
}

/// Trait to abstract over BuyEntry and SellEntry
trait FillEntry {
    fn qty(&self) -> u64;
    fn idx(&self) -> usize;
}

impl FillEntry for BuyEntry {
    fn qty(&self) -> u64 {
        self.qty
    }
    fn idx(&self) -> usize {
        self.idx
    }
}

impl FillEntry for SellEntry {
    fn qty(&self) -> u64 {
        self.qty
    }
    fn idx(&self) -> usize {
        self.idx
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::order::OrderType;

    fn make_order(user_byte: u8, side: Side, price: i64, qty: u64) -> LimitOrder {
        let mut user_bytes = [0u8; 32];
        user_bytes[0] = user_byte;
        let user = Pubkey::from(user_bytes);
        LimitOrder {
            user,
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

    #[test]
    fn test_empty_orders() {
        let orders: [LimitOrder; 0] = [];
        assert!(compute_clearing(&orders, MAX_ORDERS).is_none());
    }

    #[test]
    fn test_only_buys() {
        let orders = [make_order(1, Side::Buy, 100_000_000, 10)];
        assert!(compute_clearing(&orders, MAX_ORDERS).is_none());
    }

    #[test]
    fn test_only_sells() {
        let orders = [make_order(1, Side::Sell, 100_000_000, 10)];
        assert!(compute_clearing(&orders, MAX_ORDERS).is_none());
    }

    #[test]
    fn test_single_buy_single_sell_same_price() {
        let orders = [
            make_order(1, Side::Buy, 100_000_000, 10),
            make_order(2, Side::Sell, 100_000_000, 10),
        ];
        let result = compute_clearing(&orders, MAX_ORDERS).unwrap();
        assert_eq!(result.0, 100_000_000); // clearing price
        assert_eq!(result.1, 2); // 2 fills
        assert_eq!(result.2[0].filled_qty, 10);
        assert_eq!(result.2[1].filled_qty, 10);
    }

    #[test]
    fn test_crossing_prices() {
        let orders = [
            make_order(1, Side::Buy, 110_000_000, 10),
            make_order(2, Side::Sell, 90_000_000, 10),
        ];
        let result = compute_clearing(&orders, MAX_ORDERS).unwrap();
        // Both cross — clearing price should be at the midpoint-ish
        assert!(result.0 >= 90_000_000 && result.0 <= 110_000_000);
        assert_eq!(result.1, 2);
    }

    #[test]
    fn test_no_crossing_prices() {
        let orders = [
            make_order(1, Side::Buy, 90_000_000, 10),
            make_order(2, Side::Sell, 110_000_000, 10),
        ];
        assert!(compute_clearing(&orders, MAX_ORDERS).is_none());
    }

    #[test]
    fn test_multiple_buys_one_sell() {
        let orders = [
            make_order(1, Side::Buy, 100_000_000, 5),
            make_order(2, Side::Buy, 105_000_000, 5),
            make_order(3, Side::Sell, 100_000_000, 10),
        ];
        let result = compute_clearing(&orders, MAX_ORDERS).unwrap();
        assert_eq!(result.0, 100_000_000);
        // Both buys filled, sell fully filled
        let total_filled: u64 = result.2.iter().map(|f| f.filled_qty).sum();
        assert_eq!(total_filled, 20); // 5+5 buys + 10 sell = 20
    }

    #[test]
    fn test_multiple_sells_one_buy() {
        let orders = [
            make_order(1, Side::Buy, 100_000_000, 10),
            make_order(2, Side::Sell, 95_000_000, 5),
            make_order(3, Side::Sell, 100_000_000, 5),
        ];
        let result = compute_clearing(&orders, MAX_ORDERS).unwrap();
        assert_eq!(result.0, 100_000_000);
        let total_filled: u64 = result.2.iter().map(|f| f.filled_qty).sum();
        assert_eq!(total_filled, 20);
    }

    #[test]
    fn test_partial_fill_buy_oversubscribed() {
        let orders = [
            make_order(1, Side::Buy, 100_000_000, 20),
            make_order(2, Side::Buy, 100_000_000, 20),
            make_order(3, Side::Sell, 100_000_000, 10), // only 10 available
        ];
        let result = compute_clearing(&orders, MAX_ORDERS).unwrap();
        assert_eq!(result.0, 100_000_000);
        // Buy side: 40 qty, sell side: 10 qty → matched = 10
        // Each buy gets pro-rata: 20/40 * 10 = 5, 20/40 * 10 = 5
        assert_eq!(result.2[0].filled_qty, 5);
        assert_eq!(result.2[1].filled_qty, 5);
        assert_eq!(result.2[2].filled_qty, 10);
    }

    #[test]
    fn test_partial_fill_sell_oversubscribed() {
        let orders = [
            make_order(1, Side::Buy, 100_000_000, 10), // only 10 wanted
            make_order(2, Side::Sell, 100_000_000, 20),
            make_order(3, Side::Sell, 100_000_000, 20),
        ];
        let result = compute_clearing(&orders, MAX_ORDERS).unwrap();
        assert_eq!(result.0, 100_000_000);
        // Buy side: 10 qty, sell side: 40 qty → matched = 10
        assert_eq!(result.2[0].filled_qty, 10);
        assert_eq!(result.2[1].filled_qty, 5);
        assert_eq!(result.2[2].filled_qty, 5);
    }

    #[test]
    fn test_price_discovery_midpoint() {
        // Buy at 105, sell at 95 — both equidistant from mid=100
        // Tiebreaker prefers higher price → 105
        let orders = [
            make_order(1, Side::Buy, 105_000_000, 10),
            make_order(2, Side::Sell, 95_000_000, 10),
        ];
        let result = compute_clearing(&orders, MAX_ORDERS).unwrap();
        assert_eq!(result.0, 105_000_000);
    }

    #[test]
    fn test_multiple_price_levels() {
        let orders = [
            make_order(1, Side::Buy, 110_000_000, 5),
            make_order(2, Side::Buy, 105_000_000, 10),
            make_order(3, Side::Buy, 100_000_000, 15),
            make_order(4, Side::Sell, 95_000_000, 15),
            make_order(5, Side::Sell, 100_000_000, 10),
            make_order(6, Side::Sell, 105_000_000, 5),
        ];
        let result = compute_clearing(&orders, MAX_ORDERS).unwrap();
        // At price=100: buys_above=30 (all), sells_below=25 → matched=25
        // At price=105: buys_above=15, sells_below=30 → matched=15
        // At price=110: buys_above=5, sells_below=30 → matched=5
        // Best is price=100 with 25 matched
        assert_eq!(result.0, 100_000_000);
        let total_filled: u64 = result.2.iter().map(|f| f.filled_qty).sum();
        assert_eq!(total_filled, 50); // 25 matched * 2 sides
    }
}
