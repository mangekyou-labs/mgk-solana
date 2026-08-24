---
phase: design
title: On-Chain Perpetuals DEX Design
description: Dual Flow Batch Auction (DFBA) perps on Solana — open posts, dual uniform-price clears, pure DFBA mark, multi-venue index for funding, cross-margin safety stack. Supersedes commit-reveal CLOB design.
status: design-review-2026-08-20
---

# On-Chain Perpetuals DEX Design

> **Aligned with** `docs/ai/requirements/2026-06-18-feature-onchain-perps-dex.md` (DFBA Decision Log, 2026-08-02).
> **Supersedes** commit-reveal, Fisher-Yates shuffle, structural priority queues, reveal relayer, and freshness-based mark blend.
> **Design review 2026-08-20:** matching is Jump-paper DFBA (mgk closer than `~/repos/dfba-pinocchio`); Stellars grant is ops checklist only; remaining work split into working-devnet vs mainnet (appendix).
> Historical RFQ/continuous alternative remains at `feature-onchain-perps-dex-rfq.md` (not active v1).

## Architecture Overview

A fully on-chain perpetual futures exchange on Solana using a **Dual Flow Batch Auction (DFBA)** matching engine. Every post, cancel, dual-auction clear, fill, and settlement is verifiable on-chain. There is no sequencer and no commit-reveal ceremony.

**Market structure (normative):**

1. Traders **post** limit orders in the clear during a governance-parameterized collection window (`is_maker` flag; default taker).
2. A permissionless crank **closes** the window and runs **two independent uniform-price auctions**:
   - **Bid auction:** maker-buy × taker-sell
   - **Ask auction:** maker-sell × taker-buy
3. Each auction maximizes matched volume at a single clearing price; allocation is price-priority then pro-rata at the margin; self-trades excluded.
4. Unfilled quantity **rests** with the same maker/taker role (full DFBA rest). Immediate cancel/modify allowed outside clear.
5. **Mark** = mid(bid_clear, ask_clear) only when **both** auctions produce a usable clear; otherwise liquidations pause. Multi-venue oracle is **index/funding only**.

```mermaid
graph TD
    subgraph Users
        TRADER[Trader]
        MM[Market Maker]
    end

    subgraph "On-Chain Programs"
        CORE[Core Program<br/>Portfolio / Vault<br/>Batch lifecycle<br/>Margin / Funding<br/>Mark validity]
        MATCH[Matcher Program<br/>DFBA dual auction<br/>Allocation / self-trade<br/>Resting book]
        ORACLE[Oracle Program<br/>Multi-venue index]
    end

    subgraph Keepers
        CRANK[Batch Crank<br/>close + clear + settle]
        LIQ[Liquidator<br/>only if mark valid]
        IDX[Indexer<br/>events + accounts]
    end

    subgraph Safety
        OPT[Liquidation Optimizer]
        INS[Insurance Fund]
        ADL[ADL]
    end

    TRADER -->|PostOrder / Cancel / Modify| CORE
    MM -->|PostOrder maker| CORE
    CORE -->|CPI ClearBatch DFBA| MATCH
    MATCH -->|fills + book delta| CORE
    CORE -->|update positions fees mark| CORE
    CRANK -->|CloseCollecting ClearBatch SettleBatch| CORE
    LIQ -->|LiquidateUser| OPT
    OPT -->|shortfall| INS
    INS -->|insufficient| ADL
    ORACLE -->|index for funding| CORE
    IDX -.->|logs + account subscribe| CORE
    IDX -.->|logs| MATCH
```

**Key principles**

| Principle | Design rule |
|-----------|-------------|
| Custody isolation | Core alone moves SOL; matcher never holds funds |
| Structural fairness | No within-batch time priority; dual uniform clears; makers never match makers |
| Mark purity | Execution and mark from DFBA only; oracle never sets mark |
| CU honesty | Hard per-batch order cap; single-ix clear; mgk-owned CU spike gates the cap |
| Safety | Liquidations require valid dual-clear mark; pause flags independent |

### Why not continuous CLOB / commit-reveal

| Approach | Rejection for v1 |
|----------|------------------|
| Continuous price-time CLOB | Latency arms race, leader reordering, adverse selection for makers |
| Commit-reveal + CLOB clear | Hides intent but still CLOB economics after reveal; two-tx UX + relayer |
| Off-chain DFBA solver | Reintroduces trust/MEV surface |
| Hybrid continuous + DFBA | Scope explosion; pure DFBA only |
| GLP / LP-pool perps (Stellars grant) | Different product: oracle-priced synthetics vs an LP. mgk is DFBA order-book perps. |

## External references (not specs to clone)

Normative matching is the [Jump Crypto DFBA paper](https://jumpcrypto.com/resources/dual-flow-batch-auction) (21 Aug 2025): dual independent uniform-price auctions, volume-max clearing leaving no unmatched orders at better prices, price-priority then pro-rata at the marginal price, rest with role preserved, user-designated maker/taker.

| Reference | What it is | How we use it |
|-----------|------------|---------------|
| Jump DFBA paper | Original matching spec + numeric example (bid 9.97/500, ask 10.03/400) | **Normative.** mgk `compute_clearing_into` + `allocate_side` match the example. Tests `bid_auction_paper_style` / `ask_auction_paper_style_volume_max` pin clearing (tick-scaled 997/1003). Fill-lot assertions (100/400 and 100/250/50) are a test gap, not an algorithm gap. |
| `~/repos/dfba-pinocchio` | Pinocchio **toy matcher** (Archer `toy-dfba` demo). Dual auctions + maker/taker. No vault, margin, funding, or liquidations. `Vec`/`std`, 8-byte shank discs, authority-gated crank. | **Algorithm lesson only.** Keep dual auctions and the demo loop (always-on maker + crank + clear UI). **Do not** clone first-max tie-break (fails paper bid: toy 9.9 vs paper 9.97), maker leftover allocation (`maker_fill_volume = remaining_volume` → 0 when takers absorb the match), silent queue-full drop, shank discs, or “matcher is the whole product.” |
| Stellars Finance grant (Google Doc) | Stellar/Soroban GLP-style LP-pool perps: `open_position` / `close_position` at DIA+Reflector. Not DFBA, not an order book, not Pinocchio. | **Ops completeness checklist only.** Steal indexer/keepers/frontend/funding/liq/oracle-ops/audit shape. Do **not** adopt GLP, LP-as-counterparty, or oracle-priced execution. |

```mermaid
flowchart TB
  subgraph refs [References]
    Jump[Jump DFBA paper]
    Toy[dfba-pinocchio toy]
    Stellars[Stellars grant]
  end
  subgraph mgk [mgk product]
    Core[perps-core vault portfolio settle liq]
    Matcher[perps-matcher dual volume-max]
    Oracle[oracle funding index only]
    Ops[indexer keeper trade UI]
  end
  Jump -->|normative matching| Matcher
  Toy -->|reject clear/alloc bugs| Matcher
  Toy -->|demo loop UX| Ops
  Stellars -->|ops checklist| Ops
  Matcher --> Core
  Oracle --> Core
```

**Algorithm keep / reject vs the Pinocchio toy**

| Topic | Toy | mgk | Verdict |
|-------|-----|-----|---------|
| Dual uniform auctions | Yes | Yes | **Keep** (paper) |
| Volume-max + “no better unmatched” | First-max after ascending sort; **fails paper bid** | Volume-max; Bid prefers higher / Ask prefers lower; **passes paper example** | **Keep mgk** |
| Allocation | Taker groups; all eligible makers share leftover; conservation breaks when takers absorb match | Better-than-clear full; pro-rata only at margin; `reduce_fills` conservation | **Keep mgk = paper** |
| Maker/taker user flag | Yes | Yes, default taker | **Keep** |
| Rest unfilled | Yes | Full DFBA rest | **Keep** |
| Self-trade | None | Skip same portfolio | **Keep mgk** |
| Token / margin / positions | None | Core vault, portfolio, fees, mark, liq | **mgk is the perps product** |
| CU / stack | `Vec` + `std`, 85-order queues, 8-byte shank discs | `no_std`, single-byte discs, cap 64, heap scratch | **Keep mgk** |
| Queue full | Silent success, drop the order | Cap selection; rest overflow to next batch | **Keep mgk** |
| MM cancel+repost ix | Atomic `cancel_all_and_post_new_orders` | Separate cancel + post | **Not v1** (two txs enough until an MM bot needs one ix) |
| Batch cadence | `last + interval` | Collecting → Clearing → Settled | **Keep mgk** |
| Crank auth | Authority signer | Permissionless close/clear/settle | **Keep mgk** |

## Key Components & Responsibilities

### Core Program (`mgk-perps-core`)

- Portfolio / deposit / withdraw (SOL vault PDA)
- Batch lifecycle: **Collecting → Clearing → Settled** (then next Collecting)
- Order post path: margin check, lock free collateral for worst-case, CPI or book-owner place on matcher book
- Immediate cancel / modify resting orders
- Clear orchestration: CPI to matcher with book + eligible orders; apply fill receipts to positions
- Settle: fees, funding accrual, open next batch, persist mark / `liq_paused`
- Liquidation path (gated on valid mark)
- Pause flags, governance params, instrument registry

### Matcher Program (`mgk-perps-matcher`)

- Persistent resting book (four logical legs for DFBA: maker-buy, maker-sell, taker-buy, taker-sell — or two sides × role flag)
- **DFBA clear:** collect under cap → dual `compute_clearing` → single `compute_allocation` → fill receipts (no double recompute)
- Self-trade prevention (same portfolio cannot fill against itself)
- Does **not** hold funds; returns `FillReceipt[]` + book mutations
- Stack discipline: `#[inline(never)]`, fixed scratch, unit-tested buffer layout

### Oracle (`mgk-oracle` + multi-venue index)

- Multi-venue fair value for **index** used in funding only
- Optional admin fallback for index when multi-venue stale (does **not** become mark)
- Freshness checks on index reads for funding; never used to set mark or as sole liquidation mark

### Keepers

| Role | Duty | Incentive |
|------|------|-----------|
| Batch crank | Close collecting when window criteria met; clear; settle | Share of taker fees (~10% of batch taker fees, governance) |
| Liquidator | Call `LiquidateUser` when mark valid and portfolio under MM | ~2.5% of liquidated notional |
| Index oracle keeper | Post multi-venue index | Keeper fee / ops |
| Indexer | Parse events + account state | Off-chain product |

**Removed:** pre-signed reveal relayer (no commit-reveal).

### Safety stack

Unchanged structure: liquidation optimizer → insurance fund (base/quote inventory) → ADL.
**Gate:** `LiquidateUser` rejects if `!mark_valid` (no dual clear this settled batch / no valid DFBA mid). Trading and cancels may continue when `liq_paused`.

## Batch Lifecycle

```
     PostOrder / Cancel / Modify
              │
              ▼
   ┌──────────────────┐   close_collecting    ┌─────────────┐   clear_batch    ┌──────────┐
   │   COLLECTING     │ ───────────────────► │  CLEARING   │ ───────────────► │ SETTLED  │
   │  open posts      │   (permissionless     │  DFBA dual  │  settle_batch    │ mark set │
   │  full rest book  │    crank when window) │  auction    │                  │ next open│
   └──────────────────┘                       └─────────────┘                  └──────────┘
```

### Collecting

- Status `Collecting`. Users post limit orders with `is_maker` (default **false** = taker), side, price, qty, reduce_only.
- Resting book already holds unfilled makers/takers from prior batches.
- Immediate `CancelRestingOrder` / `ModifyRestingOrder` allowed (if trading not paused).
- Window closes when **dynamic criteria** met (permissionless `CloseCollecting`):

| Parameter | Near-slot stress (D1) | Working-devnet live | Notes |
|-----------|------------------------|---------------------|-------|
| `t_batch_min_slots` | 1 | **2** | Earliest close |
| `t_batch_target_slots` | 2 | — (live uses min/max) | Stress ~0.8s at 400ms slots |
| `t_batch_max_slots` | 4 | **150** (~60s) | Force close. Humans and Phantom cannot post into a 1.6s window. |
| `n_min_orders` | 0 | **1** | Optional; 0 = time-only |

**D1 split (2026-08-20):** `1/2/4` remains the near-slot **stress target** for CU/keeper benches. Working-devnet stays human-usable (`t_min=2`, `t_max=150`, `n_min=1` as in `tools/init-protocol.js`). Do not retune live to 1.6s to “match D1.”

Close rule: `(slot_age >= t_batch_min AND (n_orders >= n_min_orders OR n_min_orders == 0)) OR slot_age >= t_batch_max`.

### Clearing

- Crank calls `ClearBatch` (may be one ix or core+matcher CPI pair in one tx).
- Matcher:
  1. **Select** up to `per_batch_order_cap` orders per auction side pair under § Overflow rule
  2. **Bid auction** then **ask auction** (or simultaneous in one pass): volume-max uniform price
  3. **Allocate** once; emit fill receipts
  4. **Update** resting qty; fully filled orders removed
- Core applies receipts: positions, fees, free collateral unlock/relock.

### Settled

- Persist `last_bid_clear`, `last_ask_clear`, `matched_bid_qty`, `matched_ask_qty`
- If both clears usable: `mark = (bid_clear + ask_clear) / 2`, `mark_valid = true`, `liq_paused = false`
- Else: `mark_valid = false`, `liq_paused = true` (trading continues unless trading paused)
- Accrue funding using mark (if valid) vs index (if fresh); else skip/hold per § Funding
- Open next batch (`batch_id++`, status Collecting)

## DFBA Matching Algorithm

### Roles

- **Maker** (`is_maker = true`): provides liquidity; free of taker fee in v1.
- **Taker** (`is_maker = false`, default): seeks immediacy; pays `taker_fee_bps` on filled notional at clear price.
- Role is **user-designated**, not arrival-time.

### Bid auction (maker-buy × taker-sell)

- Eligible: maker buys vs taker sells (makers never match makers).
- Candidate prices = unique maker ∪ taker prices on this auction.
- At each candidate `p`, bid volume = makers with `price >= p` vs takers with `price <= p`; matched = `min(maker_vol, taker_vol)`.
- Choose uniform `clearing_price` maximizing matched base qty (Jump DFBA: no unmatched orders at better prices). Equal-volume **tie-break: higher price** (paper bid example: 9.97 over 9.9).
- All fills at `clearing_price`.

Code: `programs/perps-matcher/src/state/dfba.rs` `compute_clearing_into`. This is **volume-max over candidates**, not a CLOB two-pointer walk.

### Ask auction (maker-sell × taker-buy)

- Symmetric: makers with `price <= p` vs takers with `price >= p`. Equal-volume **tie-break: lower price** (paper ask example: 10.03).

### Allocation

1. Fill better-than-clear prices fully (price priority).
2. At marginal price: **pro-rata by size**, each order fill `min(remaining, pro_rata_share, marginal_size_cap)`.
3. **Round down** fractional pro-rata; residual dust unmatched (protocol; non-extractable).
4. **Self-trade:** skip pairs where maker and taker resolve to the same portfolio PDA; do not fill either leg against each other (re-run residual against next eligible counterparty or leave unmatched).
5. Conservation: `sum(maker fills) == sum(taker fills) == matched_qty - dust`.

### Overflow / per-batch cap (D2, D8)

- `per_batch_order_cap` (default **64**, governance; max **128** for scratch sizing) bounds **eligible orders per clear instruction** for the combined dual-auction work.
- **Selection:** include orders by **price priority** (best prices first for their side/role).
- **Tie-break:** larger size first, then lower `order_id`.
- Excluded orders **remain resting** for the next batch (not cancelled).
- Cap = 0 is invalid (clear rejects).

### Marginal size cap (anti size-inflation)

- Governance `marginal_size_cap` (base lots). Default **equal to no extra cap** (`u64::MAX` meaning “order size only”) — but **must not** be silently ignored in code; tests cover both capped and uncapped modes.
- When set finite: each marginal-level order fill ≤ `min(order_remaining, marginal_size_cap)`.

### Scratch / CU (engineering)

- Flat pack for clear: fixed record width (document once), e.g. `{ price: i64, size: u64, order_id: u64, portfolio: Pubkey or seat_idx }`
- Four regions: maker_buy | maker_sell | taker_buy | taker_sell
- **Unit-test region offsets** before any portfolio write
- `#[inline(never)]` on clear entry; fixed `MaybeUninit` scratch; no large stack arrays
- CU gate: mgk spike must show full dual clear + alloc + receipt encode ≤ comfort target at configured cap (target **≤ ~200k CU** comfort for clear path alone where possible; hard **≤ 1.4M** for whole tx)

## Mark, Index, Funding

### Mark (pure DFBA)

```
if bid_auction.matched_qty > 0 AND ask_auction.matched_qty > 0:
    mark = (bid_clearing_price + ask_clearing_price) / 2
    mark_valid = true
else:
    mark_valid = false
    // mark field retains last valid mid for display only; NOT used for liq
```

**D6 locked:** only the **current** settled batch’s dual clear validates mark. No “last mid for N slots” for liquidations in v1.

**Display when `!mark_valid`:** last valid mid + explicit “liquidations paused.” Never use last mid for `LiquidateUser`.

**Leftover (working-devnet should-do):** first batch with `!mark_valid` can still seed `instrument.mark_price` via `compute_mark_price` (book/oracle blend) in `settle_batch.rs`. Liquidations stay gated on `mark_valid`, but the seed contradicts “dual mid or carry-forward / zero.” Stop seeding.

### Index

- Multi-venue aggregated fair value (4 CEX venues), nonce-sequenced posts.
- Used **only** for funding index and UI reference — never mark, never liquidation mark.

### Funding (D7)

- When `mark_valid` and index fresh (`slot_age <= max_index_staleness_slots`):
  `funding_rate = clamp( (mark - index) / index * k , -max_rate, +max_rate )` over `funding_interval_slots`
- When index stale: **skip funding accrual** this interval (positions unchanged); trading continues.
- When `!mark_valid`: **skip funding accrual** (no auction mid).
- Checked i128 math; protocol-favorable rounding on fee legs.
- Precise `k` and clamps stay governance (non-blocking).

**Leftover (working-devnet should-do):** shipped `funding.rs` still computes Bulk.Trade SMA of book bid/ask premium vs oracle (`delta = max(P_bid − P_oracle, 0) − max(P_oracle − P_ask, 0)`). Skip-when-`!mark_valid` / stale-index is already correct. Replace SMA with D7 `f(mark − index)` before treating funding as spec-complete. Do not ship SMA as if it were the locked design.

## Data Models

### Portfolio (Core) — retained shape

```rust
struct Portfolio {
    user: Pubkey,
    equity: i128,
    principal: i128,
    pnl: i128,
    im: u128,
    mm: u128,
    free_collateral: i128,
    health: i128,
    positions: [Position; MAX_POSITIONS],
    last_funding_checkpoint: [i128; MAX_INSTRUMENTS],
    open_order_count: u16,
    last_batch_id: u64,
    last_slot: u64,
    // ...
}

struct Position {
    instrument_id: u16,
    qty: i64,          // signed base
    entry_vwap: i64,
}
```

### Batch (Core) — DFBA

```rust
struct Batch {
    batch_id: u64,
    status: BatchStatus,           // Collecting | Clearing | Settled
    collecting_opened_slot: u64,
    close_slot: u64,
    order_count: u32,
    per_batch_order_cap: u32,      // snapshot of governance at open (optional)
    last_bid_clearing_price: i64,
    last_ask_clearing_price: i64,
    matched_bid_qty: u64,
    matched_ask_qty: u64,
    mark_price: i64,               // mid if valid else 0 or last display
    mark_valid: bool,
    liq_paused: bool,
    total_fills: u32,
    total_taker_fees: u64,
    // removed: reveal deadlines, shuffle_seed, commitment counters, slash totals
}

enum BatchStatus {
    Collecting = 0,
    Clearing = 1,
    Settled = 2,
}
```

### Resting order (Matcher book)

```rust
struct RestingOrder {
    order_id: u64,
    user: Pubkey,              // portfolio owner
    instrument_id: u16,
    side: Side,                // Buy | Sell
    is_maker: bool,
    price: i64,
    qty: u64,
    filled_qty: u64,
    reduce_only: bool,
    batch_placed: u64,
    // book linkage...
}
```

Book remains price-ordered per side; **role flag** partitions legs for dual auction without requiring four separate books (implementation may use two books + flag or four lists).

### Instrument

```rust
struct Instrument {
    instrument_id: u16,
    // ... tick/lot/IMR/MMR ...
    taker_fee_bps: u16,        // default 5
    maker_fee_bps: i16,        // 0 in v1 (makers free). Live leftover: -2 rebate — retune to 0.
    // multi-venue index account address / feed id
    cum_funding: i128,
    last_funding_ts: i64,
    funding_interval_slots: u64,
    is_active: bool,
}
```

### Registry / governance params (new or extended)

```rust
struct BatchParams {
    t_batch_min_slots: u16,      // stress 1; live 2
    t_batch_target_slots: u16,   // stress 2; live unused
    t_batch_max_slots: u16,      // stress 4; live 150
    n_min_orders: u32,           // stress 0; live 1
    per_batch_order_cap: u32,    // 64
    marginal_size_cap: u64,      // u64::MAX = order-size only
    taker_fee_bps_default: u16,  // 5
    max_index_staleness_slots: u64,
}
```

### Removed from v1 design

- `Commitment` PDA and slash lifecycle
- `RevealedOrder` intermediate
- Fisher-Yates shuffle state
- Structural priority queues (cancels/ALO/regular for batch match)
- `FlowQualityScore` (toxic-taker deferred)
- Reveal relayer

### Fill receipt (CPI result)

```rust
struct FillReceipt {
    order_id: u64,
    user: Pubkey,
    instrument_id: u16,
    side: Side,
    is_maker: bool,
    fill_qty: u64,
    fill_price: i64,       // auction clearing price
    fee_paid: u64,         // 0 for makers
    auction: AuctionSide,  // Bid | Ask
}
```

## API / Interface Contracts

### Core instructions (shipped discs — `programs/perps-core/src/entrypoint.rs`)

Document **shipped** numbers. Do not reuse 4/5 for PostOrder without a breaking redeploy.

| Disc | Instruction | Notes |
|------|-------------|--------|
| `0` | Initialize | Registry |
| `1` | InitPortfolio | |
| `2` | Deposit | |
| `3` | Withdraw | Margin check |
| `4` | CommitOrder | **Retired stub.** Occupies this disc. |
| `5` | RevealOrder | **Retired stub.** Occupies this disc. |
| `6` | CloseCommitting | Permissionless close of Collecting (CloseCollecting alias). |
| `7` | ClearBatch | Permissionless; CPI DFBA clear |
| `8` | SettleBatch | Funding, mark, open next |
| `9` | LiquidateUser | Requires `mark_valid` |
| `10` | AddInstrument | Governance |
| `11` | CancelRestingOrder | Immediate |
| `12` | ModifyRestingOrder | Immediate; margin re-check |
| `13` | CancelAllRestingOrders | |
| `14` | SetPauseFlags | trading / withdraw / liq / funding / clear / post |
| `15` | InitVault | |
| `16` | CreateBatch | |
| `17` | SetBatchCounter | |
| `18` | CreatePortfolio | |
| `19` | InitPortfolioForUser | |
| `20` | **PostOrder** | Replaces Commit+Reveal. Args: instrument, side, price, qty, `is_maker`, reduce_only |
| `21` | **SetBatchParams** | Governance |

Index posts live on the **oracle program**, not a core `PostMultiVenuePrice` disc.

### Matcher instructions (shipped — `programs/perps-matcher/src/entrypoint.rs`)

| Disc | Instruction | Notes |
|------|-------------|--------|
| `0` | ComputeClearing | Legacy CLOB helper |
| `1` | CancelResting | |
| `2` | ModifyResting | |
| `3` | ClearAndMatch | Legacy CLOB match |
| `4` | CancelAll | |
| `5` | **DfbaClear** | Dual auction + allocate + book update; fill receipts |
| `6` | **PlaceResting** | Called via core on PostOrder |
| `7` | **InitializeBook** | Book PDA |

### Pause flags

Independent bits: `PAUSE_POST`, `PAUSE_CLEAR`, `PAUSE_WITHDRAW`, `PAUSE_LIQUIDATE`, `PAUSE_FUNDING`, `PAUSE_TRADING` (umbrella if needed).
No reveal-specific flag.

### Auth

- User signer: post / cancel / modify / deposit / withdraw
- Permissionless: close / clear / settle / liquidate / post index (registered keepers for index)
- Governance: params, pause, instruments

## Events & Indexer (data pipeline)

> Aligns with data-pipeline skill non-negotiables: idempotent writes, slot on every row, backfill path.

### Events (program logs / self-CPI buffer)

**D9 (2026-08-20):** formal `BatchCleared` / `Fill` program events are **deferred** for working-devnet. Indexer v1 continues log + account decode (`backfill.ts` + boot backfill already exist). Events are a mainnet-hardening item, not a matching-correctness item.

| Event | Fields (min) |
|-------|----------------|
| `OrderPosted` | batch_id, order_id, user, instrument, side, is_maker, price, qty, slot |
| `OrderCancelled` / `OrderModified` | order_id, user, new_qty, slot |
| `BatchClosed` | batch_id, close_slot, order_count |
| `BatchCleared` | batch_id, bid_clear, ask_clear, matched_bid_qty, matched_ask_qty, mark, mark_valid, liq_paused, slot |
| `Fill` | batch_id, order_id, user, auction, fill_qty, fill_price, is_maker, fee, slot |
| `BatchSettled` | batch_id, next_batch_id, slot |
| `FundingAccrued` / `FundingSkipped` | instrument, rate or reason, slot |
| `Liquidation` | user, reductions…, slot |
| `LiqPaused` | instrument or global, reason, slot |

### Indexer design

| Choice | v1 |
|--------|-----|
| Ingestion | WebSocket `logsSubscribe` / `onLogs` on core+matcher program IDs; optional accountSubscribe on Batch + Book PDAs |
| Storage | SQLite (existing mgk indexer) or Postgres later |
| Idempotency | Unique key `(signature, event_index)` or `(slot, tx_index, log_index)` |
| Backfill | Slot-range getSignaturesForAddress + reparse (`apps/indexer/src/backfill.ts` + boot backfill shipped; lag/health remaining) |
| Queries | Latest mark/mark_valid, dual clear prices, order book by role, fills, portfolio |

**Do not** rely on enhanced third-party “SWAP” parsers for DFBA — custom decode of single-byte discriminators.

## Component Breakdown

| Layer | Path | DFBA change |
|-------|------|-------------|
| Core batch state | `programs/perps-core/src/state/batch.rs` | Collecting/Clearing/Settled; dual clear fields; drop reveal |
| Core instructions | `commit_order` / `reveal_order` → `post_order` | Rewrite |
| Clear path | `clear_batch.rs` + matcher CPI | DFBA dual auction |
| Matcher | `programs/perps-matcher/src/state/dfba.rs` | Dual volume-max + allocate_side (shipped) |
| Mark | `mark_price.rs` | Pure mid; liq gate |
| Book | `book.rs` | Persist role flag; price-ordered |
| Frontend / SDK | follow-on | Single-tx post; show bid/ask clear + mark_valid |
| Indexer | `mgk-frontend/apps/indexer` | New events |

## Design Decisions

### Product decisions (from requirements — locked)

| # | Decision | Choice |
|---|----------|--------|
| A | Collection | Open posts; no commit-reveal |
| 2 | Roles | User-designated; default taker |
| 3 | Cadence | Governance window; defaults below |
| 4 | Rest | Full DFBA rest |
| 5 | Depth | Hard cap; single-ix clear |
| 6–7 | Mark | Dual mid only; else liq pause |
| 8 | Oracle | Index/funding only |
| 9 | Fees | Taker flat bps; maker free |
| 10 | Cancel/modify | Immediate |
| 11 | Toxic-taker | Deferred |
| 13 | Self-trade | Prevent |

### Design parameters settled (D1–D10)

| ID | Parameter | Choice | Rationale |
|----|-----------|--------|-----------|
| D1 | Batch slots | Stress **1/2/4**; working-devnet **2/150/`n_min=1`** | Stress for CU benches. Live window must be human-usable. |
| D2 | `per_batch_order_cap` | **64** default (max 128 scratch) | CU headroom until **on-chain** spike at cap 64 (comfort ≤200k / hard 1.4M). Host timing is not that measurement. Raise only after measured. |
| D3 | Fees | Taker **5** bps; maker **0** bps (free) | Requirements. Live `makerFeeBps = -2` is leftover — retune to 0. Optional rebate is post-v1. |
| D4 | Dust | Round-down-to-protocol | Conservation; non-extractable |
| D5 | State machine | Collecting → Clearing → Settled | Minimal |
| D6 | Mark validity | **Current dual clear only** | Matches requirements product intent |
| D7 | Funding | `clamp(((mark − index) / index) * k, ±max)`; skip if !mark_valid or index stale | Safe. Shipped SMA of book premium vs oracle is leftover — replace. |
| D8 | Overflow | Best price first; size; order_id | Explicit, fair |
| D9 | Events | Formal `BatchCleared` / `Fill` **deferred** for working-devnet | Indexer v1 continues log/account decode. Events are mainnet-hardening, not matching-correctness. |
| D10 | Migration | Retire commit/reveal; rewrite matcher clear; keep portfolio/vault/liq stack | Incremental where safe |

### Alternatives considered (design)

| Topic | Options | Chosen |
|-------|---------|--------|
| Clear location | All in core vs matcher CPI | **Matcher CPI** — keeps custody isolation; heavy math off vault program |
| Cap unit | Per side vs global | **Global cap on clear work** with price-priority selection across legs |
| IOC takers | Default IOC vs full rest | **Full rest** (requirements) |
| Last-good mark for liq | N-slot grace | **Rejected** for v1 |
| Market model | DFBA order book vs Stellars GLP/LP-pool | **DFBA** (user-locked 2026-08-20). Stellars is ops checklist only. |
| Maker rebate | 0 vs live −2 vs optional rebate | **0 bps** in v1. Live −2 leftover. Rebate post-v1. |
| Matching source | Jump paper vs Pinocchio toy | **Jump paper.** Toy is a buggy subset (fails paper bid 9.97). |

### Security (DeFi checklist applied)

- Checked arithmetic on all notional, fee, funding, margin paths
- Rounding: fees round up to protocol; pro-rata fills round down; dust stays unmatched
- Slippage: every order has limit price enforced at clear (taker/maker limits)
- Checks-effects-interactions on CPI: book/fill effects before any external interaction; core applies fills after matcher returns
- Account owner + signer validation on every ix
- Emergency pause (post/clear/withdraw/liq/funding)
- Liquidations cannot run on invalid mark (oracle manipulation of mark removed by design)
- Index freshness for funding only — stale index does not invent mark
- Formal targets: conservation, makers-only-match-takers, uniform price bound, self-trade free, mark_valid ⇒ dual clear

## Non-Functional Requirements

| Area | Target |
|------|--------|
| Clear CU | Dual clear+alloc at cap=64 within measured budget; document spike results |
| Stack | Zero SBF stack overflow at build |
| Latency | Collection target ~1–2 slots; p50/p99 crank lag measured on devnet |
| Availability | Permissionless crank; missed slot → next slot |
| Indexer lag | Sub-500ms p99 query for latest batch/mark when RPC healthy |
| Tests | Unit DFBA paper example vectors (clearing shipped; fill lots 100/400 and 100/250/50 remaining); allocation pro-rata; self-trade; cap overflow; mark/liq gate; conservation |

## Requirements Coverage Matrix

| Requirements goal / story | Design coverage |
|---------------------------|-----------------|
| Fully on-chain DFBA | § DFBA Matching + lifecycle |
| No commit-reveal | Retired ix; PostOrder |
| User maker/taker default taker | RestingOrder.is_maker; PostOrder args |
| Full rest | Unfilled remain on book |
| Dual uniform clears | Bid/ask auctions |
| Pure DFBA mark + liq pause | § Mark; LiquidateUser gate |
| Index/funding only oracle | § Funding; oracle role |
| Hard order cap | D2 + overflow rule |
| Immediate cancel/modify | Core ix 11/12 |
| Taker fee / maker free | Instrument fees + FillReceipt; live −2 leftover |
| Self-trade prevention | Allocation step 4 |
| Insurance inventory | Safety stack retained |
| Pause flags | SetPauseFlags bits |
| CU / stack lessons | Scratch + CU gate + buffer tests |
| Indexer dual clear | § Events & Indexer (formal events deferred) |
| Toxic-taker | Explicitly out (deferred) |
| Frontend dual-sign | Out — frontend feature follow-on |
| Stellars position open/close UX | Limit post + DFBA fill → position; remaining M9.8 + reduce-only |
| Stellars LP pool / staking | **Rejected** — do not add |
| Stellars oracle-priced execution | **Rejected** — mark = DFBA mid |
| Stellars DIA/Reflector median | Multi-venue index for **funding only** |
| Stellars funding (OI²) | D7 `f(mark − index)`; SMA leftover |
| Stellars liquidation keepers | `LiquidateUser` + optimizer + IF + ADL; 24/7 bot remaining |
| Stellars indexer + API | SQLite + WS + boot backfill; lag/health remaining |
| Stellars ConfigManager | Registry + SetBatchParams + pause — shipped |
| Stellars audit / gradual rollout | Mainnet bar only |

## Migration Notes (implementation)

On-chain DFBA path (PostOrder disc 20, `dfba.rs` dual clear, Collecting→Clearing→Settled, `mark_valid` liq gate) is **shipped on M9 programs**. Do not re-implement matching. Remaining work is the appendix below.

Historical steps (done): freeze commit-reveal features; add PostOrder + role flag; DFBA matcher clear; rewrite batch status; SDK encoders; indexer log decode.

Still open from this list: on-chain CU spike at cap 64 (mainnet bar); formal events (mainnet); frontend/ARCHITECTURE commit-reveal rewrite (working-devnet should-do / mainnet).

## Open items (non-blocking for design approval)

| Item | Owner |
|------|--------|
| Exact CPI account list / remaining accounts layout for ClearBatch | Implementation (shipped; keep in sync with entrypoints) |
| Precise funding `k` and clamp constants | Governance + implementation |
| Whether PostOrder is core-only with matcher CPI place, or two client ixs | Shipped: one user tx (`PostOrder=20` CPI place) |
| Display mark when !mark_valid | **Locked 2026-08-20:** last valid mid + explicit “liquidations paused” |

## Remaining work

On-chain DFBA path is already on **devnet** (M9.0–M9.6): PostOrder, dual clear, settle mark, liq gate, pause flags, funding skip, keeper crank, scripted dual-fill (`tools/trade-e2e.js`, `mark_valid=1`). Live program IDs: core `C7w2mKz2KQgDroNNhACm9MutXhPiesVr9Gn2x8TDsRYx`, matcher `7WiZuunbPGciCedsVTguvjezwwzrhmXG5HkdCuHizbNC`, oracle `CsSqVZMoXixNYstNhTtixeT4pyRgrYnXdpfoXQBgFPqZ`.

This appendix is the source of truth for “working DEX on devnet” vs “mainnet.” Matching is **not** remaining work.

### Working-devnet bar (“traders can use a perps DEX on devnet”)

Must-do:

1. **M9.9 two-wallet fill proof** — independent counterparties, same Collecting batch, crossing prices, Clear→Settle, fills + fees + `mark_valid`. Method: **playwright-cli named sessions** (`-s=maker`, `-s=taker`, optional `-s=observer`) against live M9 programs at local `/trade`. Injected live-signing wallets from distinct keypair paths (`~/.config/solana/mgk-trader-{maker,taker}.json`). Four posts so both DFBA auctions fire (maker two-sided quote + two crossing taker posts). Keeper is `node tools/keeper-crank.js`, not a browser persona. Not Playwright MCP. Not Phantom-extension popups. Not `pnpm e2e:wallet`. Same-wallet smoke only proves self-trade skip. Planning: T9.9.1 first.
2. **M9.8 browser lifecycle** — connect → deposit → post (maker and taker) → rest/fill visible → position/PnL → cancel/modify → withdraw. Truthful `mark_valid` / liq-paused copy; no leftover commit-reveal language.
3. **Retune maker fee to 0 bps** — **Done 2026-08-20 (T9.10.1).** Live `Hz9UtmSX…` maker 0 / taker 5 via disc 22.
4. **24/7 keeper + liquidator** — **Done 2026-08-20 (T9.10.2).** `tools/ops-keeper.js` deadline-gated crank + LiquidateUser + `/healthz`. Live flatten `3WDbtrsw…` on taker `8SWub3A3…` using current settled batch 13 `mark_valid=1` (D6).
5. **Index keeper reliability** — multi-venue index posts stay fresh enough for funding skip policy to be honest.
6. **Indexer health** — boot backfill exists (`mgk-frontend/apps/indexer/src/backfill.ts`); add lag/health so the UI is not a silent stale book.

Should-do on the same path (product-correct, not matching-core):

7. **Replace SMA funding with D7 `f(mark − index)`**. Skip-when-invalid already shipped.
8. **Stop seeding mark from book/oracle** on first `!mark_valid` settle.
9. **Frontend requirements amendment** for DFBA (follow-on feature doc: `docs/ai/design/2026-06-16-feature-mgk-frontend.md` still commit-reveal).
10. **Reduce-only / flatten UX** sufficient to close a position from the trade page.
11. **Paper fill-lot unit tests** — assert bid 100/400 and ask 100/250/50 (clearing already tested).

Explicitly **not** required to call devnet “working”: Kani, formal events, Squads, audit, cap>64, atomic MM replace, GLP/LP, commit-reveal, Stellars oracle-priced fills.

### Mainnet bar (requirements already: no mainnet pre-audit)

- Independent security review / audit
- Squads/multisig upgrade authority (design: single admin until then)
- Canonical program IDs (placeholders in `program_ids.rs` today vs live M9 IDs)
- Bug bounty, incident runbook, RPC/indexer HA
- On-chain CU spike at cap 64; raise cap only after that
- Formal events if indexers need them
- Kani proofs (secondary)
- Public `docs/ARCHITECTURE.md` + grant narrative rewritten for DFBA (still commit-reveal)
- Do not ship commit-reveal remnants, maker-rebate mismatch, or SMA-vs-spec funding as if they were the locked design

## See also

- Requirements: `docs/ai/requirements/2026-06-18-feature-onchain-perps-dex.md`
- DFBA paper (normative matching): https://jumpcrypto.com/resources/dual-flow-batch-auction
- Pinocchio toy (lesson only, not original DFBA): `~/repos/dfba-pinocchio`
- Engineering lessons: requirements § On-chain DFBA engineering lessons
- Historical: this file’s pre-2026-08-02 commit-reveal design (replaced in place)
- RFQ alternative (inactive): `feature-onchain-perps-dex-rfq.md`
- Stale public story (out of this phase): `docs/ARCHITECTURE.md`, grant proposal, frontend requirements still describe commit-reveal.
