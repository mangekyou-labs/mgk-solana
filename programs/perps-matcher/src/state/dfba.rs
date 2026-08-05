//! Dual Flow Batch Auction (DFBA) clearing core for mgk.
//!
//! Implements volume-maximizing uniform-price dual auctions per design:
//! - Bid auction: maker-buy × taker-sell
//! - Ask auction: maker-sell × taker-buy
//!
//! Layout constants (T9.0.1), clearing (T9.1.1), allocation (T9.1.2),
//! self-trade filter (T9.1.3), and cap selection (T9.1.4).

use pinocchio::pubkey::Pubkey;

/// Max orders processed in one clear (design D2 default).
pub const DFBA_MAX_ORDERS: usize = 64;

/// Scratch max for buffer sizing (design D2 max 128).
pub const DFBA_SCRATCH_MAX: usize = 128;

/// Flat pack width for one order in clear scratch.
/// Layout (little-endian):
/// ```text
/// [0..8)   price: i64
/// [8..16)  size: u64
/// [16..24) order_id: u64
/// [24..56) user: Pubkey (32 bytes)
/// ```
pub const FLAT_ORDER_BYTES: usize = 56;

/// Region indices into a four-region scratch buffer.
pub const REGION_MAKER_BUY: usize = 0;
pub const REGION_MAKER_SELL: usize = 1;
pub const REGION_TAKER_BUY: usize = 2;
pub const REGION_TAKER_SELL: usize = 3;
pub const REGION_COUNT: usize = 4;

/// Total scratch bytes for four regions at `cap` orders each.
#[inline]
pub const fn scratch_bytes_for_cap(cap: usize) -> usize {
    REGION_COUNT * cap * FLAT_ORDER_BYTES
}

/// Byte offset of region `r` (0..3) given per-region capacity `cap`.
#[inline]
pub const fn region_offset(region: usize, cap: usize) -> usize {
    region * cap * FLAT_ORDER_BYTES
}

/// One order input to DFBA (host / collect stage).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DfbaOrder {
    pub price: i64,
    pub size: u64,
    pub order_id: u64,
    pub user: Pubkey,
}

impl DfbaOrder {
    pub fn pack_into(&self, dst: &mut [u8]) {
        assert!(dst.len() >= FLAT_ORDER_BYTES);
        dst[0..8].copy_from_slice(&self.price.to_le_bytes());
        dst[8..16].copy_from_slice(&self.size.to_le_bytes());
        dst[16..24].copy_from_slice(&self.order_id.to_le_bytes());
        dst[24..56].copy_from_slice(self.user.as_ref());
    }

    pub fn unpack(src: &[u8]) -> Option<Self> {
        if src.len() < FLAT_ORDER_BYTES {
            return None;
        }
        let price = i64::from_le_bytes(src[0..8].try_into().ok()?);
        let size = u64::from_le_bytes(src[8..16].try_into().ok()?);
        let order_id = u64::from_le_bytes(src[16..24].try_into().ok()?);
        let mut user = Pubkey::default();
        user.as_mut().copy_from_slice(&src[24..56]);
        Some(Self {
            price,
            size,
            order_id,
            user,
        })
    }
}

/// Which dual-auction leg.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuctionKind {
    /// Maker-buy × taker-sell. Cross when maker_buy_price >= taker_sell_price.
    Bid,
    /// Maker-sell × taker-buy. Cross when maker_sell_price <= taker_buy_price.
    Ask,
}

/// Result of one uniform-price auction (clearing only).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AuctionResult {
    pub clearing_price: i64,
    pub matched_qty: u64,
}

/// Per-order fill from allocation.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct OrderFill {
    pub order_id: u64,
    pub user: Pubkey,
    pub fill_qty: u64,
    pub is_maker: bool,
}

/// Full allocation output for one auction.
#[derive(Debug, Clone, Copy)]
pub struct AllocationResult {
    pub clearing_price: i64,
    pub matched_qty: u64,
    pub dust: u64,
    pub maker_fills: [OrderFill; DFBA_MAX_ORDERS],
    pub maker_fill_count: usize,
    pub taker_fills: [OrderFill; DFBA_MAX_ORDERS],
    pub taker_fill_count: usize,
}

/// Host-only — constructing large fill arrays on the BPF stack exceeds 4 KiB.
#[cfg(not(target_os = "solana"))]
impl Default for AllocationResult {
    fn default() -> Self {
        Self {
            clearing_price: 0,
            matched_qty: 0,
            dust: 0,
            maker_fills: [OrderFill::default(); DFBA_MAX_ORDERS],
            maker_fill_count: 0,
            taker_fills: [OrderFill::default(); DFBA_MAX_ORDERS],
            taker_fill_count: 0,
        }
    }
}

/// Pack `orders` into flat buffer (must hold `orders.len() * FLAT_ORDER_BYTES`).
pub fn pack_orders(orders: &[DfbaOrder], buf: &mut [u8]) -> Result<usize, ()> {
    let need = orders
        .len()
        .checked_mul(FLAT_ORDER_BYTES)
        .ok_or(())?;
    if buf.len() < need {
        return Err(());
    }
    for (i, o) in orders.iter().enumerate() {
        let off = i * FLAT_ORDER_BYTES;
        o.pack_into(&mut buf[off..off + FLAT_ORDER_BYTES]);
    }
    Ok(orders.len())
}

/// Volume-maximizing uniform clearing (scratch buffers — BPF-safe).
///
/// `m_scratch` / `t_scratch` must hold at least `makers.len()` / `takers.len()`.
/// `prices` must hold at least `makers.len() + takers.len()`.
pub fn compute_clearing_into(
    makers: &[DfbaOrder],
    takers: &[DfbaOrder],
    kind: AuctionKind,
    m_scratch: &mut [DfbaOrder],
    t_scratch: &mut [DfbaOrder],
    prices: &mut [i64],
) -> Option<AuctionResult> {
    if makers.is_empty() || takers.is_empty() {
        return None;
    }
    let nm = makers.len();
    let nt = takers.len();
    if nm > DFBA_MAX_ORDERS || nt > DFBA_MAX_ORDERS {
        return None;
    }
    if m_scratch.len() < nm || t_scratch.len() < nt || prices.len() < nm + nt {
        return None;
    }

    m_scratch[..nm].copy_from_slice(makers);
    t_scratch[..nt].copy_from_slice(takers);

    match kind {
        AuctionKind::Ask => {
            sort_by_price_asc(&mut m_scratch[..nm]);
            sort_by_price_desc(&mut t_scratch[..nt]);
        }
        AuctionKind::Bid => {
            sort_by_price_desc(&mut m_scratch[..nm]);
            sort_by_price_asc(&mut t_scratch[..nt]);
        }
    }

    let mut pc = 0usize;
    for o in m_scratch.iter().take(nm) {
        prices[pc] = o.price;
        pc += 1;
    }
    for o in t_scratch.iter().take(nt) {
        prices[pc] = o.price;
        pc += 1;
    }
    sort_i64_asc(&mut prices[..pc]);
    pc = dedup_i64(&mut prices[..pc]);

    let mut best_price = 0i64;
    let mut best_matched = 0u64;

    for &p in prices.iter().take(pc) {
        let (supply, demand) = match kind {
            AuctionKind::Ask => (
                cum_size_price_le(&m_scratch[..nm], p),
                cum_size_price_ge(&t_scratch[..nt], p),
            ),
            AuctionKind::Bid => (
                cum_size_price_ge(&m_scratch[..nm], p),
                cum_size_price_le(&t_scratch[..nt], p),
            ),
        };
        let matched = supply.min(demand);
        if matched > best_matched {
            best_matched = matched;
            best_price = p;
        } else if matched == best_matched && matched > 0 {
            match kind {
                AuctionKind::Bid if p > best_price => best_price = p,
                AuctionKind::Ask if p < best_price => best_price = p,
                _ => {}
            }
        }
    }

    if best_matched == 0 {
        return None;
    }

    Some(AuctionResult {
        clearing_price: best_price,
        matched_qty: best_matched,
    })
}

/// Host convenience wrapper (uses stack scratch — not for BPF call path).
#[cfg(not(target_os = "solana"))]
pub fn compute_clearing(
    makers: &[DfbaOrder],
    takers: &[DfbaOrder],
    kind: AuctionKind,
) -> Option<AuctionResult> {
    let mut m = [DfbaOrder {
        price: 0,
        size: 0,
        order_id: 0,
        user: Pubkey::default(),
    }; DFBA_MAX_ORDERS];
    let mut t = m;
    let mut prices = [0i64; DFBA_MAX_ORDERS * 2];
    compute_clearing_into(makers, takers, kind, &mut m, &mut t, &mut prices)
}

/// Scratch for `compute_allocation_into` (heap on BPF).
pub struct AllocScratch {
    pub m_ord: [DfbaOrder; DFBA_MAX_ORDERS],
    pub t_ord: [DfbaOrder; DFBA_MAX_ORDERS],
    pub m_rem: [u64; DFBA_MAX_ORDERS],
    pub t_rem: [u64; DFBA_MAX_ORDERS],
    pub maker_fills_qty: [u64; DFBA_MAX_ORDERS],
    pub taker_fills_qty: [u64; DFBA_MAX_ORDERS],
}

/// Allocate fills into `out` using external `scratch` (BPF-safe — no large locals).
pub fn compute_allocation_into(
    makers: &[DfbaOrder],
    takers: &[DfbaOrder],
    kind: AuctionKind,
    result: &AuctionResult,
    marginal_size_cap: u64,
    out: &mut AllocationResult,
    scratch: &mut AllocScratch,
) {
    out.clearing_price = result.clearing_price;
    out.matched_qty = 0;
    out.dust = 0;
    out.maker_fill_count = 0;
    out.taker_fill_count = 0;

    if result.matched_qty == 0 || makers.is_empty() || takers.is_empty() {
        return;
    }
    let nm = makers.len();
    let nt = takers.len();
    if nm > DFBA_MAX_ORDERS || nt > DFBA_MAX_ORDERS {
        return;
    }

    let cp = result.clearing_price;
    let target = result.matched_qty;

    scratch.m_ord[..nm].copy_from_slice(makers);
    scratch.t_ord[..nt].copy_from_slice(takers);
    for i in 0..nm {
        scratch.m_rem[i] = scratch.m_ord[i].size;
        scratch.maker_fills_qty[i] = 0;
    }
    for i in 0..nt {
        scratch.t_rem[i] = scratch.t_ord[i].size;
        scratch.taker_fills_qty[i] = 0;
    }

    match kind {
        AuctionKind::Ask => {
            sort_paired_asc(&mut scratch.m_ord[..nm], &mut scratch.m_rem[..nm]);
            sort_paired_desc(&mut scratch.t_ord[..nt], &mut scratch.t_rem[..nt]);
        }
        AuctionKind::Bid => {
            sort_paired_desc(&mut scratch.m_ord[..nm], &mut scratch.m_rem[..nm]);
            sort_paired_asc(&mut scratch.t_ord[..nt], &mut scratch.t_rem[..nt]);
        }
    }

    for i in 0..nm {
        for j in 0..nt {
            if scratch.m_ord[i].user == scratch.t_ord[j].user
                && scratch.m_rem[i] > 0
                && scratch.t_rem[j] > 0
            {
                let cancel = scratch.m_rem[i].min(scratch.t_rem[j]);
                scratch.m_rem[i] -= cancel;
                scratch.t_rem[j] -= cancel;
            }
        }
    }

    let maker_target = allocate_side(
        &scratch.m_ord[..nm],
        &mut scratch.m_rem[..nm],
        &mut scratch.maker_fills_qty[..nm],
        kind,
        cp,
        true,
        target,
        marginal_size_cap,
    );
    let taker_target = allocate_side(
        &scratch.t_ord[..nt],
        &mut scratch.t_rem[..nt],
        &mut scratch.taker_fills_qty[..nt],
        kind,
        cp,
        false,
        target,
        marginal_size_cap,
    );

    let matched = maker_target.min(taker_target);
    if maker_target > matched {
        reduce_fills(&mut scratch.maker_fills_qty[..nm], maker_target - matched);
    }
    if taker_target > matched {
        reduce_fills(&mut scratch.taker_fills_qty[..nt], taker_target - matched);
    }

    let sum_m: u64 = scratch.maker_fills_qty.iter().take(nm).sum();
    let sum_t: u64 = scratch.taker_fills_qty.iter().take(nt).sum();
    let matched = sum_m.min(sum_t);
    if sum_m > matched {
        reduce_fills(&mut scratch.maker_fills_qty[..nm], sum_m - matched);
    }
    if sum_t > matched {
        reduce_fills(&mut scratch.taker_fills_qty[..nt], sum_t - matched);
    }

    let sum_m: u64 = scratch.maker_fills_qty.iter().take(nm).sum();
    out.matched_qty = sum_m;
    out.dust = target.saturating_sub(out.matched_qty);

    for i in 0..nm {
        if scratch.maker_fills_qty[i] > 0 && out.maker_fill_count < DFBA_MAX_ORDERS {
            out.maker_fills[out.maker_fill_count] = OrderFill {
                order_id: scratch.m_ord[i].order_id,
                user: scratch.m_ord[i].user,
                fill_qty: scratch.maker_fills_qty[i],
                is_maker: true,
            };
            out.maker_fill_count += 1;
        }
    }
    for j in 0..nt {
        if scratch.taker_fills_qty[j] > 0 && out.taker_fill_count < DFBA_MAX_ORDERS {
            out.taker_fills[out.taker_fill_count] = OrderFill {
                order_id: scratch.t_ord[j].order_id,
                user: scratch.t_ord[j].user,
                fill_qty: scratch.taker_fills_qty[j],
                is_maker: false,
            };
            out.taker_fill_count += 1;
        }
    }
}

/// Host convenience wrapper.
#[cfg(not(target_os = "solana"))]
pub fn compute_allocation(
    makers: &[DfbaOrder],
    takers: &[DfbaOrder],
    kind: AuctionKind,
    result: &AuctionResult,
    marginal_size_cap: u64,
) -> AllocationResult {
    let mut out = AllocationResult::default();
    let mut scratch = AllocScratch {
        m_ord: [DfbaOrder {
            price: 0,
            size: 0,
            order_id: 0,
            user: Pubkey::default(),
        }; DFBA_MAX_ORDERS],
        t_ord: [DfbaOrder {
            price: 0,
            size: 0,
            order_id: 0,
            user: Pubkey::default(),
        }; DFBA_MAX_ORDERS],
        m_rem: [0u64; DFBA_MAX_ORDERS],
        t_rem: [0u64; DFBA_MAX_ORDERS],
        maker_fills_qty: [0u64; DFBA_MAX_ORDERS],
        taker_fills_qty: [0u64; DFBA_MAX_ORDERS],
    };
    compute_allocation_into(
        makers,
        takers,
        kind,
        result,
        marginal_size_cap,
        &mut out,
        &mut scratch,
    );
    out
}

/// Combined result of bid + ask auctions for one batch clear.
#[derive(Debug, Clone, Copy)]
pub struct DualAuctionResult {
    pub bid: AuctionResult,
    pub ask: AuctionResult,
    pub bid_alloc: AllocationResult,
    pub ask_alloc: AllocationResult,
}

#[cfg(not(target_os = "solana"))]
impl Default for DualAuctionResult {
    fn default() -> Self {
        Self {
            bid: AuctionResult::default(),
            ask: AuctionResult::default(),
            bid_alloc: AllocationResult::default(),
            ask_alloc: AllocationResult::default(),
        }
    }
}

/// Scratch for dual clear (heap on BPF).
///
/// Reuses `alloc.m_ord` / `alloc.t_ord` as sort buffers for clearing so we
/// do not hold a second full pair of order arrays (32 KiB heap budget).
pub struct DualClearScratch {
    pub prices: [i64; DFBA_MAX_ORDERS * 2],
    pub alloc: AllocScratch,
}

/// Run both auctions into `out` (BPF-safe when `out` + `scratch` are heap).
pub fn run_dual_dfba_into(
    maker_buys: &[DfbaOrder],
    maker_sells: &[DfbaOrder],
    taker_buys: &[DfbaOrder],
    taker_sells: &[DfbaOrder],
    marginal_size_cap: u64,
    out: &mut DualAuctionResult,
    scratch: &mut DualClearScratch,
) {
    out.bid = AuctionResult::default();
    out.ask = AuctionResult::default();
    out.bid_alloc.matched_qty = 0;
    out.bid_alloc.maker_fill_count = 0;
    out.bid_alloc.taker_fill_count = 0;
    out.ask_alloc.matched_qty = 0;
    out.ask_alloc.maker_fill_count = 0;
    out.ask_alloc.taker_fill_count = 0;

    if let Some(bid) = compute_clearing_into(
        maker_buys,
        taker_sells,
        AuctionKind::Bid,
        &mut scratch.alloc.m_ord,
        &mut scratch.alloc.t_ord,
        &mut scratch.prices,
    ) {
        out.bid = bid;
        compute_allocation_into(
            maker_buys,
            taker_sells,
            AuctionKind::Bid,
            &bid,
            marginal_size_cap,
            &mut out.bid_alloc,
            &mut scratch.alloc,
        );
    }

    if let Some(ask) = compute_clearing_into(
        maker_sells,
        taker_buys,
        AuctionKind::Ask,
        &mut scratch.alloc.m_ord,
        &mut scratch.alloc.t_ord,
        &mut scratch.prices,
    ) {
        out.ask = ask;
        compute_allocation_into(
            maker_sells,
            taker_buys,
            AuctionKind::Ask,
            &ask,
            marginal_size_cap,
            &mut out.ask_alloc,
            &mut scratch.alloc,
        );
    }
}

/// Host convenience wrapper.
#[cfg(not(target_os = "solana"))]
pub fn run_dual_dfba(
    maker_buys: &[DfbaOrder],
    maker_sells: &[DfbaOrder],
    taker_buys: &[DfbaOrder],
    taker_sells: &[DfbaOrder],
    marginal_size_cap: u64,
) -> DualAuctionResult {
    let mut out = DualAuctionResult::default();
    let zero = DfbaOrder {
        price: 0,
        size: 0,
        order_id: 0,
        user: Pubkey::default(),
    };
    let mut scratch = DualClearScratch {
        prices: [0i64; DFBA_MAX_ORDERS * 2],
        alloc: AllocScratch {
            m_ord: [zero; DFBA_MAX_ORDERS],
            t_ord: [zero; DFBA_MAX_ORDERS],
            m_rem: [0u64; DFBA_MAX_ORDERS],
            t_rem: [0u64; DFBA_MAX_ORDERS],
            maker_fills_qty: [0u64; DFBA_MAX_ORDERS],
            taker_fills_qty: [0u64; DFBA_MAX_ORDERS],
        },
    };
    run_dual_dfba_into(
        maker_buys,
        maker_sells,
        taker_buys,
        taker_sells,
        marginal_size_cap,
        &mut out,
        &mut scratch,
    );
    out
}

/// Select up to `cap` orders by price priority for a DFBA leg.
///
/// `prefer_higher_price`: true for bids (maker buy / taker buy), false for asks (sells).
/// Tie-break: larger size, then lower order_id.
/// Returns count written into `out`.
pub fn select_by_price_priority(
    orders: &[DfbaOrder],
    cap: usize,
    prefer_higher_price: bool,
    out: &mut [DfbaOrder],
) -> usize {
    if cap == 0 || out.is_empty() || orders.is_empty() {
        return 0;
    }
    let take = cap.min(out.len()).min(orders.len()).min(DFBA_MAX_ORDERS);
    let mut tmp = [DfbaOrder {
        price: 0,
        size: 0,
        order_id: 0,
        user: Pubkey::default(),
    }; DFBA_MAX_ORDERS];
    let n = orders.len().min(DFBA_MAX_ORDERS);
    tmp[..n].copy_from_slice(&orders[..n]);

    // Selection sort by priority (stable enough for small n)
    for i in 0..n {
        let mut best = i;
        for j in (i + 1)..n {
            if better_priority(&tmp[j], &tmp[best], prefer_higher_price) {
                best = j;
            }
        }
        if best != i {
            tmp.swap(i, best);
        }
    }

    out[..take].copy_from_slice(&tmp[..take]);
    take
}

fn better_priority(a: &DfbaOrder, b: &DfbaOrder, prefer_higher: bool) -> bool {
    if a.price != b.price {
        return if prefer_higher {
            a.price > b.price
        } else {
            a.price < b.price
        };
    }
    if a.size != b.size {
        return a.size > b.size;
    }
    a.order_id < b.order_id
}

fn allocate_side(
    orders: &[DfbaOrder],
    rem: &mut [u64],
    fills: &mut [u64],
    kind: AuctionKind,
    cp: i64,
    is_maker: bool,
    target: u64,
    marginal_size_cap: u64,
) -> u64 {
    let n = orders.len();
    let crosses = |price: i64| {
        if is_maker {
            match kind {
                AuctionKind::Ask => price <= cp,
                AuctionKind::Bid => price >= cp,
            }
        } else {
            match kind {
                AuctionKind::Ask => price >= cp,
                AuctionKind::Bid => price <= cp,
            }
        }
    };
    let better = |price: i64| {
        if is_maker {
            match kind {
                AuctionKind::Ask => price < cp,
                AuctionKind::Bid => price > cp,
            }
        } else {
            match kind {
                AuctionKind::Ask => price > cp,
                AuctionKind::Bid => price < cp,
            }
        }
    };

    let mut left = target;

    for i in 0..n {
        if left == 0 {
            break;
        }
        if !crosses(orders[i].price) || rem[i] == 0 {
            continue;
        }
        if better(orders[i].price) {
            let f = rem[i].min(left);
            fills[i] = f;
            rem[i] -= f;
            left -= f;
        }
    }

    if left > 0 {
        let mut marg_idx = [0usize; DFBA_MAX_ORDERS];
        let mut marg_n = 0usize;
        let mut marg_total = 0u64;
        for i in 0..n {
            if orders[i].price == cp && rem[i] > 0 && crosses(orders[i].price) {
                let capped = rem[i].min(marginal_size_cap);
                if capped > 0 {
                    marg_idx[marg_n] = i;
                    marg_n += 1;
                    marg_total = marg_total.saturating_add(capped);
                }
            }
        }
        if marg_n > 0 && marg_total > 0 {
            let to_alloc = left.min(marg_total);
            for k in 0..marg_n {
                let i = marg_idx[k];
                let capped = rem[i].min(marginal_size_cap);
                let f = ((capped as u128) * (to_alloc as u128) / (marg_total as u128)) as u64;
                fills[i] = fills[i].saturating_add(f);
                rem[i] = rem[i].saturating_sub(f);
            }
        }
    }

    fills.iter().take(n).sum()
}

fn reduce_fills(fills: &mut [u64], mut excess: u64) {
    // Reduce from the end (marginal last filled first)
    let n = fills.len();
    for i in (0..n).rev() {
        if excess == 0 {
            break;
        }
        if fills[i] > 0 {
            let cut = fills[i].min(excess);
            fills[i] -= cut;
            excess -= cut;
        }
    }
}

fn cum_size_price_le(orders: &[DfbaOrder], p: i64) -> u64 {
    let mut s = 0u64;
    for o in orders {
        if o.price <= p {
            s = s.saturating_add(o.size);
        }
    }
    s
}

fn cum_size_price_ge(orders: &[DfbaOrder], p: i64) -> u64 {
    let mut s = 0u64;
    for o in orders {
        if o.price >= p {
            s = s.saturating_add(o.size);
        }
    }
    s
}

fn sort_by_price_asc(a: &mut [DfbaOrder]) {
    let n = a.len();
    for i in 1..n {
        let mut j = i;
        while j > 0 && a[j].price < a[j - 1].price {
            a.swap(j, j - 1);
            j -= 1;
        }
    }
}

fn sort_by_price_desc(a: &mut [DfbaOrder]) {
    let n = a.len();
    for i in 1..n {
        let mut j = i;
        while j > 0 && a[j].price > a[j - 1].price {
            a.swap(j, j - 1);
            j -= 1;
        }
    }
}

fn sort_paired_asc(orders: &mut [DfbaOrder], rem: &mut [u64]) {
    let n = orders.len();
    for i in 1..n {
        let mut j = i;
        while j > 0 && orders[j].price < orders[j - 1].price {
            orders.swap(j, j - 1);
            rem.swap(j, j - 1);
            j -= 1;
        }
    }
}

fn sort_paired_desc(orders: &mut [DfbaOrder], rem: &mut [u64]) {
    let n = orders.len();
    for i in 1..n {
        let mut j = i;
        while j > 0 && orders[j].price > orders[j - 1].price {
            orders.swap(j, j - 1);
            rem.swap(j, j - 1);
            j -= 1;
        }
    }
}

fn sort_i64_asc(a: &mut [i64]) {
    let n = a.len();
    for i in 1..n {
        let mut j = i;
        while j > 0 && a[j] < a[j - 1] {
            a.swap(j, j - 1);
            j -= 1;
        }
    }
}

fn dedup_i64(a: &mut [i64]) -> usize {
    if a.is_empty() {
        return 0;
    }
    let mut w = 1usize;
    for r in 1..a.len() {
        if a[r] != a[w - 1] {
            a[w] = a[r];
            w += 1;
        }
    }
    w
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pk(b: u8) -> Pubkey {
        let mut p = Pubkey::default();
        p.as_mut()[0] = b;
        p
    }

    fn o(price: i64, size: u64, id: u64, user: u8) -> DfbaOrder {
        DfbaOrder {
            price,
            size,
            order_id: id,
            user: pk(user),
        }
    }

    // ── T9.0.1 layout ──────────────────────────────────────────────────

    #[test]
    fn flat_order_bytes_is_56() {
        assert_eq!(FLAT_ORDER_BYTES, 8 + 8 + 8 + 32);
    }

    #[test]
    fn region_offsets_do_not_overlap_at_cap_64() {
        let cap = 64;
        let total = scratch_bytes_for_cap(cap);
        assert_eq!(total, 4 * 64 * 56);
        let mut ends = [0usize; 4];
        for r in 0..4 {
            let start = region_offset(r, cap);
            let end = start + cap * FLAT_ORDER_BYTES;
            ends[r] = end;
            assert_eq!(start, r * cap * FLAT_ORDER_BYTES);
        }
        assert_eq!(ends[3], total);
        // Adjacent regions abut, no gap/overlap
        assert_eq!(region_offset(1, cap), region_offset(0, cap) + cap * FLAT_ORDER_BYTES);
        assert_eq!(region_offset(2, cap), region_offset(1, cap) + cap * FLAT_ORDER_BYTES);
        assert_eq!(region_offset(3, cap), region_offset(2, cap) + cap * FLAT_ORDER_BYTES);
    }

    #[test]
    fn pack_unpack_roundtrip() {
        let order = o(1_003, 500, 42, 7);
        let mut buf = [0u8; FLAT_ORDER_BYTES];
        order.pack_into(&mut buf);
        let back = DfbaOrder::unpack(&buf).unwrap();
        assert_eq!(back, order);
    }

    // ── T9.1.1 clearing ────────────────────────────────────────────────

    #[test]
    fn ask_auction_no_cross() {
        let makers = [o(100, 10, 1, 1)]; // sell 100
        let takers = [o(90, 10, 2, 2)]; // buy 90
        assert!(compute_clearing(&makers, &takers, AuctionKind::Ask).is_none());
    }

    #[test]
    fn ask_auction_simple_uniform() {
        // Maker sell 100×10, taker buy 110×10 → clear in [100,110], volume 10
        let makers = [o(100, 10, 1, 1)];
        let takers = [o(110, 10, 2, 2)];
        let r = compute_clearing(&makers, &takers, AuctionKind::Ask).unwrap();
        assert_eq!(r.matched_qty, 10);
        assert!(r.clearing_price >= 100 && r.clearing_price <= 110);
        // All fills at one price — price is one of the candidates
        assert!(r.clearing_price == 100 || r.clearing_price == 110);
    }

    #[test]
    fn ask_auction_paper_style_volume_max() {
        // Similar to DFBA paper ask auction:
        // makers sell: 1001×100, 1003×1000, 1003×200
        // takers buy:  1005×300, 1003×100
        // max volume 400 at 1003
        let makers = [
            o(1001, 100, 2, 1),
            o(1003, 1000, 7, 2),
            o(1003, 200, 9, 3),
        ];
        let takers = [o(1005, 300, 3, 4), o(1003, 100, 4, 5)];
        let r = compute_clearing(&makers, &takers, AuctionKind::Ask).unwrap();
        assert_eq!(r.matched_qty, 400);
        assert_eq!(r.clearing_price, 1003);
    }

    #[test]
    fn bid_auction_paper_style() {
        // makers buy: 1000×100, 997×1000
        // takers sell: 1001×100, 990×500
        // paper: clear 997 qty 500
        let makers = [o(1000, 100, 1, 1), o(997, 1000, 6, 2)];
        let takers = [o(1001, 100, 5, 3), o(990, 500, 8, 4)];
        let r = compute_clearing(&makers, &takers, AuctionKind::Bid).unwrap();
        assert_eq!(r.matched_qty, 500);
        assert_eq!(r.clearing_price, 997);
    }

    #[test]
    fn empty_side_returns_none() {
        let makers = [o(100, 10, 1, 1)];
        assert!(compute_clearing(&makers, &[], AuctionKind::Ask).is_none());
        assert!(compute_clearing(&[], &makers, AuctionKind::Ask).is_none());
    }

    // ── T9.1.2 allocation ──────────────────────────────────────────────

    #[test]
    fn allocation_uniform_and_conserves() {
        let makers = [o(100, 10, 1, 1)];
        let takers = [o(110, 10, 2, 2)];
        let clear = compute_clearing(&makers, &takers, AuctionKind::Ask).unwrap();
        let alloc = compute_allocation(&makers, &takers, AuctionKind::Ask, &clear, u64::MAX);
        let msum: u64 = (0..alloc.maker_fill_count)
            .map(|i| alloc.maker_fills[i].fill_qty)
            .sum();
        let tsum: u64 = (0..alloc.taker_fill_count)
            .map(|i| alloc.taker_fills[i].fill_qty)
            .sum();
        assert_eq!(msum, tsum);
        assert_eq!(msum, alloc.matched_qty);
        assert_eq!(alloc.matched_qty, 10);
        assert_eq!(alloc.clearing_price, clear.clearing_price);
        // All at same clear price (implicit via result)
        assert!(alloc.maker_fills[0].is_maker);
        assert!(!alloc.taker_fills[0].is_maker);
    }

    #[test]
    fn allocation_pro_rata_at_margin() {
        // Two makers at same sell price 100 size 100 each; one taker buy 100 size 100
        // pro-rata → 50 each (if both at clear)
        let makers = [o(100, 100, 1, 1), o(100, 100, 2, 2)];
        let takers = [o(100, 100, 3, 3)];
        let clear = compute_clearing(&makers, &takers, AuctionKind::Ask).unwrap();
        assert_eq!(clear.matched_qty, 100);
        assert_eq!(clear.clearing_price, 100);
        let alloc = compute_allocation(&makers, &takers, AuctionKind::Ask, &clear, u64::MAX);
        assert_eq!(alloc.matched_qty, 100);
        let msum: u64 = (0..alloc.maker_fill_count)
            .map(|i| alloc.maker_fills[i].fill_qty)
            .sum();
        assert_eq!(msum, 100);
        // Each maker should get 50 (pro-rata equal size)
        assert_eq!(alloc.maker_fill_count, 2);
        assert_eq!(alloc.maker_fills[0].fill_qty, 50);
        assert_eq!(alloc.maker_fills[1].fill_qty, 50);
    }

    #[test]
    fn allocation_dust_round_down() {
        // 3 makers size 1 at 100; taker size 1 → pro-rata 0 each if round down? 
        // Actually 1/3 rounds to 0 for each → dust 1, matched 0 — or first gets 0
        // Better: makers 10,10,10 taker 10 at same price → 3+3+3=9 dust 1
        let makers = [o(100, 10, 1, 1), o(100, 10, 2, 2), o(100, 10, 3, 3)];
        let takers = [o(100, 10, 4, 4)];
        let clear = compute_clearing(&makers, &takers, AuctionKind::Ask).unwrap();
        let alloc = compute_allocation(&makers, &takers, AuctionKind::Ask, &clear, u64::MAX);
        let msum: u64 = (0..alloc.maker_fill_count)
            .map(|i| alloc.maker_fills[i].fill_qty)
            .sum();
        assert_eq!(msum, alloc.matched_qty);
        assert!(alloc.matched_qty <= 10);
        // round-down: 10/3 = 3 each → 9, dust at least 1 vs target 10
        assert_eq!(alloc.matched_qty, 9);
        assert_eq!(alloc.dust, 1);
    }

    // ── T9.1.3 self-trade ──────────────────────────────────────────────

    #[test]
    fn self_trade_does_not_fill() {
        // Same user maker sell and taker buy that would cross
        let makers = [o(100, 50, 1, 9)];
        let takers = [o(110, 50, 2, 9)];
        let clear = compute_clearing(&makers, &takers, AuctionKind::Ask).unwrap();
        assert!(clear.matched_qty > 0); // clearing volume exists pre self-trade
        let alloc = compute_allocation(&makers, &takers, AuctionKind::Ask, &clear, u64::MAX);
        assert_eq!(alloc.matched_qty, 0);
        assert_eq!(alloc.maker_fill_count, 0);
        assert_eq!(alloc.taker_fill_count, 0);
    }

    #[test]
    fn self_trade_partial_other_user_still_fills() {
        // User 9 has 50 sell; user 1 has 50 sell; user 9 also has 100 buy
        // Self-trade cancels 50 of user 9 against self; remaining 50 buy vs user 1 sell
        let makers = [o(100, 50, 1, 9), o(100, 50, 2, 1)];
        let takers = [o(110, 100, 3, 9)];
        let clear = compute_clearing(&makers, &takers, AuctionKind::Ask).unwrap();
        let alloc = compute_allocation(&makers, &takers, AuctionKind::Ask, &clear, u64::MAX);
        // Only user 1 maker can fill against residual after self cancel
        assert!(alloc.matched_qty > 0);
        assert!(alloc.matched_qty <= 50);
        for i in 0..alloc.maker_fill_count {
            assert_ne!(alloc.maker_fills[i].user, pk(9));
        }
    }

    // ── T9.1.4 cap selection ───────────────────────────────────────────

    #[test]
    fn select_cap_prefers_best_price() {
        let orders = [
            o(100, 10, 3, 1),
            o(90, 10, 1, 2),  // best ask
            o(95, 10, 2, 3),
        ];
        let mut out = [o(0, 0, 0, 0); 2];
        let n = select_by_price_priority(&orders, 2, false, &mut out);
        assert_eq!(n, 2);
        assert_eq!(out[0].price, 90);
        assert_eq!(out[1].price, 95);
    }

    #[test]
    fn select_tie_break_size_then_order_id() {
        let orders = [
            o(100, 10, 5, 1),
            o(100, 20, 9, 2), // larger size wins
            o(100, 20, 3, 3), // same size, lower id wins
        ];
        let mut out = [o(0, 0, 0, 0); 2];
        let n = select_by_price_priority(&orders, 2, true, &mut out);
        assert_eq!(n, 2);
        // First: price 100 size 20 order_id 3
        assert_eq!(out[0].size, 20);
        assert_eq!(out[0].order_id, 3);
        assert_eq!(out[1].size, 20);
        assert_eq!(out[1].order_id, 9);
    }

    #[test]
    fn select_cap_zero() {
        let orders = [o(100, 10, 1, 1)];
        let mut out = [o(0, 0, 0, 0); 1];
        assert_eq!(select_by_price_priority(&orders, 0, true, &mut out), 0);
    }

    // ── T9.1.5 dual path ───────────────────────────────────────────────

    #[test]
    fn run_dual_dfba_both_auctions() {
        // Bid: maker buy 1000×10, taker sell 990×10 → match
        // Ask: maker sell 1000×10, taker buy 1010×10 → match
        let maker_buys = [o(1000, 10, 1, 1)];
        let maker_sells = [o(1000, 10, 2, 2)];
        let taker_buys = [o(1010, 10, 3, 3)];
        let taker_sells = [o(990, 10, 4, 4)];
        let dual = run_dual_dfba(
            &maker_buys,
            &maker_sells,
            &taker_buys,
            &taker_sells,
            u64::MAX,
        );
        assert_eq!(dual.bid.matched_qty, 10);
        assert_eq!(dual.ask.matched_qty, 10);
        assert_eq!(dual.bid_alloc.matched_qty, 10);
        assert_eq!(dual.ask_alloc.matched_qty, 10);
        let bid_m: u64 = (0..dual.bid_alloc.maker_fill_count)
            .map(|i| dual.bid_alloc.maker_fills[i].fill_qty)
            .sum();
        let bid_t: u64 = (0..dual.bid_alloc.taker_fill_count)
            .map(|i| dual.bid_alloc.taker_fills[i].fill_qty)
            .sum();
        assert_eq!(bid_m, bid_t);
    }

    #[test]
    fn run_dual_dfba_one_sided_no_ask() {
        let maker_buys = [o(1000, 10, 1, 1)];
        let taker_sells = [o(990, 10, 2, 2)];
        let dual = run_dual_dfba(&maker_buys, &[], &[], &taker_sells, u64::MAX);
        assert!(dual.bid.matched_qty > 0);
        assert_eq!(dual.ask.matched_qty, 0);
        assert_eq!(dual.ask_alloc.matched_qty, 0);
    }

    /// T9.5.3-style: place-like inputs → dual clear → mark mid + liq pause rule.
    #[test]
    fn lifecycle_dual_fill_implies_mark_valid() {
        let maker_buys = [o(1000, 50, 1, 1)];
        let maker_sells = [o(1000, 50, 2, 2)];
        let taker_buys = [o(1010, 50, 3, 3)];
        let taker_sells = [o(990, 50, 4, 4)];
        let dual = run_dual_dfba(
            &maker_buys,
            &maker_sells,
            &taker_buys,
            &taker_sells,
            u64::MAX,
        );
        assert!(dual.bid.matched_qty > 0);
        assert!(dual.ask.matched_qty > 0);
        let mark_valid = dual.bid.matched_qty > 0 && dual.ask.matched_qty > 0;
        let liq_paused = !mark_valid;
        assert!(mark_valid);
        assert!(!liq_paused);
        let mid = dual.bid.clearing_price / 2
            + dual.ask.clearing_price / 2
            + (dual.bid.clearing_price % 2 + dual.ask.clearing_price % 2) / 2;
        assert!(mid > 0);
    }

    #[test]
    fn lifecycle_one_sided_implies_liq_paused() {
        let dual = run_dual_dfba(
            &[o(1000, 10, 1, 1)],
            &[],
            &[],
            &[o(990, 10, 2, 2)],
            u64::MAX,
        );
        let mark_valid = dual.bid.matched_qty > 0 && dual.ask.matched_qty > 0;
        assert!(!mark_valid);
        assert!(dual.bid.matched_qty > 0);
    }

    #[test]
    fn lifecycle_self_trade_only_yields_zero_fills() {
        // Same user maker sell + taker buy: clear volume may exist but alloc is 0.
        let dual = run_dual_dfba(
            &[],
            &[o(100, 20, 1, 9)],
            &[o(110, 20, 2, 9)],
            &[],
            u64::MAX,
        );
        assert!(dual.ask.matched_qty > 0);
        assert_eq!(dual.ask_alloc.matched_qty, 0);
    }
}
