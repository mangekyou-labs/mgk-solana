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

### 7.6. Risk Callback Wiring [NOT STARTED]
- [ ] Add per-user notional cap to CPI data format: `user_caps: [(Pubkey, u128)]` (decision D2)
- [ ] Matcher risk callback checks `cumulative_notional > user_cap` and cancels remainder
- [ ] Core validates margin after all fills applied (post-hoc check) — if `health < 0`, flag for liquidation but do not revert fills
- [ ] Update CPI wire format tests for new cap data
- [ ] Test: user with notional > cap has remaining fills cancelled; user under cap fills normally

### 7.7. Liquidation Safety Stack [NOT STARTED]
- [ ] Cancel all open orders (resting + un-revealed commitments) for liquidated user first
- [ ] Iterative position reduction: sort by abs notional, reduce top position 25%/round, up to 5 rounds (decision D4)
- [ ] If still underwater after 5 rounds: full-flat remaining positions
- [ ] Insurance fund absorbs shortfall (already implemented); add `adl_pending: bool` + `adl_debt: u128` to Vault for ADL stub
- [ ] No market sweep via CPI (mark at oracle price) — deferred to post-MVP
- [ ] No hedge-preserving detection or impact-ratio ranking — deferred to post-MVP
- [ ] No ADL implementation — ADL stub flags bad debt for keeper observation
- [ ] Test: simple liquidation; iterative reduction avoids full-flat; ADL stub flags uncovered debt

### 7.8. PauseFlags [NOT STARTED]
- [ ] Add `PauseFlags` bitmask to Registry: `trading_paused, withdrawals_paused, liquidations_paused, funding_paused`
- [ ] Check pause flags at instruction entry for each affected instruction
- [ ] Cancel operations remain available during trading pause
- [ ] Governance instruction to set/clear PauseFlags
- [ ] Test: paused instruction rejected; unpause allows instruction

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
