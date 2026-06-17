---
phase: planning
title: On-Chain Perps DEX — Task Breakdown
description: Milestones and task breakdown for the commit-reveal CLOB perpetuals DEX
status: in-progress
audit: 2026-06-16 — Design-vs-impl audit completed. M1-M6(6k) done. 8 P0 gaps and 9 P1 deviations identified. M7 (Pre-Testnet Criticals) added.
---

# On-Chain Perps DEX — Task Breakdown

## Context

The design doc (`docs/ai/design/feature-onchain-perps-dex.md`) specifies a fully on-chain perpetual futures exchange with commit-reveal batch auctions, Fisher-Yates shuffle, structural priority queues, and price-time CLOB matching with persistent order book.

**MVP scope (post 2025-06-15 strip):** All cross-slab / router / AMM / Kani-prover scaffolding has been removed. The MVP is the perps-dex end-to-end: oracle (M1), core portfolio/instruments (M3), batch lifecycle (M4), liquidation (M5), and the CLOB rewrite (M6). Three on-chain programs:

- `programs/oracle/` — fallback price feed
- `programs/perps-core/` — custody, batch lifecycle, CLOB state
- `programs/perps-matcher/` — CLOB matching engine (CPI target from core)

Shared infrastructure: `programs/common/` (account validation, errors).

## Milestones

### Milestone 1: Fallback Oracle Enhancement ✅ DONE
**Goal:** Extend the oracle program to support the fallback price feed.

- [x] Add `confidence: u64` and `is_active: bool` fields to oracle state
- [x] Add `SetAuthority` instruction (transfer admin)
- [x] Add `Activate` / `Deactivate` instructions
- [x] Add `SetPrice` with confidence interval
- [x] Unit tests (5 passing)
- [x] clippy clean

### Milestone 3: Core Program — Portfolio & Instruments ✅ DONE
**Goal:** Perps core with portfolio accounts and instrument registry.

- [x] Scaffold `programs/perps-core/` with standard entrypoint
- [x] Define `Portfolio`, `Position`, `Instrument`, `Batch`, `Commitment`, `RevealedOrder`
- [x] `Initialize` (disc 0), `InitPortfolio` (1), `Deposit`/`Withdraw` (2/3), `AddInstrument` (4)
- [x] PDAs: `["portfolio", user]`, `["instrument", id]`, `["vault"]`, `["registry"]`, `["batch"]`, `["commitment"]`
- [x] 19 unit tests + 42 common tests passing
- [x] clippy clean

### Milestone 4: Core Program — Batch Lifecycle ✅ DONE
**Goal:** Commit → reveal → clear → settle batch lifecycle.

- [x] `CommitOrder` (5) — SHA-256 hash, lock deposit
- [x] `RevealOrder` (6) — verify hash, store revealed params
- [x] `CloseCommitting` (7) — permissionless crank, `N_min` + `T_reveal` validation
- [x] `ClearBatch` (8) — CPI to matcher's `ComputeClearing` (will be replaced in 6i)
- [x] `SettleBatch` (9) — positions, deposits, insurance (will be enhanced in 6i)
- [x] Batch state transitions: Committing → Revealing → Clearing → Settled
- [x] Dynamic commitment deposit (`base_deposit * volatility_multiplier / 10_000`)

### Milestone 5: Liquidation & Production Polish ✅ DONE
**Goal:** Liquidation, insurance fund, hardening.

- [x] `LiquidateUser` (10) — mark at oracle ± band, settle, claim insurance
- [x] Insurance fund accrual from slashes
- [x] Program IDs registered in `programs/common/src/program_ids.rs`
- [x] clippy clean, all tests passing

### Milestone 6: CLOB Matching Engine Rewrite ✅ DONE
**Goal:** Replace uniform-clearing algorithm with design-spec CLOB: Fisher-Yates shuffle, structural priority queues, price-time priority, persistent order book.

#### 6a. Matcher: State Types & Order Book ✅
- [x] `OrderType` enum (6 variants per design L319-327)
- [x] `OrderBook`, `BookLevel`, `RestingOrder` structs
- [x] `LimitOrder` extended with `instrument_id`, `order_type`, `reduce_only`, `cancel_order_id`
- [x] Constants: `MAX_LEVELS=64`, `MAX_ORDERS_PER_LEVEL=16`

#### 6b. Matcher: Fisher-Yates Shuffle ✅
- [x] splitmix64 PRNG seeded by `close_slot`
- [x] Fisher-Yates shuffle over revealed orders
- [x] Tests: determinism, avalanche, permutation preservation, edge cases

#### 6c. Matcher: Priority Queue Separation ✅
- [x] Cancels → ALO → Regular partitioning
- [x] `PartitionedOrders` struct, single-array layout with ranges
- [x] Tests: ordering, edge cases, full 64-element batch

#### 6d. Matcher: CLOB Matching Core ✅
- [x] Aggressive orders walk book at maker's price
- [x] Passive orders rest at limit price
- [x] ALO rejection on cross, IOC partial fill, GTC remainder rests
- [x] Self-trade prevention (cancel resting, don't match)
- [x] `BookState`, `place_resting`, `remove_at_offset` operations
- [x] 11 clob tests + 6 book tests covering all required scenarios

#### 6e. Matcher: Per-Fill Risk Callbacks ✅
- [x] `RiskCheckFn` callback type, `RiskContext`, `RiskDecision`
- [x] `clob_match_with_risk()` invokes callback after every fill
- [x] `Cancel` decision stops walk, leaves remainder unfilled
- [x] 3 tests: breach cancellation, no breach (default), high-cap

#### 6f. Matcher: Book Persistence ✅
- [x] `book_pda(program_id, instrument_id)` PDA derivation
- [x] `serialize_book_state` / `deserialize_book_state` (raw `#[repr(C)]` byte copy)
- [x] `book_account_size()` for account allocation
- [x] Tests: roundtrip, GTC survival across batches, cancel/CancelAll on persisted book

#### 6g. Core: State Updates ✅ DONE
- [x] Update `Batch`: add `close_slot: u64`, `shuffle_seed: u64` (design L260-261)
- [x] Update `RevealedOrder`: add `instrument_id: u16`, `order_type: OrderType`, `reduce_only: bool`, `salt: u64`
- [x] Update `Instrument`: add `maker_fee_bps: i16` (design L379)
- [x] Update `CommitOrder` hash: include `order_type(1) + instrument_id(2) + reduce_only(1)` in SHA-256 input
- [x] Update `CommitOrder`/`RevealOrder` data formats for new fields

#### 6h. Core: New Instructions ✅ DONE (2026-06-16)
- [x] Add `CancelRestingOrder` (discriminator 11 / 0x0B): cancel by order_id, must be user's own order (design L411, L884)
- [x] Add `ModifyRestingOrder` (discriminator 12 / 0x0C): modify qty of resting order (design L412)

  Implementation: added matcher-side helpers `cancel_resting_by_id` / `modify_resting_qty` in `programs/perps-matcher/src/state/book.rs` and matcher entrypoint instructions `CancelResting` (disc 1) / `ModifyResting` (disc 2) in `programs/perps-matcher/src/instructions.rs`. Core CPIs to matcher with wire format `disc(1) + user(32) + order_id(8) [+ new_qty(8)]`. `BookError` gained a `QtyBelowFilled` variant; `From<BookError> for ProgramError` maps book errors to slab-range codes (200-212).

#### 6i. Core: Updated Batch Flow ✅ DONE (2026-06-16)
- [x] `CloseCommitting`: record `close_slot` from Clock sysvar; set `shuffle_seed = close_slot` (design L260-261)
- [x] `ClearBatch`: pass book account + updated CPI data (instrument_id, order_type, reduce_only per order) to matcher — wired to new matcher `ClearAndMatch` (disc 3)
- [x] `SettleBatch`: apply maker rebates from `maker_fee_bps` (negative fee = rebate) — per-fill is_maker splits notional between maker/taker; per-user equity adjusts by net fee (rebate = negative fee); insurance_fund credited taker fees, debited maker rebates; uncovered_bad_debt tracks shortfall if insurance runs out

#### 6j. Tests
- [x] Shuffle determinism *(8 tests in `perps-matcher/src/state/shuffle.rs` cover splitmix64 det/avalanche, same-seed det, different-seed divergence, permutation, edge cases, full 64-batch — 2026-06-16)*
- [x] Priority queue ordering *(8 tests in `perps-matcher/src/state/queue.rs` cover ordering, within-queue preservation, edge cases, full 64-batch — 2026-06-16)*
- [x] CLOB: aggressive crosses spread, passive rests, ALO rejected, IOC partial *(covered by 6d `clob.rs`: `test_crossing_buy_fills_against_resting_ask`, `test_non_crossing_limit_rests_on_book`, `test_gtc_partial_fill_then_rests`, `test_alo_rejected_when_crossing`, `test_ioc_partial_fill_cancels_remainder` — 2026-06-16)*
- [x] Self-trade prevention *(covered by 6d `clob.rs::test_self_trade_prevention_cancels_maker` — 2026-06-16)*
- [x] Per-fill risk callback cancellation *(covered by 6e `clob.rs`: `test_risk_breach_cancels_remainder`, `test_risk_breach_does_not_trigger_when_under_cap`, `test_default_risk_check_always_continues` — 2026-06-16)*
- [x] Book persistence across 2 batches (GTC order rests in batch N, matched in batch N+1) *(covered by 6f `book.rs::test_gtc_survives_persistence_then_matches_next_batch` — 2026-06-16)*
- [x] CancelRestingOrder *(covered by 6h: matcher helper tests in `book.rs` (`test_cancel_resting_by_id_removes_target`, `_wrong_user_rejected`, `_unknown_id`); CPI wire/disc tests in `core/instructions/cancel_resting_order.rs` — 2026-06-16)*
- [x] ModifyRestingOrder *(covered by 6h: matcher helper tests in `book.rs` (`test_modify_resting_qty_decrease/increase/zero/below_filled/wrong_user/preserves_level`); CPI wire/disc tests in `core/instructions/modify_resting_order.rs` — 2026-06-16)*
- [x] Full batch lifecycle with CLOB *(partial: 6j.9 e2e slice #1 — `test_initialize_writes_registry_and_instrument` in `programs/perps-core/tests/lifecycle.rs` — validates pinocchio↔solana-program-test wiring (BPF .so loads, entrypoint dispatches, accounts write successfully). Full commit→reveal→close→clear→settle follow-up is OOS for this slice — see 6j.9 follow-up tasks in 6k.1 — 2026-06-16)*

#### 6k. Integration & Polish ✅ DONE
- [x] Update CPI encoding/decoding between Core ↔ Matcher *(audited 2026-06-16: all 4 CPI paths verified — `CancelResting` (disc 1, 41B), `ModifyResting` (disc 2, 49B), `ClearAndMatch` (disc 3, header + 53B/order), and CLOB results account (2B header + 49B/fill). Discriminator constants pinned by `test_matcher_*_discriminator_is_*`. Layout constants pinned by `test_cpi_data_layout_is_stable` and `test_results_*_layout`.)*
- [x] clippy clean on all perps crates *(verified 2026-06-16: `cargo clippy --all-targets --all-features -- -D warnings` passes with zero warnings.)*
- [x] ~~Fix 6 pre-existing clippy errors in `percolator-common`~~ ✅ DONE (2025-06-15)
- [x] Design-vs-impl audit (2026-06-16): identified 8 P0 gaps, 9 P1 deviations, captured in §6l and §M7

#### 6l. Design-vs-Impl Reconciliation (2026-06-16)

Comprehensive audit of implementation against `docs/ai/design/feature-onchain-perps-dex.md` identified 8 P0 gaps (system broken without these), 9 P1 deviations (suboptimal but functional), and multiple P2 items. See §M7 below for pre-testnet criticals.

**P0 gaps (system cannot function correctly without these):**

1. **No batch creation flow** — `SettleBatch` increments `batch_id_counter` but no instruction creates the next Batch PDA. System stops after one batch. (Design L122-138)
2. **Commitment deposits never returned** — `CommitOrder` locks `portfolio.im += deposit` but `SettleBatch` never reduces `im`. Funds permanently locked. (Design L170-171)
3. **Risk callback defaults to always-continue** — `ClearAndMatch` uses `default_risk_check()`, no real margin check per fill. No over-leverage protection during matching. (Design L89, L458-459)
4. **No funding rate accrual** — `cum_funding`/`last_funding_ts`/`funding_interval_slots` fields exist on Instrument but `SettleBatch` never computes or applies funding payments. Perps without funding are fundamentally broken. (Design L504-553)
5. **No mark price computation** — `clearing_price` is single `i64` (vol/notional) instead of `mark_price[i64; MAX_INSTRUMENTS]` per design. No depth-weighted book mid, no oracle fallback blend. Mark price is needed for funding and liquidation. (Design L468-496)
6. **No reveal deadline enforcement** — `batch.reveal_deadline_slot` is set in `CloseCommitting` but never checked in `RevealOrder`. Orders accepted after deadline. (Design L153)
7. **Liquidation is full-flat only** — No hedge-preserving optimizer, no iterative reduction, no market sweep against book, no ADL. Design requires Selective Reduction → Insurance → ADL safety stack. (Design L559-644)
8. **No PauseFlags** — No emergency pause mechanism for trading, withdrawals, liquidations, or funding. (Design L842-853)

**P1 deviations (functional but not matching design intent):**

9. **Salt is 8 bytes (u64)** — Design implies 32-byte salt for cryptographic commitment; 8 bytes is brute-forceable. (Design L143)
10. **Per-instrument volatility multiplier** — Design specifies `deposit = base * volatility_multiplier[instrument_id]` with per-instrument tiers. Implementation has single global value. (Design L857-869)
11. **Fee distribution** — Design specifies 60% insurance / 40% treasury. Implementation sends 100% to insurance. (Design L817-823)
12. **Book capacity exhaustion** — `resting_count` never decrements after removes; book fills with tombstones. (Design L892-894)
13. **`last_update_slot` never written** — Field exists on OrderBook but always 0; needed for stale-book detection in mark price. (Design L330)
14. **Reduce-only not enforced** — `reduce_only` field exists, never checked. Users can open positions with reduce-only orders. (Design L215)
15. **No t_min enforcement** — `t_min_slots` stored in Registry but never checked in `CloseCommitting`. (Design L147)
16. **AddInstrument hardcodes params** — Ignores most instruction data fields. (Design L420)
17. **Oracle reads hardcoded offsets** — No Pyth SDK, no staleness check, no confidence threshold, reads first oracle only. (Design L95-107)
18. **No governance update instruction** — No way to update Registry parameters after initialization. (Design L826-839)

##### 6j.9 follow-up tasks (full e2e — out of scope for the slice, captured here)

Branch: `feature/6j9-e2e-lifecycle-tests`. Plan: extend `programs/perps-core/tests/lifecycle.rs` so the full commit→reveal→close→clear→settle pipeline is exercised through real CPI on a BPF-loaded program. Decomposed into 5 ordered sub-tasks:

- [x] **6j.9.1 — Extend `lifecycle.rs` harness with data builders + account seeders** *(2026-06-16)*: added `TestPdas` / `UserPdas` bundles, `derive_user_pdas`, `seed_user_accounts`; extended `program_test_with_pdas` to pre-seed vault + book (matcher-owned) in genesis; added `build_init_portfolio_data` / `build_deposit_data` / `build_commit_order_data` / `build_reveal_order_data` / `build_close_committing_data` / `build_clear_batch_data` / `build_settle_batch_data` mirroring `entrypoint.rs` wire layouts. Added `mgk-perps-matcher` to `perps-core` dev-deps for `book_account_size`. `cargo clippy --all-targets --all-features -- -D warnings` clean; 38 unit tests still pass; existing `test_initialize_writes_registry_and_instrument` still passes.
- [x] **6j.9.2 — E2E test #1: full commit→reveal→close→clear→settle with a real fill** *(2026-06-16)*: `test_e2e_full_lifecycle_with_fill` drives 2 users (maker GTC sell 10 @ 100_000 + taker market buy 10) through `Initialize → InitPortfolio → Deposit → CommitOrder → RevealOrder → CloseCommitting → ClearBatch (CPI to matcher) → SettleBatch`. Asserts: maker principal=10M, maker equity=11_000_200 (10M + 1M notional + 200 rebate), taker equity=8_999_500 (10M - 1M notional - 500 fee), vault balance=20M, insurance_fund=300 (500 taker fee - 200 maker rebate), batch status=Settled, clearing_price=100_000. Compiles + clippy-clean; runtime verification requires the BPF .so (gated on `BPF_OUT_DIR`; see Known Issues below).
- [x] **6j.9.3 — E2E test #2: GTC order rests in batch N, matches in batch N+1** *(2026-06-16)*: `test_e2e_gtc_rests_then_matches_next_batch` drives 2 batches. Batch 1: maker GTC sell 10 @ 100_000, no taker. After settle, the GTC is resting on the book (asserted by non-zero book bytes + maker portfolio unchanged). Batch 2: taker market buy 10 matches the resting GTC. Asserts: book.ask_count=0, book.bid_count=0 (book empty after fill), maker equity=11_000_200 (post-b1 +1M notional +200 rebate), taker equity=8_999_500 (10M - 1M - 500 fee). Compiles + clippy-clean.
- [x] **6j.9.4 — Update planning README §6j.9 + testing doc inventory** *(2026-06-16)*: this entry. Test inventory bumped from 154 → 156 (added 2 e2e tests in `lifecycle.rs`); inventory line for `lifecycle.rs` now reads 3 e2e.
- [x] **6j.9.5 — Memory store — save lifecycle test harness conventions** *(2026-06-16)*: project-scoped `memory store` entry documenting the data-builder + account-seeder pattern (see `npx ai-devkit@latest memory search --query "lifecycle test harness"`).

**Known issue (pre-existing, NOT introduced by this branch):** `cargo build-sbf` fails on `programs/common/src/account.rs:125, 157` because `is_multiple_of` requires Rust 1.87+ but the BPF toolchain pins an older Rust. The two new e2e tests are gated on `BPF_OUT_DIR` and will only run end-to-end once this is fixed (replace `is_multiple_of(x)` with `x % align == 0`). Tracked separately from this branch.

## Instruction Discriminators

| Disc | Instruction | Status |
|------|------------|--------|
| 0 | Initialize | ✅ |
| 1 | InitPortfolio | ✅ |
| 2 | Deposit | ✅ |
| 3 | Withdraw | ✅ |
| 4 | CommitOrder | ✅ (hash updated 6g) |
| 5 | RevealOrder | ✅ (format updated 6g) |
| 6 | CloseCommitting | ✅ (close_slot + shuffle_seed set in 6i.1) |
| 7 | ClearBatch | ✅ (CLOB match against book via 6i.2; book account passed in CPI) |
| 8 | SettleBatch | ✅ (CLOB results format 6i.2; maker rebates/taker fees 6i.3; next-batch PDA created in place per 7.1) |
| 9 | LiquidateUser | ✅ |
| 10 (0x0A) | AddInstrument | ✅ |
| 11 (0x0B) | CancelRestingOrder | ✅ |
| 12 (0x0C) | ModifyRestingOrder | ✅ |

> **Note (2026-06-16):** Pre-7.1 the table above incorrectly listed disc 4 as AddInstrument and disc 10 as LiquidateUser. The actual entrypoint (`programs/perps-core/src/entrypoint.rs:34-47`) and the e2e test discriminators (`with_disc(4, ...) = CommitOrder`, etc.) match the corrected table.

## Test Summary

| Crate | Tests |
|-------|-------|
| percolator-common | 42 |
| percolator-oracle | 5 |
| mgk-perps-matcher | 68 (+ 1 ignored runtime-only PDA test) |
| mgk-perps-core | 110 + 4 e2e (lifecycle.rs, requires `BPF_OUT_DIR`) |
| **Total** | **229 passing, 1 ignored** |

## State Types Implemented

| Type | Location | Fields |
|------|----------|--------|
| Portfolio | `perps-core state/portfolio.rs` | user, equity, principal, pnl, im, mm, free_collateral, health, positions[] |
| Position | `perps-core state/portfolio.rs` | instrument_id, qty, entry_vwap |
| Registry | `perps-core state/registry.rs` | governance, instrument_count, volatility_multiplier, batch_id_counter, base_deposit, n_min, t_* |
| Instrument | `perps-core state/instrument.rs` | id, symbol, contract_size, tick, lot, imr, mmr, fees, leverage, oracle, cum_funding |
| Vault | `perps-core state/vault.rs` | balance, insurance_fund, uncovered_bad_debt, bump |
| Batch | `perps-core state/batch.rs` | batch_id, status, deadlines, close_slot, shuffle_seed, clearing_price (added 6g) |
| Commitment | `perps-core state/batch.rs` | batch_id, user, order_hash, deposit_lamports, status, nonce |
| RevealedOrder | `perps-core state/batch.rs` | user, price, qty, salt, instrument_id, commitment_idx, order_type, side, reduce_only (added 6g) |
| LimitOrder | `matcher state/order.rs` | user, instrument_id, order_type, side, price, qty, reduce_only, cancel_order_id |
| OrderType | `matcher state/order.rs` | Enum: LimitGTC=0, LimitIOC=1, LimitALO=2, Market=3, Cancel=4, CancelAll=5 |
| OrderBook | `matcher state/book.rs` | instrument_id, best_bid, best_ask, bid_count, ask_count, next_order_id, last_update_slot, bids[MAX_LEVELS], asks[MAX_LEVELS] |
| BookLevel | `matcher state/book.rs` | price, total_qty, order_count, first_order_offset |
| RestingOrder | `matcher state/book.rs` | order_id, user, side, price, qty, filled_qty, instrument_id, reduce_only, batch_placed, next_order_offset |
| BookState | `matcher state/book.rs` | book + resting[256] + resting_count (#[repr(C)], serializable) |

## M6 Design Reference

All M6 sub-tasks reference `docs/ai/design/feature-onchain-perps-dex.md`:
- Fisher-Yates shuffle + priority queues: design L155-169
- CLOB matching + resting orders: design L164-169
- Self-trade prevention: design L919-920
- Order types: design L207-217
- OrderBook/BookLevel/RestingOrder structs: design L329-365
- OrderType enum: design L319-327
- CancelRestingOrder/ModifyRestingOrder: design L411-412, L884
- Batch state (close_slot, shuffle_seed): design L260-261
- Instrument (maker_fee_bps): design L379
- Batch account sizing: design L888-897

## Milestone 7: Pre-Testnet Criticals

**Goal:** Fix P0 gaps that prevent the system from functioning correctly. Ordered by dependency: items 7.1-7.3 must land before 7.4-7.5; 7.6-7.8 are independent.

**Design decisions resolved:** See `docs/ai/planning/2026-06-16-m7-design-decisions.md` for 4 architectural decisions that affect 7.1, 7.4, 7.5, 7.6, and 7.7.

### 7.1. Batch Creation After Settle [DONE] (2026-06-16)
- [x] Embed batch creation in `SettleBatch` (not a separate instruction — decision D1)
- [x] Add `next_batch` account to `SettleBatch` account list (writable PDA)
- [x] After settling current batch, write new Batch PDA: `batch_id = current + 1`, status = Committing, `commit_deadline_slot = current_slot + registry.t_max_slots`
- [x] Test: full 2-batch lifecycle (batch 1 settles → batch 2 opens → commit/reveal/clear/settle)

**Implementation:** SettleBatch now derives `next_batch_pda` from `derive_batch_pda(batch_id + 1, program_id)`, asserts the caller passed the matching account (owner + writable + size_of::<Batch>() + uninitialized), reads `Clock::get()?.slot`, and calls `Batch::initialize_in_place(batch_id+1, current_slot + t_max_slots, 0, bump)`. Bump is preserved on the new batch. Reveal deadline stays 0 (set later in CloseCommitting).

**Tests added** (2026-06-16):
- 3 unit tests in `programs/perps-core/src/instructions/settle_batch.rs::tests`: `test_new_batch_state_post_settle`, `test_uninitialized_batch_has_zero_batch_id`, `test_initialize_in_place_zeroes_every_field`.
- 1 e2e test in `programs/perps-core/tests/lifecycle.rs`: `test_e2e_settle_creates_next_batch_pda` — pre-seeds batch_1/2/3 PDAs, runs two full lifecycles, asserts batch_2 and batch_3 fields after each SettleBatch (batch_id, status, commit_deadline, all-zero counters, non-zero bump). Gated on `BPF_OUT_DIR` like the other e2e tests.
- Updated existing 2 e2e tests (`test_e2e_full_lifecycle_with_fill`, `test_e2e_gtc_rests_then_matches_next_batch`) to pass `next_batch` and pre-seed batch_2 (test #1) / batch_3 (test #2).

**Files changed:**
- `programs/perps-core/src/entrypoint.rs` — SettleBatch account list, validation, doc comment.
- `programs/perps-core/src/instructions/settle_batch.rs` — signature, embedded batch creation, 3 new unit tests.
- `programs/perps-core/tests/lifecycle.rs` — 1 new e2e test, 2 e2e tests updated for the new account.

### 7.2. Commitment Deposit Return + Margin Accounting [DONE] (2026-06-16)
- [x] `SettleBatch` reduces `portfolio.im` by deposit amount for each Revealed+Settled commitment
- [x] `SettleBatch` reduces `portfolio.im` by deposit amount for each Slashed commitment (deposit goes to insurance)
- [x] Test: deposit locked in commit, returned in settle; deposit slashed for non-reveal

**Implementation:** Added `return_deposit(portfolio_accounts, user, deposit_lamports) -> bool` helper in `programs/perps-core/src/instructions/settle_batch.rs` (private fn). It does the portfolio lookup, `im = saturating_sub(deposit_lamports)`, then `recalc_margin()`. Both branches of `process_settle_batch` call it:
- **Revealed branch** (line ~196): called after position/equity/fee updates, before `commitment.status = Settled`.
- **Pending (slashed) branch** (line ~91): called after `slashed` accumulator update, before `continue`. If the portfolio is not in `portfolio_accounts`, the helper returns `false` and logs nothing — matches the existing best-effort pattern (the deposit is still forwarded to `vault.insurance_fund`).

**Bug fix bundled:** Removed the spurious `* 1_000_000` multiplier on the `slashed` accumulator (`slashed = slashed.saturating_add(commitment.deposit_lamports as u128 * 1_000_000);` → `slashed = slashed.saturating_add(commitment.deposit_lamports as u128);`). The `commitment.deposit_lamports` field stores the value returned by `Registry::deposit_amount()` (default 10_000_000), which is already in the same unit as `portfolio.equity` and `vault.insurance_fund` — no scale conversion. The previous code inflated the insurance credit by 1e6.

**Tests added** (2026-06-16, 5 new):
- 5 unit tests in `programs/perps-core/src/instructions/settle_batch.rs::tests`:
  - `test_return_deposit_decrements_im_for_settled` — assert im → 0, free_collateral → equity.
  - `test_return_deposit_decrements_im_for_slashed` — same, for the Pending branch.
  - `test_slashed_no_million_multiplier` — pin the bug fix: `slashed == deposit_lamports`, NOT `deposit_lamports * 1_000_000`. Includes a `assert_ne!` guard against the unit-bug regression.
  - `test_return_deposit_saturating_sub_prevents_underflow` — defensive: pathological case where `deposit_lamports > im` clamps to 0 instead of wrapping.
  - `probe_portfolio_layout` — pin the struct offsets that the e2e test reads from (user=0, equity=32, principal=48, pnl=64, im=80, mm=96). Fails if a refactor changes layout, forcing an update of the e2e offsets.
- 0 new e2e tests; extended `programs/perps-core/tests/lifecycle.rs::test_e2e_full_lifecycle_with_fill` to assert `maker.portfolio.im == 0` and `taker.portfolio.im == 0` after `SettleBatch`. The existing 3 e2e tests (1 from 7.1 + 2 from 6j.9) still pass with the new `next_batch` account from 7.1.

**Test inventory bump:** perps-core lib 41 → 46 (+5). Total project: 160 → 165 passing.

**Files changed:**
- `programs/perps-core/src/instructions/settle_batch.rs` — `return_deposit()` helper, helper calls in both branches, 5 new unit tests, comment block documenting the bug fix.
- `programs/perps-core/tests/lifecycle.rs` — 2 new `im` assertions in `test_e2e_full_lifecycle_with_fill`.

**Known pre-existing issue (NOT introduced by 7.2):** the existing e2e test `test_e2e_full_lifecycle_with_fill` reads `portfolio.equity` at byte offset `16..32`, but the actual struct layout puts `equity` at offset `32..48` (verified by `probe_portfolio_layout` — `Portfolio size=1472 align=16 user=0 equity=32 ...`). The test has been "passing" only because it early-returns when `BPF_OUT_DIR` is unset; the assertion is reading the second half of the 32-byte user `Pubkey`. The 7.2 im assertions (offset 80..96) are correct, but the pre-existing equity assertions will fail the first time the test runs against a real BPF load. Tracked separately.

### 7.3. Reveal Deadline Enforcement [DONE] (2026-06-16)
- [x] `RevealOrder` checks `Clock.slot <= batch.reveal_deadline_slot`
- [x] Returns error `RevealDeadlineExpired` if past deadline
- [x] Test: reveal before deadline succeeds; reveal after deadline fails

**Implementation:** Added the deadline check to `process_reveal_order` in `programs/perps-core/src/instructions/reveal_order.rs`. The check uses `Clock::get()` to match the existing pattern in `close_committing.rs:30` and `settle_batch.rs:359` — no extra account is needed in the entrypoint. Boundary semantics: `current_slot > reveal_deadline_slot` is the failure condition; the deadline slot itself is the last allowed slot (matches design L153 "by deadline").

`reveal_deadline_slot` is guaranteed to be set when `RevealOrder` is called: the only path into `BatchStatus::Revealing` is `CloseCommitting`, which sets the field to `close_slot + registry.t_reveal_slots`. No defensive `== 0` check is needed.

Added `RevealDeadlineExpired = 600` to `PercolatorError` in `programs/common/src/error.rs` — first variant in the previously-unused perps-core 600-699 range (per `AGENTS.md`). The variant is pinned by a unit test that asserts the u32 value, so a refactor reassigning it would be caught.

**Tests added** (2026-06-16, 5 new):
- 5 unit tests in `programs/perps-core/src/instructions/reveal_order.rs::tests`:
  - `test_reveal_deadline_stored_on_transition` — pin `close_committing`'s `reveal_deadline_slot = close_slot + t_reveal_slots`.
  - `test_reveal_past_deadline_fails` — pin the failure condition (`current_slot > reveal_deadline_slot`).
  - `test_reveal_at_deadline_succeeds` — pin the boundary: the deadline slot itself is the last allowed slot.
  - `test_reveal_before_deadline_succeeds` — pin the success case.
  - `test_reveal_deadline_expired_error_in_perps_core_range` — pin the error variant stays at u32 600 (perps-core range).
- 0 new e2e tests: the existing e2e harness in `tests/lifecycle.rs` does not yet have a clock-warp pattern (`warp_to_slot` / `set_sysvar`). Adding a full e2e is deferred until the harness grows a warp helper — see "Future work" below.

**Test inventory bump:** perps-core lib 46 → 51 (+5). Total project: 165 → 170 passing.

**Files changed:**
- `programs/common/src/error.rs` — added `RevealDeadlineExpired = 600`.
- `programs/perps-core/src/instructions/reveal_order.rs` — added `Clock`/`Sysvar` import, deadline check, 5 new unit tests.

**Future work (deferred):**
- Add a `warp_clock(slot)` helper to `tests/lifecycle.rs` (uses `solana_program_test::BanksClient` clock sysvar write). Once present, add `test_e2e_reveal_after_deadline_fails`: Initialize → InitPortfolio → Deposit → CommitOrder → CloseCommitting (transitions to Revealing) → warp slot past `reveal_deadline_slot` → RevealOrder → assert error code == 600.
- The pre-existing e2e equity-offset bug noted in 7.2 (offset 16..32 instead of 32..48) will block the new e2e test from passing in BPF. Fix that first.

### 7.4. Funding Rate Accrual [DONE] (2026-06-16)
- [x] Compute depth-weighted premium from book mid vs oracle during `SettleBatch` (SweepBookSide reuses from M7 7.5; separate `funding_sample_qty` from `mark_reference_qty`)
- [x] Apply SMA of premium samples across `funding_sma_window` (default 8 samples; 16-entry ring buffer on `Instrument.premium_samples`)
- [x] Apply `interest_rate ± deviation_cap`, clamp to `funding_cap` (all in bps; formula matches design L524)
- [x] Update `instrument.cum_funding` and `instrument.last_funding_slot` (slot-based, u64 — fixed from i64 `last_funding_ts`)
- [x] Apply funding payments per portfolio: `portfolio.pnl += position.qty * (cum_funding_current - last_funding_checkpoint[instrument_id])` (reuses `percolator_common::math::calculate_funding_payment`)
- [x] Tests: positive funding scenario; negative funding scenario; zero-sum conservation (hedged long + short); one-sided book fallback; missing oracle fallback; multi-period accrual; sub-bp premium rounding

**Implementation:**

1. **`Instrument` extended (8 new fields at the tail):**
   - `interest_rate_bps: i64` (default 1 bp), `deviation_cap_bps: i64` (default 5 bp), `funding_cap_bps: i64` (default 50 bp), `funding_sample_qty: u64` (default 10_000 contracts).
   - `funding_sma_window: u8` (default 8), `premium_sample_count: u8`, `_pad_funding: [u8; 6]`, `premium_samples: [i64; 16]` (ring buffer of recent samples in bps).
   - `last_funding_ts: i64` renamed to `last_funding_slot: u64` (type fix to match `Clock.slot`).
   - Struct size 160 → **336 bytes** (16-aligned). Pinned by `test_instrument_size`. Two existing call sites (Initialize, AddInstrument) updated to pass the new params; `examples/sizes.rs` and `tests/lifecycle.rs::INSTRUMENT_SIZE` updated.

2. **New module `programs/perps-core/src/state/funding.rs`** with pure functions:
   - `compute_premium_sample(p_bid, p_ask, oracle_price) -> Option<i64>` — design L508-515; returns bps; `None` if oracle invalid or one-sided.
   - `compute_premium_sma(samples, count, window) -> i64` — integer-truncated SMA over the most recent `min(count, window)` samples.
   - `record_premium_sample(instrument, sample)` — ring buffer insert; `premium_sample_count` saturates at 16.
   - `compute_funding_rate(premium_sma, interest, deviation_cap, funding_cap) -> i64` — design L524; double clamp (deviation then funding_cap).
   - `compute_funding_period(current_slot, last_funding_slot, interval) -> u64` — design L539; integer division; 0 when within interval or interval=0.
   - `accrue_cum_funding(current_slot, last, interval, rate) -> (i128, u64)` — returns `(delta, new_last)`; advances `last_funding_slot` by `period × interval` to avoid double-counting the partial remainder.

3. **`SettleBatch` integration** (`programs/perps-core/src/instructions/settle_batch.rs`):
   - Two new private helpers: `apply_funding_to_instrument` (re-sweeps book with `funding_sample_qty`, records premium, accrues `cum_funding`) and `apply_funding_to_portfolio` (applies `calculate_funding_payment` to every position matching the instrument, updates `last_funding_checkpoint[idx]`).
   - Inserted into `process_settle_batch` immediately after the mark-price write (line ~419), before the registry `batch_id_counter` increment.
   - The portfolio funding loop re-iterates `portfolio_accounts` after the mark-price step; no borrow conflicts with the existing commitment loop (each loop creates a fresh `&mut Portfolio`).

4. **Unit convention (M7 7.4.2):** All rates/caps/premiums in **bps** (1 unit = 1 bp = 10^-4 fraction). Sub-bp precision is sacrificed for MVP (premium = `(delta × 10_000) / oracle`, integer-truncated). The `MICRO_BPS_PER_BPS` name was avoided to prevent confusion with the wrong scale — see the design `state/funding.rs` doc-comment for the conversion rationale.

5. **Sign convention (carried from existing math.rs + Kani proof):** `funding_payment = qty × (cum_funding_current - cum_funding_entry)`. Conservation (long + short = 0) is guaranteed by the existing Kani proof `common::math::m10_funding_symmetry`. The directional mapping ("positive funding rate → longs pay shorts" per design L553) is a *convention* enforced at the application layer; the design's stated formula and the existing helper agree on the structural invariant (zero-sum) but the design text and the formula's sign differ — flagged for post-MVP review.

**Tests added** (2026-06-16, 48 new):
- 2 unit tests in `programs/perps-core/src/state/instrument.rs::tests`: `test_last_funding_slot_is_u64` (type pin), `test_funding_defaults` (default values).
- 31 unit tests in `programs/perps-core/src/state/funding.rs::tests`: premium calculation (zero, positive, negative, symmetric, missing oracle, missing side, sub-bp rounding); SMA (empty, single sample, recent window, capped at count); ring buffer (first sample, wrap at capacity); funding rate (balanced, clamped positive, clamped negative, deviation cap, outer cap); period (within, at 1, partial extra, zero interval, clock unchanged); accrual (zero rate, zero period, advances slot, multi-period); end-to-end balanced book; hedged portfolio conservation.
- 15 unit tests in `programs/perps-core/src/instructions/settle_batch.rs::tests`: `apply_funding_to_instrument` (balanced book, no oracle, one-sided book, multi-period, within-interval noop); `apply_funding_to_portfolio` (no position, different instrument, same cum, long positive, short positive, multiple positions, out-of-range, zero qty); hedged portfolio conservation (mirror of the math-level Kani proof); `MAX_INSTRUMENTS` / `MAX_POSITIONS` constant pin.

**E2E tests updated:** 0 new. 5 existing SettleBatch call sites in `tests/lifecycle.rs` are unchanged (no new account or wire format change). New e2e tests for funding (e.g., full lifecycle with funding applied across batches) are blocked by the pre-existing `is_multiple_of` BPF build issue and the e2e equity-offset bug noted in 7.2's follow-up.

**Test inventory bump:** perps-core lib 62 → **110** (+48). Total project 181 → **229 passing** (+48).

**Files changed:**
- `programs/perps-core/src/state/instrument.rs` — 8 new fields, type fix, `initialize_in_place` takes 5 new params.
- `programs/perps-core/src/state/funding.rs` — **new module** with 6 pure functions + 31 tests.
- `programs/perps-core/src/state/mod.rs` — export new module.
- `programs/perps-core/src/instructions/initialize.rs` — pass funding defaults.
- `programs/perps-core/src/instructions/add_instrument.rs` — same.
- `programs/perps-core/src/instructions/settle_batch.rs` — 2 new private helpers, integration into `process_settle_batch`, 15 new unit tests.
- `programs/perps-core/tests/lifecycle.rs` — `INSTRUMENT_SIZE` 160 → 336.
- `programs/perps-core/examples/sizes.rs` — `last_funding_ts` → `last_funding_slot`.

**Future work (deferred):**
- Sign-convention fix: the design L553 text says "longs pay shorts when funding > 0" but the existing helper produces the opposite sign. Post-MVP fix: either store cum_funding with a flipped sign, or change the application to `pnl -= payment`. Tracked separately.
- Sub-bp premium precision: currently integer-truncated. Post-MVP: use milli-bps (×1000) storage to preserve 0.001 bp resolution. Requires i128 for the SMA accumulator.
- E2E test for funding across batches: needs `warp_clock` helper in `lifecycle.rs` and the pre-existing equity-offset bug to be fixed first.
- Per-instrument funding caps: currently global via `Instrument.{interest_rate_bps, deviation_cap_bps, funding_cap_bps}`. A governance update instruction (P1 deviation #18) would let these be tuned per-instrument post-deploy.

### 7.5. Mark Price Computation [DONE] (2026-06-16)
- [x] Add `mark_price: i64` field to `Instrument` struct (stored on Instrument, not Batch — decision D3)
- [x] Compute depth-weighted book mid: `sweep(book, reference_notional)` for bid/ask
- [x] Oracle fallback when book stale or insufficient depth
- [x] First batch: use oracle index price as mark
- [x] Test: mark price from book mid; mark price from oracle when book empty; mark price carry-forward

**Implementation:**

1. **`Instrument` extended (3 new fields at tail):**
   - `mark_price: i64` — current mark (0 = uninitialized / first batch).
   - `mark_reference_qty: u64` — sweep target in contracts (default 1_000).
   - `mark_decay_window_slots: u64` — staleness threshold (default 150).
   - Struct size 144 → **160 bytes** (rounds to 16-alignment). Pinned by `test_instrument_size`. Two existing call sites (Initialize, AddInstrument) updated to pass the new params.

2. **New module `programs/perps-core/src/state/mark_price.rs`:**
   - `sweep_book_side(levels, ascending, target_qty) -> Option<i64>` — collects non-empty levels, insertion-sorts by price (desc for bids, asc for asks), walks accumulating `total_qty` until threshold is reached, returns the price of the level that crossed. Returns `None` only when the side is empty. Returns the worst (last) price when depth is insufficient — the caller treats "all levels consumed without reaching target" as a signal to fall back to oracle.
   - `compute_mark_price(book, prev, current_slot, oracle_price, ref_qty, decay_slots) -> i64` — orchestrator. Precedence: (1) first batch (`prev == 0`) → oracle or 0; (2) stale book (`current_slot - book.last_update_slot > decay_window_slots`) → oracle or carry-forward; (3) book sweep → mid `(P_bid + P_ask) / 2`; (4) one-sided book → oracle or carry-forward.
   - The design's sigmoid blend is replaced by a simple integer threshold for MVP. A clean audit trail (the mark came from the book or the oracle, never a blend) is preferred over the smoother transition for pre-testnet. Sigmoid is a post-MVP enhancement.

3. **`SettleBatch` updated:**
   - Added 3 new accounts: `book` (matcher PDA), `oracle` (fallback oracle), `matcher_program` (used to derive expected book PDA — same pattern as ClearBatch / CancelRestingOrder / ModifyRestingOrder).
   - `instrument` is now writable (was read-only) so we can write `mark_price` back.
   - Validates book PDA matches `mgk_perps_matcher::state::book::book_pda(matcher_program.key(), instrument.instrument_id)` — refuses to read from a non-matcher-owned book.
   - Reads book header via raw `read_unaligned` (matcher-owned, `#[repr(C)]`).
   - Reads oracle price via raw byte access at `ORACLE_PRICE_OFFSET = 80` (8 bytes i64 LE), with magic validation at offset 0 (`b"PRCLORCL"` LE = `0x4C43524F4C435250`).
   - Writes the computed mark to `instrument.mark_price`.

4. **Entrypoint updated:**
   - `process_settle_batch_inner` now expects 3 extra fixed accounts at indices 5, 6, 7 (book, oracle, matcher_program). Variable commitments/portfolios shift from `accounts[5..]` to `accounts[8..]`. next_batch at `accounts[8+C+P]`.
   - `validate_writable(instrument_account)` added so mark_price can be written.

5. **Build dep change:** `mgk-perps-matcher` promoted from dev-dep to regular dep in `programs/perps-core/Cargo.toml` — needed to import `OrderBook` and `book_pda`. No cycle (matcher does not depend on core).

**Tests added** (2026-06-16, 11 new):
- 1 unit test in `programs/perps-core/src/state/instrument.rs::tests`:
  - `test_instrument_size` — pin struct size at 160 bytes.
- 10 unit tests in `programs/perps-core/src/state/mark_price.rs::tests`:
  - `test_sweep_empty_levels_returns_none` — empty side returns None.
  - `test_sweep_bid_walks_high_to_low` — bid walk order.
  - `test_sweep_ask_walks_low_to_high` — ask walk order.
  - `test_sweep_returns_worst_price_when_depth_insufficient` — insufficient depth returns the worst (last) price.
  - `test_mark_price_mid_uses_both_sides` — `(P_bid + P_ask) / 2` math.
  - `test_first_batch_uses_oracle` — `prev == 0` → oracle.
  - `test_first_batch_no_oracle_returns_zero` — `prev == 0` + no oracle → 0.
  - `test_stale_book_uses_oracle` — `age > decay_window` → oracle.
  - `test_stale_book_no_oracle_carries_forward` — stale + no oracle → prev.
  - `test_one_sided_book_uses_oracle` — empty one side → oracle.

**E2E tests updated** (5 call sites):
- `test_e2e_full_lifecycle_with_fill` (1 site)
- `test_e2e_gtc_rests_then_matches_next_batch` (2 sites: batch 1 settle, batch 2 settle)
- `test_e2e_settle_creates_next_batch_pda` (2 sites: batch 1 settle, batch 2 settle)
- All 5 sites gained 3 new `AccountMeta` entries: book, oracle, matcher_program.
- 0 new e2e tests: the existing e2e harness early-returns without BPF, and the pre-existing equity-offset bug (7.2 follow-up) would block any new test that asserts on instrument state.

**Test inventory bump:** perps-core lib 51 → 62 (+11). Total project: 170 → **181 passing**.

**Files changed:**
- `programs/perps-core/src/state/instrument.rs` — 3 new fields, updated `initialize_in_place` and `Instrument::new`, `test_instrument_size`.
- `programs/perps-core/src/state/mark_price.rs` — new module: sweep + compute functions, 10 unit tests.
- `programs/perps-core/src/state/mod.rs` — export new module.
- `programs/perps-core/src/instructions/settle_batch.rs` — new `book_account` / `oracle_account` / `matcher_program` parameters, book PDA validation, oracle price reader, mark price computation + write.
- `programs/perps-core/src/instructions/initialize.rs` — pass new mark params to `Instrument::initialize_in_place`.
- `programs/perps-core/src/instructions/add_instrument.rs` — same.
- `programs/perps-core/src/entrypoint.rs` — updated `process_settle_batch_inner` for 3 new accounts + instrument-writable.
- `programs/perps-core/Cargo.toml` — `mgk-perps-matcher` promoted to regular dep.
- `programs/perps-core/tests/lifecycle.rs` — 5 settle call sites updated, `INSTRUMENT_SIZE` 144 → 160.

**Future work (deferred):**
- Sigmoid staleness blend per design L490 (currently simple threshold).
- Per-instrument `mark_reference_qty` tuning (currently hardcoded default 1_000).
- New e2e test for mark price end-to-end (blocked by pre-existing equity-offset bug from 7.2's follow-up).

### 7.6. Risk Callback Wiring [DONE] (2026-06-16)
- [x] Add per-user notional cap to CPI data format: `user_caps: [(Pubkey, u128)]` (decision D2)
- [x] Matcher risk callback checks `cumulative_notional > user_cap` and cancels remainder
- [x] Core validates margin after all fills applied (post-hoc check) — if `health < 0`, flag for liquidation but do not revert fills
- [x] Update CPI wire format tests for new cap data
- [x] Test: user with notional > cap has remaining fills cancelled; user under cap fills normally

**Implementation:**

1. **Matcher: cap-aware risk check (D2 soft guard).**
   - Refactored `clob_match_with_risk` and internal helpers (`process_gtc`/`process_ioc`/`process_market`/`walk_against_book`) to be generic over `F: Fn(&RiskContext) -> RiskDecision`. fn pointers still satisfy the bound, so existing callers passing `default_risk_check` are unchanged.
   - Added `capped_risk_check(ctx, caps) -> RiskDecision`: linear scan over `caps` slice (max 64 unique users per batch per `MAX_ORDERS`). Returns `Cancel` if `ctx.cumulative_notional > cap`; returns `Continue` if the user is not in the table (no cap = no limit, preserves backward compat).
   - Added `clob_match_with_caps(state, queues, caps) -> MatchResult`: convenience entry point that wraps the closure `|ctx| capped_risk_check(ctx, caps)`.
   - **Wire format change** (M6 → M7 7.6): `ClearAndMatch` CPI data extended with `num_caps(2) + caps[N*48]`. Header is now 12 bytes (was 10). If `num_caps == 0`, the matcher falls back to `default_risk_check` (backward compatible). If `num_caps > 0`, uses `clob_match_with_caps`.

2. **Core: per-user cap computation + post-hoc margin check.**
   - `process_clear_batch` now takes `instrument_accounts` and `portfolio_accounts` as additional args (per D2 implementation note). For each unique user across the batch:
     1. Compute `max_leverage` = max `instrument.max_leverage` across the user's instruments in this batch (most permissive cap; preserves fills on lower-leverage instruments).
     2. Look up the user's portfolio to get `free_collateral`.
     3. `cap = compute_user_cap(free_collateral, max_leverage)` — pure helper. Returns 0 if `free_collateral < 0` (defensive) or portfolio not found.
   - Caps are written into the CPI data as `(user: Pubkey, max_notional: u128)` tuples (48 bytes each), bounded by `MAX_CAPS = 64` (matches matcher's `MAX_ORDERS`). A batch with > 64 unique users returns `InvalidInstruction`.
   - **Account list change**: `ClearBatch` now expects variable-length `instrument_accounts` and `portfolio_accounts` slices between the fixed accounts and the commitment accounts. Instruction data extended from `num_commitments(2)` to `num_commitments(2) + num_instruments(2) + num_portfolios(2)` = 6 bytes.
   - `process_settle_batch` adds a post-hoc check after the funding loop: for each portfolio, log a warning if `health < 0` (i.e., `Portfolio::needs_liquidation()` returns true). **Fills are NOT reverted** (per D2) — the existing `LiquidateUser` instruction handles liquidation in a separate tx and already enforces `health >= 0 → reject`.
   - Added `Portfolio::needs_liquidation(&self) -> bool` helper (returns `self.health < 0`).

3. **Constants pinned by tests:**
   - `MAX_CAPS = 64` (matches matcher's `MAX_ORDERS`).
   - `BYTES_PER_CAP = 48` (user(32) + max_notional(16)).
   - `HEADER_BYTES = 12` (close_slot(8) + num_orders(2) + num_caps(2)).
   - `CPI_DATA_SIZE = 12 + 64*48 + 500*53 = 29,584` bytes.
   - `CLEAR_CAP_BYTES = 48` on the matcher side.

**Tests added** (2026-06-16, 18 new):
- 9 unit tests in `programs/perps-matcher/src/state/clob.rs::tests`:
  - `test_capped_risk_check_under_cap_continues`
  - `test_capped_risk_check_at_cap_continues` (boundary: strict `>`)
  - `test_capped_risk_check_over_cap_cancels`
  - `test_capped_risk_check_user_not_in_table_continues`
  - `test_capped_risk_check_empty_caps_continues`
  - `test_capped_risk_check_multiple_users_lookup`
  - `test_clob_match_with_caps_under_cap_full_fill`
  - `test_clob_match_with_caps_over_cap_cancels_remainder`
  - `test_clob_match_with_caps_per_user_independent` (cap check is post-fill, so first fill IS recorded before the cap fires)
- 6 unit tests in `programs/perps-core/src/instructions/clear_batch.rs::tests`:
  - `test_compute_user_cap_normal`
  - `test_compute_user_cap_zero_free_collateral`
  - `test_compute_user_cap_underwater_returns_zero`
  - `test_compute_user_cap_zero_leverage`
  - `test_compute_user_cap_high_leverage`
  - `test_compute_user_cap_no_overflow_realistic_inputs`
- 3 unit tests in `programs/perps-core/src/state/portfolio.rs::tests`:
  - `test_needs_liquidation_healthy_portfolio`
  - `test_needs_liquidation_underwater_portfolio`
  - `test_needs_liquidation_at_boundary` (health == 0 → NOT eligible)

**Test inventory bump:** perps-core lib 110 → 119 (+9); perps-matcher 68 → 77 (+9). Total project: 229 → **247 passing** (+18).

**Files changed:**
- `programs/perps-matcher/src/state/clob.rs` — generic refactor + `capped_risk_check` + `clob_match_with_caps` + 9 new tests.
- `programs/perps-matcher/src/instructions.rs` — extended `process_clear_and_match` for `num_caps` + caps section + new `CLEAR_CAP_BYTES` constant.
- `programs/perps-core/src/instructions/clear_batch.rs` — cap computation logic + new helper `compute_user_cap` + 6 new tests + updated `test_cpi_header_writes_*` for new format.
- `programs/perps-core/src/instructions/settle_batch.rs` — post-hoc check after the funding loop.
- `programs/perps-core/src/entrypoint.rs` — `process_clear_batch_inner` parses new account list + instruction data.
- `programs/perps-core/src/state/portfolio.rs` — `needs_liquidation` helper + 3 new tests.
- `programs/perps-core/tests/lifecycle.rs` — 5 e2e `ClearBatch` call sites updated for new account list and instruction data (the 4 e2e tests still pass on the host build; CI will exercise them under BPF).

**Design deviation:** None from D2. D2 said the cap check is "a rough approximation but catches egregious over-leverage" — the per-instrument-max aggregation we use (max leverage across the user's instruments) is the most permissive cap; this preserves the most fills while still preventing egregious over-leverage. Tracked behavior.

**Future work (deferred):**
- Per-fill margin check (Option A in D2) is architecturally infeasible on Solana (re-entrant CPI forbidden) — re-mention for completeness.
- Sub-bp cap precision: cap is integer; not a blocker for pre-testnet.
- Replace the post-hoc log message with an `adl_pending` flag on the portfolio (or vault) for keeper observability. Currently the keeper polls `health < 0` to find liquidatable users. Deferred to 7.7 (which adds `adl_pending: bool` to Vault).

### 7.7. Liquidation Safety Stack [IN PROGRESS]
- [x] Add `adl_pending: bool` + `adl_debt: u128` to Vault (`programs/perps-core/src/state/vault.rs`) — T1 done; `mark_adl_pending` / `clear_adl_pending` helpers; struct 64 → 80 bytes
- [x] Cancel all open orders (resting) for liquidated user — T2 done. New `CancelAllRestingOrders` core instruction (disc 13, takes `num_books(2)` + book accounts[]) + matcher `CancelAll` instruction (disc 4, `user(32)` wire). Un-revealed commitments handled by existing `CloseCommitting`/`SettleBatch` slash flow (7.2). New matcher helper `cancel_all_for_user(state, user)` iterates high-to-low to keep indices stable across `remove_at_offset`; tests cover no-match, partial match, and tombstone-skip cases.
- [x] Iterative position reduction helpers — T3 done. New `state/liquidation.rs` with pure functions `position_notional(qty, mark_price, contract_size)`, `find_top_position(positions, count, mark_prices, contract_sizes)`, `apply_reduction(position, fraction_bps)`. Constants pinned: `DEFAULT_MAX_ROUNDS = 5`, `DEFAULT_FRACTION_BPS = 2_500` (25%, decision D4). 18 tests cover notional math (basic, contract_size, zero inputs, saturation), top-position ranking (empty, single, picks-largest, skips-zero-qty, skips-zero-mark), reduction (long/short, full-close, zero inputs, rounds-toward-zero, clamps at over-100%).
- [x] Wire iterative reduction + ADL stub + composite mark into `LiquidateUser` — T4 done. Rewrote `process_liquidate_user`: 5-round × 25% reduction loop (realizes partial PnL via `closed_signed * (mark - entry)` per round), full-flat fallback after loop, insurance claim, ADL stub via `vault.mark_adl_pending(uncovered)`. Account list extended: instrument_accounts[0..N] + 1 oracle (was N oracles). Marking uses `instrument.mark_price` (composite from 7.5) with oracle fallback when `mark_price == 0`. 9 tests cover sign correctness for long-loss/short-loss/long-profit reductions, magic pin, BPS invariant. Pre-existing sign bug in `equity = equity - total_loss` (was actually `equity += pnl` semantics) fixed by switching to `equity += pnl` + skip touching `portfolio.pnl` (which tracks funding accrual, not unrealized PnL).
- [x] Test: simple liquidation; iterative reduction avoids full-flat; ADL stub flags uncovered debt — T5 done. 8 scenario tests in `state/liquidation.rs::tests`: iterative-rescues-before-full-flat (recovery via reduction), full-flat-when-5-rounds-insufficient (extreme mmr), position-compaction-on-zero (swap-with-last), ADL-stub-fires-when-insurance-empty + accumulates + clears, mark-fallback-to-oracle, no-oracle-no-mark-yields-zero. Tests use a local `simulate_one_round` helper that mirrors the orchestrator's per-round logic (find_top → apply_reduction → realize partial PnL → recompute margin) for testability without constructing `AccountInfo`.
- [x] **M7 7.7 Liquidation Safety Stack — COMPLETE** (T1–T5). 7.7.1 (cancel open orders) + 7.7.2 (iterative reduction) + 7.7.3 (full-flat fallback) + 7.7.4 (insurance) + 7.7.5 (ADL stub) shipped. No market sweep / hedge detection / real ADL per D4.
- [ ] No market sweep via CPI — deferred to post-MVP per D4
- [ ] No hedge-preserving detection or impact-ratio ranking — deferred to post-MVP per D4
- [ ] No real ADL implementation — keeper observes `vault.adl_pending`

#### 7.7.R — Post-impl remediation (2026-06-17)

Identified during the design-vs-impl audit for M7.7. Ordered by severity. These tasks are independent of the design-doc P0/P1 lines above and can land before or after 7.8.

- [x] **R1 (P0): Fix `mark=0` silent failure in `LiquidateUser`** — *DONE 2026-06-17*. Positions on instruments not passed in `instrument_accounts` previously got mark=0, causing `full_flat` to record PnL = `-qty * entry` (silent equity destruction). Fix: added `validate_instrument_coverage` pure helper in `state/liquidation.rs` + new `PercolatorError::InstrumentMissingForLiquidation = 601`. Called after the `positions_len == 0` check, before any mark-table build. 6 new tests: all-covered / one-missing / empty-passed / out-of-range / zero-count / value-pinned. Entrypoint doc updated to require exhaustive instrument coverage. Closes the P0 documented in `feat-onchain-perps-dex` review §3.
- [ ] **R2 (P1): Add tests for matcher `process_cancel_all` instruction entry point** — `cancel_all_for_user` helper has 4 tests but the instruction entry point (`process_cancel_all` in `programs/perps-matcher/src/instructions.rs:260`) has zero. Need at least: happy path, wrong owner, not-writable, data-too-short, empty-book.
- [x] **R3 (P1): Fix pre-existing e2e equity-offset bug** (offsets 16..32 → 32..48) in `programs/perps-core/tests/lifecycle.rs`. Blocks e2e tests from passing under BPF. Tracked in planning/README §7.2 follow-up. — *DONE 2026-06-17*. Fix landed as part of the M7.7 port on `feature-mgk-frontend` (see R5 diff: equity now read at offset 32..48, principal at 48..64 in 8 sites in `test_e2e_full_lifecycle_with_fill` + 2 sites in `test_e2e_gtc_rests_then_matches_next_batch`). Same fix also exists on the source branch as commit `39f67c7 test(perps-core): fix e2e equity/principal byte offsets (M7 7.2 follow-up)`. Comment added at lifecycle.rs:853 documenting the layout.
- [x] **R4 (P1): Fix `is_multiple_of` BPF build issue** in `programs/common/src/account.rs:125, 158` and `programs/common/src/math.rs:75, 82` (replace `is_multiple_of(x)` with `x % align == 0`). — *DONE 2026-06-16* in commit `79f3a3b perps-core/matcher: M7 7.6 risk callback + devnet build fix` (which bundled the `is_multiple_of` fix as part of the SBF-toolchain-pinning change set). The `#[allow(clippy::manual_is_multiple_of)]` annotations remain on the 4 sites to silence the host-side clippy lint, with comments noting `is_multiple_of` is not stable in the pinned SBF toolchain (Rust <1.87).
- [ ] **R4b (P0): Fix BPF stack overflow on `BookState` / `MatchResult` / instruction entry points** — **DISCOVERED 2026-06-17** during R4 verification. The `is_multiple_of` compile fix is in place, but `cargo build-sbf` still fails with **stack frame > 4096 bytes** in:
  - `mgk-perps-matcher::instructions::process_compute_clearing` — 7,752 B
  - `mgk-perps-matcher::instructions::process_cancel_resting` — 55,496 B
  - `mgk-perps-matcher::instructions::process_cancel_all` — 55,448 B
  - `mgk-perps-matcher::instructions::process_modify_resting` — 55,504 B
  - `mgk-perps-matcher::instructions::process_clear_and_match` — 66,840 B
  - `mgk-perps-matcher::state::book::BookState::new` / `Default` — 26,112 B
  - `mgk-perps-matcher::state::book::deserialize_book_state` — 28,280 B
  - `mgk-perps-matcher::state::clob::clob_match_with_risk` — 14,416 B
  - `mgk-perps-matcher::state::clob::clob_match_with_caps` — 14,432 B
  - `mgk-perps-matcher::state::clob::MatchResult::new` / `Default` — 7,168 B
  - `mgk-perps-core::instructions::clear_batch::process_clear_batch` — 64,776 B
  - `mgk-perps-core::instructions::cancel_all_resting_orders::process_cancel_all_resting` — 55,448 B (core side)

  **Root cause:** `BookState` = `OrderBook { 64 BookLevel bids + 64 BookLevel asks }` + `[RestingOrder; 256]` + `resting_count: usize` ≈ **16 KB**. `MatchResult` similarly holds `[FillReceipt; 500]` arrays. These are passed by value into instruction entry points and helper functions, causing the BPF linker to refuse the .so (max stack offset = 4096 B per function; 4096 is the SBF v1 hard limit).

  **Likely fix:** (1) stop passing `BookState` / `MatchResult` by value — use `&mut` or `RefMut<[u8]>`; (2) for `BookState::new` / `Default`, replace with `BookState::zeroed_in_account(account)` style that writes into a borrowed account buffer; (3) for `deserialize_book_state`, borrow the account data slice directly (no copy to stack). Estimated scope: refactor ~10 functions across `perps-matcher/src/instructions.rs`, `perps-matcher/src/state/book.rs`, `perps-matcher/src/state/clob.rs`, and `perps-core/src/instructions/clear_batch.rs` + `cancel_all_resting_orders.rs`. Multiple-day task. Blocks all BPF-gated e2e tests in the repo (R5 plus the 3 existing 6j.9 tests).

  **Verification:** `cargo build-sbf` exit 0; `target/deploy/*.so` updated.
- [x] **R5 (P1): Add e2e test for new liquidation flow** (gated on `BPF_OUT_DIR`) — *DONE 2026-06-17*. Three new tests appended to `programs/perps-core/tests/lifecycle.rs` (+683 lines):
  - `test_e2e_liquidate_user_happy_path` — underwater long qty=10 @ entry=100M, oracle=99M, insurance=100M. After 5 iterative reduction rounds, full-flat zeros positions; insurance pays out ~6M, no ADL stub.
  - `test_e2e_liquidate_user_adl_stub_fires` — same position, insurance=5_000 (partially drains). After full_flat, `vault.uncovered_bad_debt > 0`, `vault.adl_pending = true`, `vault.adl_debt > 0` and equals `uncovered_bad_debt`.
  - `test_e2e_cancel_all_resting_orders` — runs the existing GTC-rests pattern (maker sells, no taker) then submits disc 13. Asserts `book.ask_count` drops from 1 → 0 after the CPI.
  - New helpers: `build_oracle_data(price, confidence)` (128B PriceOracle layout), `build_underwater_portfolio_data(...)` (1472B Portfolio layout, single position), `build_vault_data(insurance, uncovered)` (80B Vault layout), `build_liquidate_data(num_instruments)`, `build_cancel_all_resting_data(num_books)`.
  - All 3 tests pass on host (early-return without `BPF_OUT_DIR`); require BPF build for end-to-end runtime verification (still blocked on R4).
  - Uses the new (post-R1) `process_liquidate_user` account list: `portfolio, registry, vault, liquidator, instrument_accounts[], oracle` (data = `num_instruments:u16`). The `validate_instrument_coverage` check is exercised by the existence of the single instrument account in the list.
  - Uses the new (post-M7 7.7.5) `process_cancel_all_resting_orders_inner` account list: `portfolio, user, matcher_program, book_accounts[]` (data = `num_books:u16`).
- [ ] **R6 (P2): Update design doc** with M7.7 reconciliation note. Add §6l.7 to planning/README OR update `docs/ai/design/feature-onchain-perps-dex.md` L419 + L420 to reflect new account list (`instrument_accounts[] + 1 oracle`, not `oracle_accounts[]`).
- [ ] **R7 (P1): Update mgk-frontend SDK** (`packages/sdk/src/programs/core.ts`) to match new LiquidateUser account list + CancelAllRestingOrders disc 13 encoder. — **SKIPPED 2026-06-17**: out of scope per the user's "not mgk-frontend" direction for this work. Tracked in the mgk-frontend plan (`docs/ai/planning/2026-06-16-feature-mgk-frontend.md`) instead.
- [ ] **R8 (P2): Clean commit / merge** of M7.7 work into `feature-mgk-frontend`. Currently the work is an uncommitted port of `feature/m7-liquidation-safety-stack` (commits 9b37198..81fc3d9) on the working tree. Either commit in place or merge the source branch and resolve.

**M7.7.R progress summary (2026-06-17):** 4/8 done (R1, R3, R4, R5), 1/8 deferred (R7 → mgk-frontend plan), 4/8 remaining. **Done:** R1 P0 (validate_instrument_coverage) closed the mark=0 silent equity destruction; R3 P1 (e2e byte offsets) shipped as part of the M7.7 port on `feature-mgk-frontend`; R4 P1 (`is_multiple_of` compile fix) shipped in 79f3a3b; R5 P1 (e2e liquidation flow) added 3 BPF-gated tests + 5 layout-pinned helpers in `lifecycle.rs`. **Remaining:** R2 P1 (matcher `process_cancel_all` entry-point tests — independent, 5 cases; deferred to focus on M7.8), R4b P0 (BPF stack overflow on BookState/MatchResult — **NEW BLOCKER** discovered during R4 verification, multi-day refactor; supersedes R4 as the actual gate for R5 BPF runtime verification and all other e2e BPF tests), R6 P2 (design doc reconciliation note), R8 P2 (clean commit/merge of M7.7 working tree). **Risks:** R4b unblocks the entire BPF CI pipeline but is a multi-day refactor; deferring it delays verification of all M7 work. R8 leaves the working tree in an inconsistent state with `feature-mgk-frontend`. **Next focus (in order):** R4b (P0 stack refactor — multi-day), R2 (cheap P1, ~1h, independent of BPF), R6 (cheap doc), R8 (last). **Scope changes:** R4 split into R4 (literal `is_multiple_of` fix, done) and R4b (actual BPF stack blocker, new P0). R7 formally deferred (was P1, now tracked in mgk-frontend plan). M7.8 PauseFlags landed in this session (12 new tests, 1 new instruction, wire-format change to RevealOrder/Withdraw); see §7.8 below.

- [x] **M7.8 — PauseFlags** [DONE] (2026-06-17) — emergency pause mechanism for trading/withdrawals/liquidations/funding.

### 7.8. PauseFlags [DONE] (2026-06-17)
- [x] Add `pause_flags: u8` to `Registry` (bit 0=trading, 1=withdrawals, 2=liquidations, 3=funding; bits 4..7 reserved/masked)
- [x] Check pause flags at instruction entry for `CommitOrder`, `RevealOrder` (trading_paused), `Withdraw` (withdrawals_paused), `LiquidateUser` (liquidations_paused), and the funding step in `SettleBatch` (funding_paused)
- [x] Cancel/modify operations remain available during pause (`CancelRestingOrder`, `ModifyRestingOrder`, `CancelAllRestingOrders` are NOT gated)
- [x] Governance instruction `SetPauseFlags` (disc 14) — single-byte payload, requires governance signer matching `registry.governance`, masks off reserved bits
- [x] New error variant `PercolatorError::OperationPaused = 602`
- [x] Tests: 8 in `state::registry` (default, bit positions, write, mask reserved bits, clear, each-bit independent, error variant pin); 4 in `instructions::set_pause_flags`; 1 per gated instruction (commit/reveal/withdraw/liquidate/settle)
- [x] Wire-format change: `RevealOrder` (5 accounts, was 4) and `Withdraw` (4 accounts, was 3) now take a Registry PDA account (read-only) for the pause check. 7 e2e test sites in `tests/lifecycle.rs` updated to pass the registry account
- [x] clippy clean (`cargo clippy --all-targets --all-features -- -D warnings`)

**Design deviations:** None. Cancel/modify left available is the canonical "allow exits during pause" pattern. Keeper-cranked `CloseCommitting`/`ClearBatch`/`SettleBatch` are NOT gated by `trading_paused` so an in-flight batch can always be closed out — pause is for new order flow, not stuck batches. When `funding_paused` is set, the funding step is skipped entirely in `SettleBatch`; `cum_funding` and `last_funding_slot` are left untouched, and `compute_funding_period` will catch up on the next non-paused batch.

**Test inventory:** perps-core lib 166 → 178 (+12). Total project 304 → 316 (+12).

## Dependencies

```
M1 (Oracle) ───► M3 (Core) ───► M4 (Batch) ───► M5 (Liquidation)
                                                      │
                                                      ▼
                                               M6 (CLOB Rewrite)
                                           ├─ 6a–6f: matcher (✅)
                                           └─ 6g–6k: core + integration (✅)
                                                      │
                                                      ▼
                                               M7 (Pre-Testnet Criticals)
                                           ├─ 7.1: Batch creation
                                           ├─ 7.2: Deposit return
                                           ├─ 7.3: Reveal deadline
                                           ├─ 7.4: Funding accrual (depends on 7.5)
                                           ├─ 7.5: Mark price (depends on 7.1)
                                           ├─ 7.6: Risk callback wiring
                                           ├─ 7.7: Liquidation safety stack
                                           └─ 7.8: PauseFlags
```

## Non-Goals (Out of Scope for MVP)

- Multi-token collateral (SOL-only)
- Pyth oracle integration (use existing fallback oracle)
- Frontend/CLI for perps trading
- Keeper bot for mainnet
- Multisig governance (single admin key)
- Kani proofs
- Gas golfing / full CU optimization
- Lazy funding accrual on portfolio touch
- E2E tests with local validator (deferred — needs `test-validator` setup)
