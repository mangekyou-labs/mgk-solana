---
phase: design (DRAFT — for consideration only)
title: On-Chain Perpetuals DEX Design — Continuous CLOB + RFQ
description: Continuous CLOB with registered-MM RFQ layer, price-time matching, M8 oracle suite, and Solana-native MEV protection
---

> **Status:** Draft. Not approved. Kept separate from `feature-onchain-perps-dex.md` which remains the baseline.
> **Original design:** Commit-reveal batch CLOB. This document explores replacing it with continuous CLOB + RFQ.

# On-Chain Perpetuals DEX Design — Continuous CLOB + RFQ

## Motivation

The original commit-reveal batch CLOB was designed for a Solana-based perps DEX where MEV protection was achieved through hash commitment and batch shuffling — replicating Bulk.Trade's approach without on-chain consensus.

However:
- Solana's 400ms block time + parallel execution enables **continuous matching** without batching.
- Commit-reveal adds ~2 transactions per order (commit + reveal) + batch latency (~seconds), creating UX friction and limiting throughput.
- Bulk.Trade operates on a **custom chain** where consensus is the MEV layer. On Solana, MEV is already partially addressed by priority fees and fast finality.
- Solana's stated direction: *"Real price discovery — price set by two-sided flow, orderbooks, RFQ, genuinely competing makers."*
- Protocols like Hyperliquid and institutional perps desks combine **continuous CLOB** (for retail) with **RFQ block trading** (for large orders) — this hybrid model has proven long-term.

This document proposes: **continuous CLOB + registered-MM RFQ layer**, removing batch commit-reveal entirely.

## Architecture Overview

A fully on-chain perpetual futures exchange on Solana using a **continuous CLOB** with **price-time priority matching** and a **registered market-maker RFQ layer**. Matching is real-time — no batch cadence, no commit-reveal, no shuffle. MEV protection via Solana priority fees + registered keeper fast-inclusion.

```mermaid
graph TD
    subgraph Users
        RETAIL[Retail Trader]
        MM[Registered Market Maker]
    end

    subgraph "On-Chain Programs"
        CORE[Core Program<br/>Portfolio Mgmt<br/>CLOB State<br/>Funding Accrual<br/>Mark Price<br/>RFQ Registry<br/>Custody]
        MATCH[Matching Engine<br/>Continuous CLOB<br/>Price-Time Priority<br/>Self-Trade Prevention<br/>Risk Callbacks<br/>Toxic-Taker Scoring]
        FALLBACK[Fallback Oracle<br/>Auto-activate on Pyth staleness<br/>Admin override]
    end

    subgraph External
        PYTH[Pyth Oracle<br/>Pull-model price feeds<br/>BTC, ETH, SOL index prices]
        MULTIV[MultiVenuePrice<br/>4 CEX venues aggregated<br/>Fair value + nonce]
    end

    subgraph "Permissionless Keepers"
        LIQ[Liquidator<br/>Hedge-preserving optimizer<br/>ADL as last resort]
        ORACLE_KEEPER[Oracle Keeper<br/>CEX book watcher<br/>PostMultiVenuePrice ~100ms<br/>Nonce-sequenced signed txs]
    end

    subgraph "Safety Stack"
        OPTIMIZER[Liquidation Optimizer<br/>Hedge-preserving reduction<br/>Impact-ratio ranking]
        INSURANCE[Insurance Fund<br/>Fee-accrued<br/>Base/quote inventory<br/>Absorbs bad debt]
        ADL[Auto-Deleveraging<br/>Deleverage profitable counterparties<br/>Pro-rata by score]
    end

    RETAIL -->|place / cancel / modify order| CORE
    MM -->|place / modify quote| CORE
    MM -->|PostMultiVenuePrice| MULTIV
    CORE -->|submit_order| MATCH
    MATCH -->|fills + rest| CORE
    CORE -->|update_positions + accrue_funding| CORE
    CORE -->|pull Pyth price| PYTH
    CORE -.->|auto-fallback if Pyth stale| FALLBACK
    CORE -->|read MultiVenuePrice| MULTIV
    LIQ -->|liquidate_user| OPTIMIZER
    OPTIMIZER -->|market sweep against book| MATCH
    ORACLE_KEEPER -->|PostMultiVenuePrice<br/>(signed tx, nonce)| MULTIV
    MULTIV -.->|freshness-weighted blend<br/>mark price source| CORE
```

**Three-program separation preserved:** Core (custody + portfolio) / Matching (compute) / Oracle (data). Same as original.

**Key change from original:** No batch lifecycle. No commit-reveal. No Fisher-Yates shuffle. Matching is continuous and real-time.

## Continuous CLOB vs Batch Commit-Reveal

| Aspect | Original (Batch Commit-Reveal) | This Design (Continuous CLOB + RFQ) |
|--------|-------------------------------|-------------------------------------|
| Matching latency | Seconds (batched) | Milliseconds (continuous) |
| Order flow | Commit → Reveal → Clear → Settle | Place → Match immediately |
| MEV protection | Hash commitment + shuffle | Priority fees + fast finality |
| UX | 2-tx flow (commit + reveal) | 1-tx flow (place order) |
| Order types | GTC (across batches), IOC, ALO | GTC, IOC, ALO, Market, RFQ |
| Price discovery | Batched CLOB | Continuous CLOB + RFQ |
| CLOB persistence | GTC orders persist across batches | All orders persist until filled/cancelled |
| Throughput | 64 orders/batch max | Continuous — no per-batch cap |

## Key Components & Responsibilities

### Core Program
- **Portfolio management**: Cross-margin account tracking SOL deposits, positions, and PnL per user
- **CLOB state owner**: Owns order book accounts, manages resting order lifecycle (place, cancel, modify)
- **RFQ registry**: Tracks registered market makers, their authorized instruments, and quoting status
- **Collateral vault**: PDA-controlled SOL vault, deposit/withdraw with margin checks
- **Custody**: Only program authorized to move user funds
- **Mark price computation**: Freshness-weighted composite of CLOB mid + MultiVenuePrice + Pyth fallback
- **Risk engine**: Pre-fill margin check — reject order if insufficient margin before matching

### Matching Engine Program
- **Continuous CLOB matching**: Price-time priority. Aggressive orders (market, IOC, limit that crosses) walk the book immediately. Passive orders (limit GTC, ALO) rest at their limit price.
- **Self-trade prevention**: When incoming order would match against same account's resting order, cancel the resting order instead.
- **Risk callbacks**: After each fill, verify position remains within margin limits. If fill would cause margin breach, cancel remainder.
- **Toxic-taker detection (M8-C)**: Per-address, per-instrument flow-quality score. Score ≤ threshold → spread widening.
- **RFQ quote handling**: MM quotes posted to the book as resting orders with MM flag. Taker hits quote → match against MM's resting order.
- **Stateful**: Persistent order book accounts (bids + asks) across all trades. GTC orders rest indefinitely.

### Oracle Layer (Pyth + M8-A MultiVenuePrice)

**Design principle unchanged:** Trading prices emerge from two-sided orderbook flow — not from an external feed. Pyth + MultiVenuePrice serve as reference anchors for funding, mark price, and liquidation. Never determine execution price.

**Primary: Pyth pull oracle**
- Pyth provides BTC/USD, ETH/USD, SOL/USD price feeds
- Pull model: Core Program reads Pyth accounts directly
- Validates freshness, confidence interval, trading status
- Role: Index price for funding rate, liquidation marking

**M8-A: MultiVenuePrice (keeper-driven, from original design)**
- Permissionless keeper watches 4 CEX venues (Binance, Coinbase, OKX, Bybit)
- Posts signed fair-value updates to `MultiVenuePrice` PDA ~100ms or threshold-triggered
- On-chain verification: signature matches registered keeper pubkey, nonce is fresh
- Replaces Pyth-only mark-price blend with multi-venue NBBO

**Fallback: Admin oracle**
- Governance can push manual price to fallback oracle
- Auto-activates on Pyth staleness or freeze
- Same `PriceFeed` struct, admin-controlled

## Order Types

| Type | Behavior | Path |
|------|----------|------|
| **Limit (GTC)** | Rests on book at specified price. Fills at maker price if hit. | CLOB |
| **Limit (IOC)** | Fills immediately against book. Unfilled remainder cancelled. Never rests. | CLOB |
| **Limit (ALO / Post-Only)** | Must rest as maker. Rejected if would cross spread and take liquidity. | CLOB |
| **Market** | Walks book until fully filled or book exhausted. | CLOB |
| **RFQ Quote** | MM posts size + price to book as a "quote order." Taker hits it. MM fills against own quote. | RFQ |
| **Reduce-Only** | Modifier on any type. Closes/reduces only, never opens. | CLOB + RFQ |
| **Cancel** | Cancels specific resting order by order ID. Immediate. | CLOB |
| **Cancel-All** | Cancels all resting orders for user in instrument. | CLOB |

### RFQ Mechanism — Private Bilateral (TrustRFQ-Inspired)

**Model:** Private bilateral RFQ, not public book quotes. MM sends quote directly to a specific taker. Quote is never visible on the public order book. Inspired by TrustRFQ's AirSwap-style settlement.

**TrustRFQ reference:** Quote is routed to taker via Supabase realtime. On-chain settlement via Soroban `fill()` with both parties' off-chain signatures binding exact terms. No allowance/approve step. Permissionless filler submits the signed fill.

**How RFQ works:**
1. MM and taker agree off-chain (UI or API) — MM sends private quote to taker's address
2. Quote is stored as a `Quote` record: `(mm, taker, instrument_id, side, price, qty, expiration, nonce)`
3. Taker accepts quote → both sign `QuoteAccept` with exact terms (same AirSwap-style `require_auth` pattern)
4. Either party (or any filler) submits `FillQuote` on-chain with both signatures
5. Core program transfers both legs atomically — maker pays maker_leg, taker pays taker_leg
6. Positions updated in Core program

**Key difference from TrustRFQ (Stellar/Soroban) vs mgk (Solana):**
- TrustRFQ uses Soroban `require_auth` + auth entries. We use Solana's `invoke_signed` + PDA signatures.
- TrustRFQ uses Supabase for quote routing. We use a Solana program-based quote registry (no off-chain dependency).
- TrustRFQ's `fill()` does atomic token transfers via SAC. Our `FillQuote` updates portfolio positions and transfers collateral via Core vault.

**Quote lifecycle:**
```
MM creates Quote (off-chain or via instruction)
    → Quote stored on-chain (encrypted or address-restricted)
    → Taker views quote (only taker can see it)
    → Taker accepts → signs accept message
    → FillQuote submitted with both signatures
    → Atomic settlement: positions + collateral transfer
```

**Quote data model (new account type):**
```rust
struct Quote {
    mm: Pubkey,
    taker: Pubkey,
    instrument_id: u16,
    side: Side,           // buy or sell
    price: i64,           // execution price
    qty: u64,             // contract size
    expiration_slot: u64,
    nonce: u64,           // replay protection
    status: QuoteStatus,  // Open, Accepted, Filled, Cancelled, Expired
    maker_amount: i128,   // for perp: collateral amount
    taker_amount: i128,   // for perp: collateral amount
    signature_mm: [u8; 64],
    signature_taker: [u8; 64],
}

enum QuoteStatus {
    Open = 0,
    Accepted = 1,
    Filled = 2,
    Cancelled = 3,
    Expired = 4,
}
```

**Quote access — open to anyone in v1:**
- Any user can post a quote to a specific taker. No registration, no bond.
- Quotes are still bilateral — addressed to a specific taker, not visible on public book.
- v2: Governance can introduce MM registration with bonds + SLA requirements for accountability.
- Toxic taker scoring (M8-C) applies to all takers regardless of registration.

**How taker receives quote:**
- **Option A (v1):** MM submits `PostQuote(taker, ...)` instruction — on-chain quote stored, only taker's address can read it (enforced by program). Taker queries program for quotes addressed to them.
- **Option B (v1):** Quote routed off-chain (REST API or similar), fill still goes through on-chain `FillQuote` instruction.
- Recommendation: Option A for v1 (fully on-chain, no extra infrastructure). Quote stored on-chain but `PostQuote` instruction requires MM signer. Program filters quotes by `taker` field.

**MM vs CLOB roles:**
- MM quotes only for large orders (above `min_quote_size` per instrument)
- Retail small orders → CLOB only
- This keeps CLOB book deep with retail flow, large block flow goes through private RFQ

**MM adverse selection protection (M8-C):**
- Toxic takers who consistently hit MM quotes get flagged
- Spread widening or quote access restrictions for flagged accounts
- MM can reject specific takers (blocklist) or set min order sizes

## Data Models

### Portfolio (Core Program) — unchanged from original

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
    last_slot: u64,
    padding: [u8; PADDING],
}
```

### Instrument Registry (Core Program) — unchanged from original

```rust
struct Instrument {
    instrument_id: u16,
    base_symbol: [u8; 16],
    contract_size: u64,
    tick_size: u64,
    lot_size: u64,
    imr_bps: u16,
    mmr_bps: u16,
    taker_fee_bps: u16,
    maker_fee_bps: i16,
    max_leverage: u16,
    oracle_addr: Pubkey,
    cum_funding: i128,
    last_funding_ts: i64,
    funding_interval_slots: u64,
    is_active: bool,
    min_quote_size: u64,       // NEW: minimum size for MM quote
    padding: [u8; PADDING],
}
```

### Order Book (Matching Engine Program) — unchanged from original

```rust
struct OrderBook {
    instrument_id: u16,
    best_bid: i64,
    best_ask: i64,
    bid_count: u32,
    ask_count: u32,
    next_order_id: u64,
    bids: [BookLevel; MAX_LEVELS],
    asks: [BookLevel; MAX_LEVELS],
    padding: [u8; PADDING],
}

struct RestingOrder {
    order_id: u64,
    user: Pubkey,
    side: Side,
    price: i64,
    qty: u64,
    filled_qty: u64,
    instrument_id: u16,
    reduce_only: bool,
    placed_slot: u64,
    next_order_offset: u32,
}
```

### Quote (Core Program) — NEW (private bilateral RFQ)

```rust
struct Quote {
    mm: Pubkey,
    taker: Pubkey,
    instrument_id: u16,
    side: Side,
    price: i64,
    qty: u64,
    expiration_slot: u64,
    nonce: u64,
    status: QuoteStatus,
    signature_mm: [u8; 64],
    signature_taker: [u8; 64],
    padding: [u8; PADDING],
}

enum QuoteStatus {
    Open = 0,
    Accepted = 1,
    Filled = 2,
    Cancelled = 3,
    Expired = 4,
}
```

### MM Registry (Core Program) — v2 only

v1: No MM registration. Anyone can post a quote to any taker. Quote privacy enforced by address targeting in `PostQuote`, not by access control.

v2: Governance can introduce MM registration with:
- Bonded MMs (economic SLA enforcement)
- Per-instrument quoting rights
- Activity requirements

```rust
struct MarketMakerRegistry {
    authority: Pubkey,           // governance
    registered_mms: Vec<Pubkey>, // list of registered MM pubkeys
    mm_instruments: HashMap<Pubkey, Vec<u16>>, // MM -> instruments they're registered for
    padding: [u8; PADDING],
}

struct MarketMakerState {
    mm_pubkey: Pubkey,
    is_active: bool,
    last_quote_slot: u64,
    total_quote_volume: u64,
    flow_quality_score: i128,    // rolling score (M8-C)
    padding: [u8; PADDING],
}
```

### Order types — modified

```rust
enum OrderType {
    LimitGTC = 0,
    LimitIOC = 1,
    LimitALO = 2,
    Market = 3,
    Cancel = 4,
    CancelAll = 5,
}
```

## API / Interface Contracts

### Core Program Instructions — Modified

| Disc | Instruction | Input | Accounts | Auth |
|------|-------------|-------|----------|------|
| `0` | Initialize | instrument_registry | payer | Governance |
| `1` | InitPortfolio | — | portfolio_pda, user, payer | User signer |
| `2` | Deposit | lamports | portfolio, vault, user_wallet | User signer |
| `3` | Withdraw | lamports | portfolio, vault, registry, user_wallet | User signer |
| `4` | PlaceOrder | order_type, side, price, qty, reduce_only | portfolio, book, registry, user | User signer |
| `5` | CancelOrder | order_id | portfolio, book, user | User signer |
| `6` | CancelAllOrders | num_books | portfolio, user, matcher_program, book_accounts[] | User signer |
| `7` | ModifyOrder | order_id, new_qty | portfolio, book, user | User signer |
| `8` | LiquidateUser | user_pubkey, num_instruments | portfolio, registry, vault, liquidator, instrument_accounts[], oracle | Permissionless (keeper) |
| `9` | AddInstrument | instrument_params | registry, instrument, oracle_feed | Governance |
| `A` | SetPauseFlags | flags(1) | registry, governance | Governance |
| `B` | PostQuote | taker, instrument_id, side, price, qty, expiration, nonce | quote_account, signer | Any user (v1) |
| `C` | AcceptQuote | quote_nonce | quote_account, taker_portfolio | Taker signer |
| `D` | FillQuote | quote_nonce | quote_account, maker_portfolio, taker_portfolio | Permissionless (both signatures) |
| `E` | CancelQuote | quote_nonce | quote_account | Quote signer |
| `F` | RegisterMarketMaker | mm_pubkey, instruments[] | registry, governance | Governance |  -- v2
| `G` | DeregisterMarketMaker | mm_pubkey | registry, governance | Governance |  -- v2

**Removed from original:** `CommitOrder`, `RevealOrder`, `CloseCommitting`, `ClearBatch`, `SettleBatch`. These batch instructions are gone.

**Key difference from original:** `PlaceOrder` is a single instruction — no commit-reveal. Order goes directly to matching engine.

### Matching Engine Program Instructions — Simplified

| Disc | Instruction | Input | Output |
|------|-------------|-------|--------|
| `0` | PlaceOrder | order, signer | fills: [(user, filled_qty, price)…], updated_book_state |

No shuffle, no priority queue separation, no batch coordination. Single instruction: receive order + signer, attempt match, return fills.

**Matching logic per order:**
1. Validate order (size, price, reduce_only)
2. Pre-fill margin check via risk callback to Core
3. Walk book (aggressive) or rest on book (passive)
4. Self-trade check — cancel resting if same account
5. Per-fill risk callback to Core — margin still valid?
6. Return fills + updated book state

### Fallback Oracle Program — unchanged from original

| Disc | Instruction | Input | Auth |
|------|-------------|-------|------|
| `0` | Initialize | instrument_id, price, confidence | Admin |
| `1` | SetPrice | price, confidence | Admin |
| `2` | SetAuthority | new_authority | Admin |
| `3` | Activate | — | Admin |
| `4` | Deactivate | — | Admin |

### RFQ Instructions (v1 — open to all)

| Disc | Instruction | Input | Auth |
|------|-------------|-------|------|
| `0` | PostQuote | taker, instrument_id, side, price, qty, expiration, nonce | quote_account, signer | Any user |
| `1` | AcceptQuote | quote_nonce | Taker signer |
| `2` | FillQuote | quote_nonce | Permissionless (both signatures required) |
| `3` | CancelQuote | quote_nonce | Quote signer (MM before accept; taker before accept) |

### MM Registry Instructions (v2)

| Disc | Instruction | Input | Auth |
|------|-------------|-------|------|
| `0` | RegisterMarketMaker | mm_pubkey, instruments[] | Governance |
| `1` | DeregisterMarketMaker | mm_pubkey | Governance |
| `2` | UpdateMMInstrument | mm_pubkey, instruments[] | Governance |

## MEV Protection

Original design used commit-reveal to hide order contents during commitment phase. With continuous CLOB, orders are submitted directly — contents visible in the tx. This section evaluates MEV protection options.

### Threat Model

| Threat | Description |
|--------|-------------|
| **Front-running** | Attacker sees order in mempool, places order ahead to move price, then closes |
| **Sandwich attacks** | Attacker wraps order with buy (front-run) + sell (back-run) in same block |
| **MM quote sniping** | Toxic takers hit MM quotes before MMs can cancel |
| **Block builder extraction** | Validator/block builder reorders txs for profit |

### Protection Options (Layered)

#### Layer 0 — RFQ (Bilateral Fill)

Large orders via RFQ bypass the public mempool entirely. MM and taker execute a direct fill instruction — no other participant sees the order until after settlement.

- **Protection level:** Highest. No mempool visibility.
- **Trade-off:** Only available for large orders. Requires registered MMs.
- **encrypt.trade model:** Uses TEE (AWS Nitro Enclaves) + ElGamal encryption for spot swaps. For perps, RFQ direct fill achieves similar privacy without TEE hardware dependency.
- **Use case:** Large orders, institutional flow.

#### Layer 1 — Priority Fees (Baseline)

Solana-native priority fee market. Users bid fees to get tx included faster.

- **Protection level:** Minimal. Only ordering within block.
- **Trade-off:** Simple, Solana-native. Doesn't hide order contents.
- **Mitigation:** Not sufficient alone for large orders.

#### Layer 2 — TEE (Trusted Execution Environment)

encrypt.trade uses AWS Nitro Enclaves for private spot swaps on Solana. For perps, TEE would mean:

**Full TEE approach:** Matching engine runs entirely inside a TEE enclave. Validator executes enclave code but cannot read order contents. Entire CLOB state encrypted at rest and in transit.

**Challenges for Solana perps:**
- Solana validators run on **heterogeneous hardware** — not all support SGX or Nitro
- Parallel execution means different validators may execute in different order — TEE benefit reduced vs single-threaded chains
- Hardware dependency adds operational complexity
- encrypt.trade's Nitro approach works for spot swaps (single aggregator, Jupiter) but is harder for a full CLOB with many participants
- Matching engine state must fit entirely in enclave memory — scaling concern

**TEE v1 recommendation:** Not recommended for perps CLOB at this stage. Revisit if:
- Solana validators standardize on TEE-capable hardware
- TEE enclaves can handle full CLOB state + throughput requirements
- A proven TEE-based perps matching engine exists

encrypt.trade reference: [encrypt.trade Private Swaps](https://docs.encifher.io/docs/private-swap-jupiter), [encrypt.trade Private Bridge](https://docs.encifher.io/docs/private-cross-chain-bridge)

### Proposed MEV Stack (This Design)

| Order Type | Protection Path | MEV Risk |
|------------|----------------|----------|
| Small retail orders (CLOB) | Priority fees + ALO | Low — not worth front-running small orders |
| Large orders (RFQ) | Direct MM fill, no mempool | None |
| MM quotes | Toxic-taker scoring + spread widening | Low |

**Rationale:** SSF encrypted mempool dropped. RFQ handles large orders with bilateral fill (no mempool). Small retail orders have minimal MEV risk — not worth the complexity of encrypted mempool infrastructure for v1.

| Threat | Mitigation |
|--------|------------|
| **Front-running** | Pre-fill margin check. ALO orders. RFQ for large. |
| **Sandwich attacks** | ALO/post-only. Self-trade prevention. |
| **MM quote sniping** | Toxic-taker detection (M8-C) + spread widening. |
| **Block builder extraction** | Encrypted mempool (v2) or priority fees. |

## Mark Price Model — unchanged from original + M8-B

Freshness-weighted composite mark price from original design is preserved:

```
oracle_freshness = 1.0 - clamp((current_slot - multi_venue.last_update_slot) / staleness_threshold_slots, 0.0, 1.0)
bias = tanh((oracle_freshness - 0.5) * sensitivity)
P_mark = (1 - bias) * P_book + bias * P_multi_venue
```

Where `P_book` = depth-weighted book mid (unchanged from original). `P_multi_venue` from M8-A keeper. If oracle stale, falls through to depth-weighted book mid + Pyth chain.

## Funding Rate — same formula as original

Depth-weighted premium computed from CLOB bids/asks vs oracle. SMA over funding period. Clamped to cap. Applied during position update (no batch settlement needed — continuous accrual).

```
P_bid = sweep(sell, sample_notional)
P_ask = sweep(buy, sample_notional)
delta = max(P_bid - P_oracle, 0) - max(P_oracle - P_ask, 0)
F = clamp(SMA(delta) + clamp(interest_rate - SMA(delta), -deviation_cap, deviation_cap), -funding_cap, funding_cap)
```

Funding accrues continuously (per-slot), not per-batch. `cum_funding` updated on each position-affecting trade.

## Liquidation & Safety Stack — unchanged from original

Trigger, optimizer, insurance fund, ADL — all same as original design. No batch dependency.

**Key difference:** No batch lifecycle means liquidations can be triggered at any time (not tied to batch settlement). Liquidators monitor portfolios continuously.

## Liquidation Flow (modified)

```
Portfolio health breach detected (any time)
    → Keeper calls LiquidateUser
    → Cancel all resting orders for this user (same as original)
    → Steps 2-5 identical to original safety stack
```

No batch coordination needed. Liquidator submits `LiquidateUser` instruction directly.

## Technology Choices

| Choice | Rationale |
|--------|-----------|
| **Rust + Pinocchio** | `no_std`, zero-allocation, BPF-compatible. Unchanged. |
| **Continuous CLOB** | Solana 400ms blocks enable continuous matching. No batch latency. |
| **RFQ layer (Option B)** | MM quotes post to same book — unified liquidity, simple program logic, long-term network effect. |
| **Registered MM only** | Governance controls who can quote — quality gate, accountability. |
| **Priority fees for MEV** | Replaces commit-reveal MEV protection with Solana-native priority fee market. |
| **Three-program separation** | Unchanged. Core / Matching / Oracle. |
| **M8-A multi-venue oracle** | Keeper-driven NBBO from 4 CEX venues. Unchanged from original. |
| **M8-C toxic-taker detection** | Per-address score, spread widening for bad actors. Unchanged from original. |
| **M8-D insurance inventory** | Base/quote reserves for insurance fund rebalancing. Unchanged. |

## What Gets Simpler vs Original

| Original (Batch) | This Design (Continuous) |
|-----------------|------------------------|
| Commit-reveal 2-tx flow | Single place_order 1-tx |
| Batch lifecycle state machine | Order book only |
| Fisher-Yates shuffle | None — price-time only |
| Structural priority queues | ALO/post-only still before regular (single-queue) |
| Batch settlement (settle_batch) | No settlement — positions updated per fill |
| Commitment deposits + slashing | Standard order deposits only |
| Reveal deadline logic | None |
| Close_committing + clear_batch | None |

## What Gets Harder

| Challenge | Mitigation |
|-----------|------------|
| **On-chain MEV (front-running)** | Priority fees, toxic-taker detection, ALO orders |
| **No batch atomicity** | Each fill is independent. Risk callback after each fill. |
| **Continuous risk monitoring** | Keepers must run continuously (same as original liquidator) |
| **MM quote quality** | Governance registration, toxic-taker scoring of takers |
| **Slashing removed** | Commitment deposit slashing gone — replaced by MM registration governance |

## Non-Functional Requirements

### Performance

| Metric | Target |
|--------|--------|
| Order matching | O(book_depth) per aggressive order, O(1) per passive |
| Risk callback per fill | ≤ 10k CU |
| Deposit/withdraw | ≤ 50k CU |
| Pyth price read | ≤ 25k CU per instrument |
| MM quote post | ≤ 30k CU |

### Security

All original Kani invariants preserved:
- Conservation: `sum(equity) + vault = total_deposits + sum(pnl)`
- No over-withdrawal: withdraw ≤ free_collateral
- Liquidation progress: every liquidation reduces underwater exposure
- Self-trade prevention: no account matches against itself
- Book integrity: order qty ≤ deposited collateral

**New invariants:**
- MM quotes only from registered MMs — verified in `PostQuote` instruction
- Quote nonce prevents replay — each nonce can only be filled once
- Quote expiry enforced — expired quotes rejected in `FillQuote`
- Both party signatures required on `FillQuote` — verified on-chain
- MM and taker signature bind exact quote terms (price, qty, sides)

## Open Questions

| # | Question | Options |
|---|----------|---------|
| 1 | Quote access | **Open to all in v1** — anyone can quote to any taker. Governance can add MM registration in v2. |
| 2 | Quote routing (taker sees quote) | **On-chain (v1)** — `PostQuote` stores quote with taker address. Program filters. No off-chain infra. |
| 3 | Off-chain quote negotiation | **Not in v1** — quotes posted on-chain. v2: REST API for off-chain negotiation before on-chain post. |
| 4 | Toxic taker protection | M8-C toxic-taker scoring + spread widening. MM can set min quote size. v2: MM blocklist. |
| 5 | Minimum quote size | Set per instrument (`min_quote_size`). Prevents spam. |
| 6 | Quote vs CLOB threshold | Large orders (above `min_quote_size`) → RFQ. Small orders → CLOB. |
| 7 | Permissionless fill | **Yes** — anyone can submit `FillQuote` with both signatures (same as TrustRFQ). | |

## Implementation Phases

| Phase | What |
|-------|------|
| **Phase 1** | Remove batch instructions. Continuous CLOB matching. Place/cancel/modify orders. |
| **Phase 2** | `PostQuote` + `AcceptQuote` + `FillQuote` + `CancelQuote` instructions. **Open to all users.** Private bilateral RFQ layer. |
| **Phase 3** | M8-A keeper + MultiVenuePrice integration. Mark price blend. |
| **Phase 4** | M8-C toxic-taker scoring + spread widening. |
| **Phase 5** | MM registry (bonded MMs, SLA enforcement). Insurance fund inventory (M8-D). |

## References

## References

- [Bulk.Trade Architecture — Matching](https://docs.bulk.trade/architecture/matching)
- [Bulk.Trade Architecture — Risk Engine](https://docs.bulk.trade/architecture/risk-engine)
- [Bulk.Trade HF Market Making](https://docs.bulk.trade/bulk-exchange/hf-market-making)
- [Bulk.Trade Orderbook](https://docs.bulk.trade/bulk-exchange/Orderbook)
- [Jump Crypto PropAMM](https://jumpcrypto.com/resources/propamms-and-the-next-chapter-of-permissionless-market-structure)
- [encrypt.trade — Private Swaps (Jupiter)](https://docs.encifher.io/docs/private-swap-jupiter)
- [encrypt.trade — Private Cross-Chain Bridge](https://docs.encifher.io/docs/private-cross-chain-bridge)
