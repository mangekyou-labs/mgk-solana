---
phase: implementation
title: mgk On-Chain Perps DEX — Check Implementation Report (Short-Batch Cycle)
description: File-by-file comparison of shipped code against the design doc and the 2026-07-03 Short-Batch requirements amendment. Covers 4 Pinocchio programs, uncommitted on-chain changes, M8 adoption status, and short-batch compatibility. Verified 2026-07-03.
status: complete
---

# mgk On-Chain Perps DEX — Check Implementation Report (2026-07-03)

> **Historical.** This file is the 2026-07-03 short-batch **commit-reveal** check.
> Active DFBA matching superseded it on 2026-08-02. Phase 7 DFBA alignment
> (2026-08-20) lives in
> `docs/ai/implementation/2026-08-02-feature-onchain-perps-dex-dfba.md`
> (section “Check Implementation”). Do not implement new commit-reveal work
> from this report.

> **Check Implementation (Phase 7) output (2026-07-03).** Compares `programs/*` against `docs/ai/design/feature-onchain-perps-dex.md` and `docs/ai/requirements/2026-06-18-feature-onchain-perps-dex.md` (as amended 2026-07-03 by the Short-Batch Decision).
>
> **Scope delta vs. 2026-07-01 report:** The requirements doc was amended 2026-07-03 to (a) shrink commit-reveal batch windows from 30–60s to ~2–4s p50, (b) downgrade the MEV claim from "resistant" to "mitigated," (c) add a pre-signed reveal relayer persona + success criterion #13, (d) add short-batch latency success criterion #12, and (e) add open items #9–14. This report re-verifies on-chain alignment under the amended requirements and reviews the uncommitted on-chain diff (20 files, +1216/−431).

## Design Summary

**Architecture:** Fully on-chain perpetual futures DEX on Solana using a commit-reveal CLOB. Four programs:

1. **perps-core** (`mgk-perps-core`) — Portfolio management, batch lifecycle (commit → reveal → clear → settle), commitment registry, collateral vault, CLOB state ownership, funding accrual, mark price, custody (sole fund-moving authority).
2. **perps-matcher** (`mgk-perps-matcher`) — Price-time priority CLOB matching, Fisher-Yates shuffle (seeded by close_slot), structural priority queues (cancels → ALO → regular), self-trade prevention, risk callbacks per fill.
3. **oracle** (`percolator-oracle`) — Fallback price feed (admin-pushed, auto-activate on staleness).
4. **common** (`percolator-common`) — Shared account validation, errors, math, types.

**Key principles:** Pinocchio (not Anchor), no_std, zero-allocation, single-byte discriminators. Core is sole custody authority. Core → Matcher one-way CPI. PDA-controlled vaults. 3-layer safety stack: liquidation optimizer → insurance fund → ADL.

**Amended target (2026-07-03):** Short-batch commit-reveal with T_min=2 slots (~0.8s), T_reveal=3 slots (~1.2s), T_max=15 slots (~6s). Target ~2–3s p50, <8s p99 end-to-end. Pre-signed reveal via permissionless relayer eliminates slash risk from tight reveal windows. MEV posture: "mitigated" (not "resistant"). On-chain programs require NO structural changes for short-batch — only governance parameter updates. Work is frontend (dual-sign) + new relayer bot + param tuning.

## Alignment Status: MEDIUM (downgraded from HIGH on 2026-07-01)

The 2026-07-01 report rated alignment HIGH against the then-current requirements. The 2026-07-03 requirements amendment adds 6 new success criteria (#8–13) and 6 new open items (#9–14), most of which are **not yet implemented** in on-chain code. The core CLOB + safety stack + batch lifecycle remain HIGH alignment. The M8 adoptions and short-batch operational tooling (relayer) are NOT YET SHIPPED, which lowers overall alignment to MEDIUM.

### Requirements Success Criteria — Status

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | All Rust tests pass (≥316) | ⚠️ AT RISK | 322 tests per build-context, BUT lifecycle integration test `build_initialize_data` uses stale registry offsets (see Deviation #7) — would fail on BPF. Uncommitted changes not yet validated by `cargo test`. |
| 2 | Clippy clean | ⚠️ UNVERIFIED | Uncommitted on-chain changes (20 files) not yet clippy-validated in this phase. Last verified clean 2026-07-01. |
| 3 | SBF builds, no stack overflow | ⚠️ UNVERIFIED | Matcher BSS scratch refactor (`.data.S` sections) is in the uncommitted diff. Not yet `cargo build-sbf` validated in this phase. Previous M7.7.R-R4b gate held. |
| 4 | Three devnet-deployed programs | ✅ Match | Per build-context: perps-core `3jYQ4mp...`, matcher `AU4EKQAQ...`, oracle `6M9eEiDK...`. All executable. |
| 5 | E2E batch lifecycle on devnet | ✅ Match | ClearBatch + SettleBatch txs verified 2026-07-01 (signatures in prior report). |
| 6 | Liquidation path tested on devnet | ⚠️ NOT VERIFIED | Not exercised in this phase; prior report did not confirm a live liquidation tx. |
| 7 | PauseFlags gates live on devnet | ✅ Shipped | `SetPauseFlags` (disc 0xE) + `PAUSE_TRADING/WITHDRAWALS/LIQUIDATIONS/FUNDING` gates in commit_order, reveal_order, withdraw, liquidate_user, settle_batch. `registry.rs:12-16`. |
| 8 | Multi-venue oracle live on devnet | ❌ NOT SHIPPED | No `MultiVenuePrice` account, no `PostMultiVenuePrice` instruction, no keeper registration. Open item #4–6. |
| 9 | Freshness-based mark price active | ❌ NOT SHIPPED | `mark_price.rs` has no multi-venue blend; only depth-weighted book mid + Pyth/admin fallback. Open item (M8-B). |
| 10 | Toxic-taker detection observable | ❌ NOT SHIPPED | No `FlowQualityScore` account, no flow-quality scoring in matcher/risk_callback. Open item #7 (M8-C). |
| 11 | Insurance-fund inventory visible | ❌ NOT SHIPPED | `Vault` has no `insurance_base_reserves`/`insurance_quote_reserves` fields. Open item #8 (M8-D). |
| 12 | Short-batch latency on devnet | ⚠️ PARTIAL | Batch params (T_min/T_reveal/T_max/N_min) are governance-configurable via `Initialize` — code supports short-batch values. Defaults in test code are still OLD (T_min=10, T_max=150, T_reveal=25). No devnet param tuning or load test performed. |
| 13 | Pre-signed reveal relayer operational | ⚠️ CODE-READY / TOOLING MISSING | `RevealOrder` requires `user_account.is_signer()` (reveal_order.rs:38) — a pre-signed tx carries the user's signature, so on-chain check passes when relayer submits. Compatible. But relayer bot (open item #9) and frontend dual-sign flow (open item #10) are NOT built. |

### Open Items Status

| # | Item | Status |
|---|------|--------|
| 1 | M7.8 PauseFlags | ✅ DONE |
| 2 | Branch hygiene | ⚠️ `feature-mgk-frontend` has 20 uncommitted on-chain files + many untracked — needs commit/merge |
| 3 | M7.7 design deviations backfill | ⚠️ Not backfilled into design doc |
| 4 | MultiVenuePrice account + instruction | ❌ NOT STARTED |
| 5 | Keeper key registration | ❌ NOT STARTED |
| 6 | MultiVenuePrice aggregation logic | ❌ NOT STARTED |
| 7 | Toxic-taker scoring parameters | ❌ NOT STARTED |
| 8 | Insurance fund inventory fields | ❌ NOT STARTED |
| 9 | Reveal relayer bot | ❌ NOT STARTED |
| 10 | Frontend dual-sign flow | ❌ NOT STARTED (frontend repo) |
| 11 | Governance param tuning on devnet | ❌ NOT STARTED |
| 12 | Grant proposal amendment | ⚠️ Doc-only; check planning doc |
| 13 | Relayer fee model | ❌ NOT DESIGNED |
| 14 | Pre-signed tx blockhash expiry | ❌ NOT VALIDATED |

## Core Program Instructions (design vs. shipped)

| Disc | Design | Shipped | Status |
|------|--------|---------|--------|
| 0 | Initialize | Initialize | ✅ Match (registry layout CHANGED — see Deviation #7) |
| 1 | InitPortfolio | InitPortfolio | ✅ Match |
| 2 | Deposit | Deposit | ✅ Match |
| 3 | Withdraw | Withdraw | ✅ Match |
| 4 | CommitOrder | CommitOrder | ✅ Match |
| 5 | RevealOrder | RevealOrder | ✅ Match (relayer-compatible via pre-signed tx) |
| 6 | CloseCommitting | CloseCommitting | ✅ Match |
| 7 | ClearBatch | ClearBatch | ✅ Match |
| 8 | SettleBatch | SettleBatch | ✅ Match |
| 9 | LiquidateUser | LiquidateUser | ✅ Match |
| A(10) | AddInstrument | AddInstrument | ✅ Match |
| B(11) | CancelRestingOrder | CancelRestingOrder | ✅ Match |
| C(12) | ModifyRestingOrder | ModifyRestingOrder | ✅ Match |
| D(13) | CancelAllRestingOrders | CancelAllRestingOrders | ✅ Match |
| E(14) | SetPauseFlags | SetPauseFlags | ✅ Match |
| 15 | — | InitVault | 🆕 Operational (Solana 4.x PDA creation) |
| 16 | — | CreateBatch | 🆕 Operational (batch lifecycle bootstrap) |
| 17 | — | SetBatchCounter | 🆕 Governance utility (reset counter) |
| 18 | — | CreatePortfolio | 🆖 Known bug (invoke_signed seed pointer) |
| 19 | — | InitPortfolioForUser | 🆕 Workaround for disc 18 (keeper pre-creation) |
| 0x10 | M8-A design: PostMultiVenuePrice | — | ❌ NOT IMPLEMENTED (open item #4) |

## Matcher Program Instructions (design vs. shipped)

| Disc | Design | Shipped | Status |
|------|--------|---------|--------|
| 0 | ShuffleAndMatch | ComputeClearing | 🔄 Decomposed |
| 1 | — | CancelResting | 🆕 Decomposed |
| 2 | — | ModifyResting | 🆕 Decomposed |
| 3 | — | ClearAndMatch | 🔄 Full flow |
| 4 | — | CancelAll | 🆕 Decomposed |

**Verdict:** Design specified 1 monolithic instruction. Implementation decomposed into 5 modular instructions. Reasonable architectural refinement. Matcher requires no changes for M8 per design (§784).

## Oracle Program Instructions (design vs. shipped)

| Disc | Design | Shipped | Status |
|------|--------|---------|--------|
| 0 | Initialize | Initialize | ✅ Match |
| 1 | SetPrice | UpdatePrice | ✅ Rename (cosmetic) |
| 2 | SetAuthority | SetAuthority | ✅ Match |
| 3 | Activate | Activate | ✅ Match |
| 4 | Deactivate | Deactivate | ✅ Match |
| 0x10 | M8-A design: PostMultiVenuePrice | — | ❌ NOT IMPLEMENTED (open item #4) |

## File-by-File Review

### programs/perps-core/src/

| File | Role | Notes |
|------|------|-------|
| `entrypoint.rs` (~968) | Disc dispatch + account validation | 20 instructions (0-19). Two-layer pattern intact. Initialize data length gate raised 128→140 bytes for new registry fields. Governance signer check added to Initialize. |
| `instructions/initialize.rs` (141) | Registry + first instrument init | **BREAKING**: Registry layout changed (governance@0, instrument_count@32, volatility_multiplier@34, batch_id_counter@36, base_deposit@44, n_min@52, t_min@56, t_max@64, t_reveal@72, bump@80, pause_flags@81). Direct byte-offset ptr writes for BPF alignment. |
| `instructions/commit_order.rs` (~184) | Hashed order submission | Deposit locking, nonce, hash verification. PAUSE_TRADING gate. |
| `instructions/reveal_order.rs` (304) | Reveal + hash check | `user_account.is_signer()` (line 38) — **relayer-compatible**: pre-signed tx carries user sig. PAUSE_TRADING gate. Reveal deadline `current_slot > reveal_deadline_slot` (inclusive deadline). Slashing on miss. |
| `instructions/clear_batch.rs` (~230) | CPI to matcher | Sends revealed orders + close_slot. |
| `instructions/settle_batch.rs` (1290) | Position update + funding + vault | Largest file. Mark price, funding accrual, deposit return, insurance fund. PAUSE_FUNDING skips funding step. Creates next batch (commit_deadline = current_slot + t_max_slots). |
| `instructions/liquidate_user.rs` (413) | Safety stack entry | PAUSE_LIQUIDATIONS gate. Hedge-preserving optimizer → insurance → ADL. |
| `instructions/create_portfolio.rs` (~125) | PDA creation via CPI | **Known bug:** `invoke_signed` seed pointer fails on BPF (disc 18). |
| `instructions/init_portfolio_for_user.rs` (166) | Keeper pre-creation workaround | disc 19. Uses `invoke_signed` with SystemProgram::CreateAccount + `pinocchio::seeds!` macro. Idempotent in-place init. 2 tests. |
| `instructions/create_batch.rs` (146) | Batch bootstrap | disc 16. Direct byte-offset writes for BPF alignment. Reads t_max_slots for commit_deadline. disc 17 `SetBatchCounter` (governance reset) in same file. |
| `instructions/init_vault.rs` (19) | Vault init | disc 15. In-place init. |
| `instructions/set_pause_flags.rs` (97) | Emergency pause | disc 0xE. Masks reserved bits 4-7. |
| `state/registry.rs` (237) | Protocol config + instrument registry | **CHANGED layout** (86 bytes total). New fields: instrument_count, volatility_multiplier, batch_id_counter. Pause flags + helpers. Defaults in `new()` test helper still OLD (n_min=5, t_min=10, t_max=150, t_reveal=25) — should be updated to short-batch values for clarity. |
| `state/portfolio.rs` (181) | Cross-margin account | Positions, IM/MM, health, funding checkpoint. Unchanged. |
| `state/liquidation.rs` (762) | Liquidation optimizer | Impact-ratio ranking, hedge-preserving, 10 rounds. Unchanged. |
| `state/funding.rs` (523) | Funding rate computation | Positive/negative, zero-sum conservation. No multi-venue input. Unchanged. |
| `state/mark_price.rs` (351) | Mark price blend | Book mid + oracle fallback, freshness-weighted. **No multi-venue blend** (M8-B not implemented). |
| `state/vault.rs` (164) | Collateral vault | PDA-controlled, insurance fund tracking. **No base_reserves/quote_reserves** (M8-D not implemented). |

### programs/perps-matcher/src/ (~5,900 lines)

| File | Role | Notes |
|------|------|-------|
| `instructions.rs` (977+) | Core matching logic | **Major BSS scratch refactor** (M7.7.R-R4b): `static mut S: [u8; 22KB]` + per-array scratch (`SORD`, `SCAP`, `SCBU`, `SCSL`, `SCPR`, `SCFL`, `SCEB`, `SCES`, `SCP0`, `SQUE`) in `.data.S` link section. `*_into` result-sink variants. `scratch_reset()` at entry. ComputeClearing, CancelResting, ModifyResting, ClearAndMatch, CancelAll. |
| `state/clob.rs` (1110) | CLOB matching engine | `clob_match_with_caps_into` / `clob_match_with_risk_into` in-place variants. Price-time priority, book walk, self-trade prevention, risk callback. |
| `state/book.rs` (1032) | Persistent order book | `zeroed_in_place()` BPF-safe init. `Default`/`new()` gated `#[cfg(not(target_os = "solana"))]`. Place/remove/modify, FIFO per level, serialize/deserialize. |
| `state/clearing.rs` (741) | Clearing pipeline | `BuyEntry`/`SellEntry` moved to `pub(crate)` for scratch access. `compute_clearing` gated `#[cfg(not(target_os = "solana"))]`. `compute_clearing_into` BPF variant with scratch arrays. |
| `state/queue.rs` (344) | Priority queues | Cancels → ALO → regular. |
| `state/shuffle.rs` (184) | Fisher-Yates PRNG | splitmix64, seeded by close_slot. Unchanged. |

### programs/oracle/src/

| File | Role | Notes |
|------|------|-------|
| `entrypoint.rs` | 5 instructions (0-4) | Initialize, UpdatePrice, SetAuthority, Activate, Deactivate. Admin-pushed fallback. No `PostMultiVenuePrice` (M8-A not implemented). |

### programs/common/src/

| File | Role | Notes |
|------|------|-------|
| `program_ids.rs` | Hardcoded program IDs | perps-core `3jYQ4mp...`, matcher `AU4EKQAQ...`. Updated to devnet deploy. |
| `error.rs` | Shared PercolatorError | Ranges 0-99 common, 500-599 anti-toxicity (reserved, unused). |
| `math.rs` | Checked arithmetic, Kani proofs | Unchanged. |
| validation helpers | validate_owner/writable/signer, borrow_account_data(_mut) | Unchanged. |

## Deviations & Severity

| # | Deviation | Severity | Follow-up |
|---|-----------|----------|-----------|
| 1 | +5 Core instructions (15-19) beyond design | Low | Document in design doc as operational bootstrap |
| 2 | CreatePortfolio (18) `invoke_signed` bug | Medium | InitPortfolioForUser (19) workaround; long-term pinocchio fix |
| 3 | Matcher decomposed 1→5 instructions | Low | Update design doc |
| 4 | M8-A multi-venue oracle not shipped | **High** | Blocks success criteria #8. Open items #4-6. Implement `MultiVenuePrice` + `PostMultiVenuePrice` (disc 0x10) + keeper registration. |
| 5 | M8-B freshness mark-price blend not shipped | **High** | Blocks success criterion #9. Extend `mark_price.rs` with multi-venue freshness blend. |
| 6 | M8-C toxic-taker detection not shipped | **High** | Blocks success criterion #10. New `FlowQualityScore` account + risk_callback pre-fill scoring. |
| 7 | M8-D insurance inventory fields not shipped | **High** | Blocks success criterion #11. Add `insurance_base_reserves`/`insurance_quote_reserves` to `Vault` + optimizer tiebreaker. |
| 8 | Reveal relayer bot not built | **High** | Blocks success criterion #13. Open item #9. ~100 LOC off-chain bot. |
| 9 | Frontend dual-sign flow not built | **High** | Blocks success criterion #13. Open item #10. Frontend repo. |
| 10 | Governance param tuning not done | Medium | Blocks success criterion #12. Open item #11. Set T_min=2, T_reveal=3, T_max=15 on devnet + load test. |
| 11 | Registry layout changed (128→140 bytes) | **Critical** | `tests/lifecycle.rs::build_initialize_data` still uses OLD offsets (base_deposit@32, n_min@40, t_min@44, t_max@52, t_reveal@60). New parser expects (base_deposit@44, n_min@52, t_min@56, t_max@64, t_reveal@72). **Integration test is broken.** Update test offsets + SDK encoder to match new layout. |
| 12 | Uncommitted on-chain changes (20 files) | Medium | Branch hygiene (open item #2). Commit + validate (clippy/test/build-sbf) before further work. |
| 13 | Test default params still long-batch | Low | `registry.rs::new()` uses n_min=5, t_min=10, t_max=150, t_reveal=25. Update to short-batch defaults for clarity (does not affect governance-configured runtime). |
| 14 | Book account is matcher-owned keypair on devnet | Medium | Add matcher InitializeBook instruction (prior deviation, unresolved) |

## Edge Cases Handled

- ✅ BPF alignment: `initialize_in_place()` corrupts data on BPF → direct byte-offset ptr writes (initialize, create_batch, registry)
- ✅ `.bss`/`.data.S` NOBITS → BSS scratch in `.data.S` link section for matcher stack safety (M7.7.R-R4b)
- ✅ Matcher stack overflow → `*_into` in-place variants + per-array BSS scratch (`SORD`, `SCAP`, `SCBU`, etc.)
- ✅ `compute_clearing` host-only gating (`#[cfg(not(target_os = "solana"))]`) so BPF uses `compute_clearing_into`
- ✅ SDK `encodeCommitOrder` off-by-one → corrected byte offsets (prior fix)
- ✅ Fisher-Yates shuffle seeded by `close_slot` (not `commit_deadline`)
- ✅ Self-trade prevention, risk callback per fill, slashing, emergency pause (4 independent flags), GTC persistence
- ✅ Reveal deadline inclusive: `current_slot == reveal_deadline_slot` allowed; `> reveal_deadline_slot` fails

## Short-Batch Compatibility Assessment

**On-chain programs require NO structural changes for short-batch** (confirms requirements assumption). Evidence:

1. **Batch params governance-configurable**: `Registry` fields `n_min`, `t_min_slots`, `t_max_slots`, `t_reveal_slots` set via `Initialize` and read by `CloseCommitting` (reveal_deadline = close_slot + t_reveal_slots), `CreateBatch` (commit_deadline = current_slot + t_max_slots), `SettleBatch` (next batch commit_deadline).
2. **RevealOrder relayer-compatible**: `user_account.is_signer()` (reveal_order.rs:38) is satisfied by a pre-signed transaction submitted by a relayer — the runtime validates the signature regardless of who submits. No code change needed.
3. **No batch-length hardcoding**: All timing logic uses the configurable registry fields, not constants.

**What IS needed (not on-chain):**
- Governance param tuning on devnet (open item #11): set T_min=2, T_reveal=3, T_max=15
- Reveal relayer bot (open item #9): ~100 LOC off-chain
- Frontend dual-sign flow (open item #10): frontend repo

## Test Results (UNVERIFIED in this phase)

| Suite | Prior count (2026-07-01) | This phase | How to re-verify |
|-------|--------------------------|------------|------------------|
| Rust unit tests (4 crates) | 322 | ⚠️ UNVERIFIED — uncommitted changes + broken lifecycle test offsets | `cargo test --all-features` after fixing lifecycle offsets |
| Clippy | clean | ⚠️ UNVERIFIED | `cargo clippy --all-targets --all-features -- -D warnings` |
| SBF build | clean | ⚠️ UNVERIFIED — matcher `.data.S` refactor | `cargo build-sbf` + check 0 stack-overflow lines |
| Frontend (Vitest + Playwright) | 632 | Not in scope (frontend repo) | `pnpm -r test && pnpm exec playwright test` |

## What Shipped (Summary)

- **4 Pinocchio programs** — ~22,200+ lines of no_std Rust (uncommitted delta +1216/−431)
- **3 programs deployed to Solana devnet** — all executable (perps-core, matcher, oracle)
- **Real on-chain trading lifecycle proven** — ClearBatch + SettleBatch txs verified (2026-07-01)
- **Safety stack** — liquidation optimizer, insurance fund, ADL, emergency pause (4 independent flags)
- **Commit-reveal CLOB** — Fisher-Yates shuffle, priority queues, price-time matching, GTC persistence
- **BPF stack safety** — matcher BSS scratch refactor (`*.data.S` link section, `*_into` variants)
- **Operational bootstrap** — 5 new instructions (15-19) for Solana 4.x PDA/account creation

## What Is NOT Shipped (gaps vs. amended requirements)

- **M8-A multi-venue oracle** — `MultiVenuePrice` account + `PostMultiVenuePrice` instruction + keeper registration (blocks #8)
- **M8-B freshness mark-price blend** — multi-venue blend in `mark_price.rs` (blocks #9)
- **M8-C toxic-taker detection** — `FlowQualityScore` account + risk_callback scoring (blocks #10)
- **M8-D insurance inventory** — `base_reserves`/`quote_reserves` in `Vault` + optimizer tiebreaker (blocks #11)
- **Reveal relayer bot** — ~100 LOC off-chain bot (blocks #13)
- **Frontend dual-sign flow** — frontend repo (blocks #13)
- **Devnet short-batch param tuning + load test** (blocks #12)
- **Lifecycle test offset fix** — registry layout change not reflected in integration test (blocks #1)

## Next Steps

1. **Critical**: Fix `tests/lifecycle.rs::build_initialize_data` offsets to match new 140-byte registry layout (Deviation #11). Run `cargo test --all-features` + `cargo clippy --all-targets --all-features -- -D warnings` + `cargo build-sbf` to re-verify success criteria #1-3.
2. **Commit uncommitted on-chain changes** (Deviation #12, open item #2) — branch hygiene.
3. **Decide M8 sequencing**: implement M8-A through M8-D (Deviation #4-7) OR defer M8 and ship short-batch first (relayer + param tuning + frontend dual-sign). Recommendation: **ship short-batch first** — it's the core product-risk assumption and requires no on-chain changes; M8 is additive defensive layering.
4. **Update design doc** to reflect: (a) registry layout change, (b) instructions 15-19, (c) short-batch param defaults, (d) M8 implementation status as "not started."
5. **Proceed to `dev-testing`** then `dev-review` after the lifecycle test fix + clippy/test/build-sbf re-verification. If M8 is in-scope for this phase, return to `dev-design` for M8 account/instruction design before Execute Plan.

## See also

- `docs/ai/requirements/2026-06-18-feature-onchain-perps-dex.md` — amended 2026-07-03 (Short-Batch Decision)
- `docs/ai/design/feature-onchain-perps-dex.md` — full architecture
- `docs/ai/implementation/2026-07-01-feature-onchain-perps-dex.md` — prior Check Implementation report
- `.superstack/build-context.md` — operational state, test inventory, deployment status
