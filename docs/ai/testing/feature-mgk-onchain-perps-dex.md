---
phase: testing
title: mgk On-Chain Perps DEX — Test Strategy
description: HISTORICAL commit-reveal CLOB coverage. Active DFBA tests — see 2026-08-02-feature-onchain-perps-dex.md
status: historical
audit: 2026-06-16 — testing/ doc was deleted in 2025-06-15 strip; recreated here from current test inventory.
dfba: 2026-08-02 — Active plan docs/ai/testing/2026-08-02-feature-onchain-perps-dex.md
---

# mgk On-Chain Perps DEX — Test Strategy

> **ACTIVE DFBA testing:** [`2026-08-02-feature-onchain-perps-dex.md`](./2026-08-02-feature-onchain-perps-dex.md)
> Content below is **historical** (commit-reveal CLOB). Do not add new commit-reveal scenarios.

## Context

The mgk (formerly percolator) perps-dex MVP is a 3-program Solana stack: fallback oracle, perps-core (custody + batch lifecycle), perps-matcher. All logic is `no_std` Rust on Pinocchio; no Anchor, no IDL, single-byte discriminators.

**Superseded design framing:** commit-reveal CLOB with Fisher-Yates shuffle, structural priority queues, price-time matching.

## Test Inventory (current state, 2026-06-16)

| Crate | Tests | File | Notes |
|---|---|---|---|
| `percolator-common` | 42 | inline `#[cfg(test)] mod tests` | Math (IM/MM/PnL/VWAP/funding), types, header, account, fill_receipt, instruction, quote_cache |
| `percolator-oracle` | 5 | `programs/oracle/src/state.rs` | PriceOracle create/activate/deactivate/set_authority |
| `mgk-perps-matcher` | 68 (+ 1 ignored) | inline | book (24), clob (14), shuffle (8), queue (8), order (3), clearing (12, legacy) |
| `mgk-perps-core` | 38 | inline | batch (3), instrument (2), order (2), portfolio (3), registry (1), vault (2), instructions: settle_batch (6), clear_batch (3), liquidate_user (3), reveal_order (3), close_committing (2), cancel_resting_order (2), modify_resting_order (2), commit_order (4) |
| `mgk-perps-core/tests/lifecycle.rs` | 3 e2e (gated on `BPF_OUT_DIR`) | integration | `test_initialize_writes_registry_and_instrument` (BPF .so loader + Initialize interop); `test_e2e_full_lifecycle_with_fill` (6j.9.2 — full commit→reveal→close→clear→settle with a real fill, asserts positions/equity/vault/insurance/batch/clearing_price); `test_e2e_gtc_rests_then_matches_next_batch` (6j.9.3 — GTC rests in batch N, matches in batch N+1, asserts book persistence) |
| **Total** | **156 passing, 1 ignored** | | clippy clean |

## Coverage Strategy

### 1. Unit tests (in-source `#[cfg(test)] mod tests`)

Inline tests run on host (`cargo test --all-features`); no BPF toolchain required. They cover pure-logic functions and pinned wire formats.

**Tested (good coverage):**
- ✅ Fisher-Yates splitmix64 PRNG — determinism, avalanche, same-seed equivalence, permutation preservation, empty/singleton edge cases, full 64-batch (8 tests in `shuffle.rs`)
- ✅ Priority queue separation — ordering, within-queue preservation, empty/full batch, all-orders-one-type (8 tests in `queue.rs`)
- ✅ CLOB matching — crossing fill at maker price, non-crossing rests, ALO reject/rests, IOC partial cancel, self-trade prevention, multi-level walk, GTC partial rest, market walks all, cancel-by-id, cancel-all, risk-breach cancels remainder / no-breach / default (14 tests in `clob.rs`)
- ✅ OrderBook — place single/multi same-price FIFO / different prices; remove head/tail/only-at-level clears best; persistence roundtrip; GTC survives batch; cancel-by-id (wrong user / unknown id); modify-qty (decrease/increase/zero/below-filled/wrong-user/no-change); serialize/deserialize buffer-too-small (24 tests in `book.rs`)
- ✅ OrderType / Side enum round-trip + is_cancel helper
- ✅ Batch state transitions + revealed-order pack/unpack roundtrip
- ✅ Vault initialize / insurance payout arithmetic
- ✅ Portfolio new / recalc_margin / find_position
- ✅ Commitment hash determinism (different sides, prices, salts, users, order_types, instruments, reduce_only flags) + same-input equality
- ✅ RevealOrder storage + CommitmentStatus + BatchStatus transitions
- ✅ CloseCommitting close_slot + shuffle_seed are recorded (and are equal); seed is `close_slot`, NOT the predictable `commit_deadline_slot`
- ✅ SettleBatch wire format constants; maker-rebate / taker-fee / net protocol fee delta math (positive and negative cases)
- ✅ LiquidateUser portfolio-health + PnL (long lower-bound, short upper-bound) + insurance payout (full and partial coverage)
- ✅ CPI wire layouts pinned for all 4 paths: CancelResting (disc 1, 41B), ModifyResting (disc 2, 49B), ClearAndMatch (disc 3, header + 53B/order), CLOB results (2B header + 49B/fill)
- ✅ Common math: VWAP bounded, PnL sign + symmetry, IM scales linearly, MM ≤ IM, tick/lot alignment idempotency, div rounding modes, wide-mul safe, funding payment symmetry (with Kani proofs in `#[cfg(kani)] mod kani_proofs`)

**Untested (gaps in unit coverage):**

| File | Missing tests | Why it matters |
|---|---|---|
| `programs/perps-core/src/instructions/deposit.rs` | All `process_deposit` paths | SOL CPI to system program, portfolio principal/equity update, free-collateral correctness |
| `programs/perps-core/src/instructions/withdraw.rs` | All `process_withdraw` paths | free-collateral gate, vault balance gate, lamport transfer, principal/equity decrement, underflow detection |
| `programs/perps-core/src/instructions/init_portfolio.rs` | PDA bump + zero-init | First-write safety for portfolio PDA |
| `programs/perps-core/src/instructions/initialize.rs` | Registry + instrument first-write | Required for any later instruction |
| `programs/perps-core/src/instructions/add_instrument.rs` | Governance gate, instrument_count increment, duplicate-id detection | Instrument list growth |
| `programs/perps-core/src/entrypoint.rs` | Discriminator dispatch (all 13 variants) | Public surface — each disc must route correctly |
| `programs/perps-matcher/src/entrypoint.rs` | Discriminator dispatch (all 4 variants) | Public surface |
| `programs/perps-matcher/src/instructions.rs` | `process_compute_clearing`, `process_cancel_resting`, `process_modify_resting`, `process_clear_and_match` | All wire-format decode + book mutation + result write |
| `programs/common/src/account.rs` | `validate_owner`, `validate_writable`, `borrow_account_data(_mut)` | Used in every instruction |
| `programs/common/src/lib.rs` + `programs/oracle/src/entrypoint.rs` | Oracle entrypoint dispatch | Public surface |
| `programs/perps-core/src/pda.rs` | PDA seeds: portfolio/batch/instrument/registry/vault/commitment | Wrong seeds = wrong accounts |
| Edge cases in `commit_order.rs` | Reject when batch not in `Committing`; reject when portfolio mismatch; reject when free_collateral < deposit | Auth + state guards |
| Edge cases in `reveal_order.rs` | Reject when batch not in `Revealing`; reject when commitment already revealed; reject when commitment.user != signer | Auth + state guards |
| Edge cases in `clear_batch.rs` | Reject when batch not in `Revealing`; reject when 0 commitments; warn-and-skip on un-revealed commitments | State guards |
| Edge cases in `settle_batch.rs` | Non-revealed commitment → slash + insurance credit; multiple commitments from same user aggregated; empty results | End-to-end settle |
| Edge cases in `liquidate_user.rs` | Reject when portfolio healthy; reject when no positions; oracle inactive → error; short position upper-bound mark | Liquidator safety |
| Edge cases in `cancel_resting_order.rs` / `modify_resting_order.rs` | Reject when not signer; reject when portfolio mismatch; reject when book not matcher-owned | Authorization + ownership |

### 2. Integration tests (BPF .so + solana-program-test)

Single integration test file: `programs/perps-core/tests/lifecycle.rs`.

**Covered:**
- ✅ `test_initialize_writes_registry_and_instrument` (gated on `BPF_OUT_DIR`) — proves the pinocchio↔solana-program-test wiring works: BPF .so loads, dispatch fires, accounts become writable

**Gaps (declared OOS in plan §6j.9, follow-up tasks in §6k.1):**
- [x] `CommitOrder` → `RevealOrder` → `CloseCommitting` → `ClearBatch` (real CPI to matcher) → `SettleBatch` driving a real fill *(2026-06-16 — `test_e2e_full_lifecycle_with_fill`)*
- [x] GTC order that rests in batch N and matches in batch N+1 — proves book persistence through the full pipeline, not just matcher-side as in `book.rs::test_gtc_survives_persistence_then_matches_next_batch` *(2026-06-16 — `test_e2e_gtc_rests_then_matches_next_batch`)*
- [ ] Multi-instrument batch — each instrument has its own book PDA; per-instrument `instrument_id` must dispatch to the correct book
- [ ] `CancelRestingOrder` end-to-end through CPI to matcher (deposit → commit → reveal → clear → cancel by order_id; verify book is empty)
- [ ] `ModifyRestingOrder` end-to-end through CPI to matcher
- [ ] `LiquidateUser` end-to-end — deposit → match → mark price move → liquidate → insurance claim → bad-debt accounting
- [ ] Reject paths through full BPF: unauthorized signer, wrong PDA, wrong program owner, malformed wire data — these are pure instruction-validation paths, perfect for solana-program-test
- [ ] Two-instrument commit-reveal in the same batch — both books update, both portfolios settle

**Test harness conventions** (`programs/perps-core/tests/lifecycle.rs`):
- `program_test_with_pdas()` — loads both perps programs, pre-seeds registry + instrument + **vault + book (matcher-owned)** in genesis
- `derive_user_pdas(user, batch_id, nonce) -> UserPdas` — derives the portfolio / batch / commitment PDAs + bumps for a single user
- `seed_user_accounts(pt, &UserPdas)` — adds the per-user PDAs to genesis at the right sizes (uses `core::mem::size_of::<T>()` for in-crate state types; `mgk_perps_matcher::state::book::book_account_size()` for the matcher-owned book)
- Data builders `build_*_data(...)` — one per instruction; mirror the post-disc wire layouts from `programs/perps-core/src/entrypoint.rs` byte-for-byte
- `submit(&mut ctx, ix, &[&signer, ...])` helper — wraps `Transaction::new_signed_with_payer` with `ctx.payer` as fee payer
- Run: `BPF_OUT_DIR=target/deploy cargo test -p mgk-perps-core --test lifecycle --features host-hash`
- `host-hash` feature activates the host-side SHA-256 fallback (`sha2` crate) — `sol_sha256` is a BPF-only syscall

### 3. Cross-program CPI

The 4 CPI paths are pinned by wire-format tests but not exercised end-to-end:
- ❌ Core `ClearBatch` → Matcher `ClearAndMatch` (disc 3): wire format pinned, but no test drives the full CPI in a BanksClient context
- ❌ Core `CancelRestingOrder` → Matcher `CancelResting` (disc 1): wire format pinned
- ❌ Core `ModifyRestingOrder` → Matcher `ModifyResting` (disc 2): wire format pinned
- ❌ Core `SettleBatch` reads matcher-written results account: only header constants pinned, not the decode/apply path in a real program-test

### 4. Negative / adversarial tests (gaps)

`docs/ai/design/feature-onchain-perps-dex.md` calls out a list of security properties that should be tested:
- ❌ Commitment integrity (revealed must match stored hash) — partially tested in `commit_order.rs`/`reveal_order.rs` but not in BanksClient
- ❌ No over-withdrawal (≤ free_collateral) — not tested
- ❌ Self-trade prevention end-to-end through CPI — not tested
- ❌ Reduce-only enforcement (clamp size to current position, never flip side) — design L215 calls this out; not implemented or tested
- ❌ Liquidation never improves margin (monotonic) — design L763 — not tested

## Success Criteria

A change is "tested" when:
1. All new pure-logic functions have inline `#[test]` cases for happy path + at least one error path
2. All new wire formats have a `test_*_layout_is_stable` or `test_*_discriminator_is_n` test
3. Any new instruction has at least one end-to-end test in `programs/perps-core/tests/lifecycle.rs` (gated on `BPF_OUT_DIR`)
4. Any new CPI path has both wire-format pin tests AND a real end-to-end CPI test
5. `cargo test --all-features` passes
6. `cargo clippy --all-targets --all-features -- -D warnings` passes

## Edge Cases (priority order)

| Priority | Case | Where |
|---|---|---|
| P0 | Full commit→reveal→close→clear→settle with a real fill | ✅ `lifecycle.rs::test_e2e_full_lifecycle_with_fill` (plan §6j.9.2) |
| P0 | GTC rests in batch N, matches in batch N+1 | ✅ `lifecycle.rs::test_e2e_gtc_rests_then_matches_next_batch` (plan §6j.9.3) |
| P0 | Self-trade prevention end-to-end | `lifecycle.rs` follow-up |
| P0 | LiquidateUser with insurance claim | `lifecycle.rs` follow-up |
| P1 | Multi-instrument batch | `lifecycle.rs` follow-up |
| P1 | CancelRestingOrder / ModifyRestingOrder end-to-end | `lifecycle.rs` follow-up |
| P1 | Authorization rejects (wrong signer, wrong PDA, wrong owner) | `lifecycle.rs` follow-up |
| P1 | Reduce-only enforcement (not yet implemented) | new instruction + tests |
| P2 | Funding rate accrual (not yet implemented) | new instruction + tests |
| P2 | Mark price (depth-weighted composite) | new instruction + tests |
| P2 | Pause flags (not yet implemented) | new instruction + tests |
| P2 | Liquidation optimizer / ADL (not yet implemented) | new instruction + tests |
| P3 | Property-based tests (proptest) on the CLOB (conservation, monotonic) | `programs/common/src/tests.rs` (dev-only proptest allowed) |
| P3 | Kani proofs: conservation, no-over-withdrawal, liquidation progress, batch atomicity, funding zero-sum (design L760-768) | `programs/common/src/math.rs` already has 10 Kani proofs; expand to cover portfolio/inventory invariants |

## Available Mocks / Stubs / Fixtures

- **`ProgramTest` (solana-program-test)** — in-process bank; `target/deploy/mgk_perps_core.so` + `target/deploy/mgk_perps_matcher.so` are loaded; PDAs pre-seeded
- **Host-side SHA-256 fallback** — `feature = "host-hash"` substitutes the `sol_sha256` BPF syscall with a `sha2`-backed implementation. Identical output (verified by `test_hash_matches_bpf_implementation`)
- **Test-only risk callback** — `clob.rs::risk_breach_after(cap)` sets a static atomic cap that the per-fill callback reads; lets tests trigger risk breach deterministically
- **`BookState::new()` / `serialize_book_state` / `deserialize_book_state`** — in-memory book state with raw `#[repr(C)]` copy; pin the on-disk layout
- **Public account helpers in `percolator-common`** — `validate_owner`, `validate_writable`, `borrow_account_data(_mut)`; the same code paths the BPF entrypoint uses

## CI / Test Commands

```sh
cargo test --all-features                            # all unit + integration tests
cargo clippy --all-targets --all-features -- -D warnings   # CI lint
cargo build-sbf                                       # produce target/deploy/*.so
BPF_OUT_DIR=target/deploy \
  cargo test -p mgk-perps-core --test lifecycle \
    --features host-hash                             # BPF-backed integration tests
```

## Known Flaky / Slow

- `lifecycle.rs` requires `BPF_OUT_DIR=target/deploy` and the BPF .so to be built. CI should run `cargo build-sbf` before invoking it.
- `test_book_pda_derivation_runtime` in `book.rs` is `#[ignore]` — it calls the `find_program_address` syscall which is only available on a Solana runtime; skip in normal CI.

## Deferred (post-MVP, per plan)

- Pyth oracle integration (currently uses fallback-only)
- Kani conservation / no-over-withdrawal / liquidation-progress proofs
- Multisig governance
- Keeper bots
- Lazy funding accrual on portfolio touch
- E2E tests with local validator (deferred per plan L222)

## Status

- **Inline unit coverage**: comprehensive for matcher (shuffle, queue, book, CLOB) and CLOB-relevant core instructions (settle_batch, commit_order, reveal_order, close_committing, clear_batch, liquidate_user, cancel/modify_resting). Gaps in pure state-machine instructions (deposit, withdraw, init_portfolio, initialize, add_instrument) and entrypoint dispatch.
- **Integration coverage**: 3 e2e tests in `lifecycle.rs` (all gated on `BPF_OUT_DIR`). Plan §6j.9 follow-up tasks 6j.9.2 + 6j.9.3 done; 6j.9.4 (multi-instrument) and 6j.9.5 (cancel/modify/liquidation/reject paths) still open.
- **Clippy**: clean.
- **Total**: 156 passing, 1 ignored, 0 failing.

## M7 Pre-Testnet Critical Tests

These tests must be written alongside (or after) the M7 implementation tasks.

| M7 Task | Required Tests | Priority |
|---------|----------------|----------|
| 7.1 Batch creation | 2-batch lifecycle (settle → create next → commit/reveal/clear/settle again) | P0 |
| 7.2 Deposit return | Deposit locked → settle → im reduced; deposit slashed → insurance credited | P0 |
| 7.3 Reveal deadline | Reveal before deadline ok; reveal after deadline rejected | P0 |
| 7.4 Funding accrual | Positive/negative funding; zero-sum conservation; skip when no position | P0 |
| 7.5 Mark price | Book mid computation; oracle fallback; carry-forward on no fills | P0 |
| 7.6 Risk callback | Insufficient margin cancels remaining fills | P0 |
| 7.7 Liquidation safety | Full flat (existing); cancel orders first; hedge-preserving skip; ADL ranking | P1 |
| 7.8 PauseFlags | Paused instruction rejected; unpause allows; cancel allowed during trading pause | P1 |
