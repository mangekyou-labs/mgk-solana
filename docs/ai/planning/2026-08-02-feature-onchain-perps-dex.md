---
phase: planning
title: On-Chain Perps DEX — DFBA Migration Plan
description: Task plan to migrate matching from commit-reveal CLOB to pure Dual Flow Batch Auction (DFBA). Supersedes active matching work in the historical commit-reveal plan.
status: in-progress
feature: onchain-perps-dex
requirements: docs/ai/requirements/2026-06-18-feature-onchain-perps-dex.md
design: docs/ai/design/feature-onchain-perps-dex.md
created: 2026-08-02
updated: 2026-08-03
---

# On-Chain Perps DEX — DFBA Migration Plan

## Context

**v1 matching is pure DFBA** (requirements + design, 2026-08-02). Commit-reveal, Fisher-Yates shuffle, structural priority queues, and the reveal relayer are out of scope.

**Already shipped (historical M1–M8 + M9 DFBA core):**

| Area | Status | DFBA action |
|------|--------|-------------|
| Oracle / multi-venue index path | Partial / planned M8 | Retarget to **index only** (not mark) — T9.4.3–4 open |
| Portfolio, vault, deposit/withdraw | Done | Keep |
| Liquidation optimizer, insurance, ADL | Done (some simplifications) | **Gate on batch `mark_valid`** ✅ T9.4.1 |
| Commit/reveal/batch lifecycle | Replaced | Collecting(Committing) → Clearing → Settled + PostOrder |
| Matcher DFBA dual auction | Done | disc 5 `DfbaClear`; host + BPF e2e |
| Cancel/modify resting | Done | Works with `is_maker` flag |
| Pause flags | Partial | Post gated by `trading_paused`; T9.4.2 full matrix open |
| Frontend PostOrder | **Done (minimal)** | `usePostOrder` + maker toggle; polish deferred |
| Testing / e2e | Dual fill + one-sided liq pause ✅ | Rest-across-batch / cancel e2e still open |

**Programs:** `perps-core`, `perps-matcher`, `mgk-oracle`, `mgk-common` (Pinocchio, single-byte discs).

**Non-goals in this plan:** full frontend redesign, grant/`ARCHITECTURE.md` rewrite, toxic-taker scoring, multi-ix sub-batching, off-chain solver, third-party venue model copy.

## Design parameters (locked — implement as defaults)

| ID | Value | Code notes |
|----|--------|------------|
| D1 | `t_batch_min=1`, `target=2`, `max=4` slots | Init/registry still use legacy t_max=150 in tests; **T9.3.5** for governance params |
| D2 | `per_batch_order_cap=64` (scratch max 128) | `DFBA_MAX_ORDERS=64`; **T9.1.7** CU not yet measured |
| D3 | `taker_fee_bps=5`, makers free | Init uses taker 5; maker still **−2 rebate** until T9.3.5/fee policy |
| D4 | Round-down dust to protocol | Allocation path |
| D5 | Collecting → Clearing → Settled | Committing alias for Collecting |
| D6 | Mark valid only on current dual clear | ClearBatch + SettleBatch |
| D7 | Funding mark vs index; skip if invalid/stale | **Skip if !mark_valid** ✅; index-staleness T9.4.4 open |
| D8 | Overflow: best price → size → order_id | `select_by_price_priority` |
| D9 | `BatchCleared` + `Fill` events | Indexer path partial; formal events TBD |
| D10 | Retire commit/reveal; rewrite matcher clear | Commit/Reveal return InvalidInstruction |

## Milestones

### M9.0 — Prep & contracts
**Goal:** Shared types and invariants before code churn.

- [x] **T9.0.1** Spec wire format for flat clear pack ✅  
- [x] **T9.0.2** Batch DFBA fields + Collecting==Committing ✅  
- [ ] **T9.0.3** Error codes for DFBA  
  - **Outcome:** dedicated errors (cap, mark invalid on liquidate, pause post/clear) vs overloading `OperationPaused` / `InvalidInstruction`.  
  - **Validation:** `PercolatorError` ranges + SDK `humanizeError`  
  - **Tests:** T-ERROR-MAP  

### M9.1 — Matcher DFBA core (critical path) ✅ almost complete

- [x] **T9.1.1** `compute_clearing` ✅  
- [x] **T9.1.2** `compute_allocation` ✅  
- [x] **T9.1.3** Self-trade filter ✅  
- [x] **T9.1.4** Cap selection / overflow ✅  
- [x] **T9.1.5** `DfbaClear` disc 5 ✅ book collect + sequential bid/ask heap path  
- [x] **T9.1.6** Stack / scratch discipline ✅ fits default 32KB heap  
- [ ] **T9.1.7** CU spike at cap=64 (and 32/128)  
  - **Outcome:** measured CU numbers in implementation notes; adjust default cap if needed.  
  - **Tests:** T-DFBA-CU-GATE  

### M9.2 — Book + PostOrder path ✅

- [x] **T9.2.1** RestingOrder / LimitOrder `is_maker` ✅  
- [x] **T9.2.2** Core `PostOrder` disc 20 + matcher `PlaceResting` disc 6 ✅  
  - Also: increments `batch.total_commitments`; batch account writable  
- [x] **T9.2.3** CommitOrder / RevealOrder retired ✅  
- [x] **T9.2.4** Cancel/modify with role flag ✅  

### M9.3 — Batch lifecycle rewrite (core) ✅ core path; params open

- [x] **T9.3.1** Batch DFBA fields ✅ size 160 pinned  
- [x] **T9.3.2** Close → Clearing (skip reveal) ✅  
- [x] **T9.3.3** ClearBatch CPI DfbaClear (book collect) ✅  
- [x] **T9.3.4** Settle dual mark + DFBA fill apply + fees ✅  
  - Instrument init `#[repr(C)]` fee offsets fixed (taker@52, maker@54, mark@136)  
- [ ] **T9.3.5** `SetBatchParams` governance  
  - **Outcome:** slots, cap, fee defaults (makers free), marginal_size_cap, index staleness.  
  - **Tests:** T-BATCH-PARAMS  

### M9.4 — Risk, pause, oracle role ⚠️ partial

- [x] **T9.4.0** Funding skip when `!mark_valid` (and `funding_paused`) ✅  
- [x] **T9.4.1** LiquidateUser requires settled batch `mark_valid` / !`liq_paused` ✅  
  - Account list: + batch after liquidator; SDK docs updated  
- [ ] **T9.4.2** Pause flags: post + clear; remove reveal coupling  
  - **Outcome:** SetPauseFlags matrix; clear/post gates documented.  
  - **Tests:** T-PAUSE-POST, T-PAUSE-CLEAR  
- [ ] **T9.4.3** Mark path: no oracle blend  
  - **Outcome:** dual clear only for mark; oracle for funding index only.  
  - **Tests:** T-MARK-NO-ORACLE  
- [ ] **T9.4.4** Index freshness for funding only  
  - **Outcome:** stale index → skip funding; does not set mark.  
  - **Tests:** T-INDEX-FUNDING  
- [ ] **T9.4.5** Insurance inventory fields (if not done)  
  - **Tests:** T-INSURANCE-INV  

### M9.5 — Tests, e2e, docs hygiene ⚠️ e2e partial

- [x] **T9.5.1** DFBA testing doc ✅  
- [x] **T9.5.2** Matcher suite green ✅ ~110 tests  
- [x] **T9.5.3** Lifecycle unit sims (dual / one-sided / self-trade) ✅ host  
- [x] **T9.5.4** BPF e2e dual fill + fees ✅ `test_e2e_full_lifecycle_with_fill`  
- [x] **T9.5.5a** BPF e2e one-sided liq pause ✅ `test_e2e_dfba_one_sided_liq_paused`  
- [ ] **T9.5.5b** BPF e2e rest across batch with role  
- [ ] **T9.5.5c** BPF e2e self-trade (optional; host covered)  
- [ ] **T9.5.5d** BPF e2e cancel between batches  
- [x] **T9.5.6** Implementation notes ✅ `docs/ai/implementation/2026-08-02-feature-onchain-perps-dex-dfba.md`  
- [x] **T9.5.7** Frontend minimal PostOrder UI ✅ (trade page + form maker toggle)  

### M9.6 — Indexer + SDK ✅

- [x] **T9.6.1** DFBA results + batch decode ✅  
- [x] **T9.6.2** SDK encoders + keeper DFBA crank ✅  

### M9.7 — Explicitly deferred (not blocking M9 DoD)

- Full frontend UX / mark_valid display polish  
- Grant proposal + public ARCHITECTURE rewrite  
- Toxic-taker scoring  
- Multi-ix sub-batch deep books  
- Raising cap above CU-proven value  
- Formal on-chain `BatchCleared` event IDL  

## Sequencing

```text
M9.0–M9.3 core path ── DONE (except T9.0.3, T9.3.5)
M9.4 risk/oracle ──── T9.4.0–1 DONE; T9.4.2–5 OPEN
M9.5 e2e ──────────── dual + one-sided DONE; rest/cancel OPEN
M9.6 consumers ────── DONE
```

**Critical path remaining:** T9.4.2–3 (pause + pure mark) → T9.5.5b (rest e2e) → T9.1.7 (CU) → T9.3.5 (params)  

**Parallelizable:** T9.0.3 errors; T9.4.5 insurance; T9.5.5d cancel e2e  

## Test scenario → task map

| Scenario ID | Description | Task(s) | Status |
|-------------|-------------|---------|--------|
| T-DFBA-* core | Uniform dual auction math | T9.1.* | ✅ |
| T-POST-ORDER | Single-tx post | T9.2.2 | ✅ |
| T-NO-COMMIT-REVEAL | Old path dead | T9.2.3 | ✅ |
| T-E2E-DFBA-FILL | Dual fill + fees | T9.5.4 | ✅ |
| T-E2E-LIQ-PAUSE | One-sided mark invalid | T9.5.5a | ✅ |
| T-E2E-REST | Rest across batch | T9.5.5b | ⬜ |
| T-LIQ-MARK-GATE | Liq needs mark_valid | T9.4.1 | ✅ |
| T-FUNDING-SKIP | Skip if !mark_valid | T9.4.0 | ✅ |
| T-PAUSE-* | Pause matrix | T9.4.2 | ⬜ |
| T-MARK-NO-ORACLE | Pure dual mid | T9.4.3 | ⬜ |
| T-DFBA-CU-GATE | CU at cap 64 | T9.1.7 | ⬜ |
| T-BATCH-PARAMS | Governance params | T9.3.5 | ⬜ |

## Risks & blockers

| Risk | Status / mitigation |
|------|---------------------|
| Account layout Batch/Instrument | Batch size 160 pinned; instrument init offsets fixed 2026-08-03 |
| CU at cap 64 | **Still unmeasured** (T9.1.7) |
| Stack overflow on clear | Mitigated: sequential dual clear + slim scratch |
| Mark often invalid on thin book | Product risk accepted; UI should show last mid |
| Legacy lifecycle e2es | Commit-reveal tests early-return skip; rewrite or delete |
| Makers free (D3) vs −2 rebate | Align in T9.3.5 |
| Deployment/monitoring docs | lint MISSING for feature (optional later phase) |

## Definition of done (M9)

| # | Criterion | Status |
|---|-----------|--------|
| 1 | `cargo test` / clippy clean | ⚠️ use `+stable` for core; clippy not re-run every session |
| 2 | `cargo build-sbf` no stack overflow | ✅ matcher + core |
| 3 | E2E dual fill + rest across batch | ⚠️ dual fill ✅; rest ⬜ |
| 4 | Uniform price + role + self-trade tests | ✅ host |
| 5 | Mark valid / liq pause | ✅ e2e one-sided |
| 6 | Immediate cancel/modify | ✅ code; cancel e2e ⬜ |
| 7 | Taker fees; makers free | ⚠️ fees work; makers still rebate until T9.3.5 |
| 8 | Cap overflow behavior | ✅ unit |
| 9 | Pause post/clear | ⬜ T9.4.2 |
| 10 | CU documented at cap | ⬜ T9.1.7 |

## Progress (2026-08-03)

**Shipped since plan open:** full DFBA critical path on-chain (PostOrder → CloseCollecting → DfbaClear → Settle), funding skip, liquidate mark gate, instrument fee layout, frontend PostOrder, SDK/keeper, dual + one-sided BPF e2e.

**Evidence (latest):**
- `mgk-perps-matcher` lib ~110 pass  
- `mgk-perps-core` lib ~196 pass (`+stable`, host-hash)  
- SDK vitest 158 pass  
- lifecycle: `test_e2e_full_lifecycle_with_fill`, `test_e2e_dfba_one_sided_liq_paused` ok under `SBF_OUT_DIR=target/deploy`

**Open task count (M9):** ~10 (T9.0.3, T9.1.7, T9.3.5, T9.4.2–5, T9.5.5b–d)

## Next actions (prioritized)

1. **T9.5.5b** — BPF e2e: unfilled maker rests into next batch with role (closes DoD #3 gap).  
2. **T9.4.2 + T9.4.3** — Pause matrix + pure dual mark (no oracle blend on mark path).  
3. **T9.1.7** — Measure CU at cap 32/64/128; document in implementation notes.  

**Coordination:** Redeploy core/matcher after instrument init offset fix; results accounts must be **matcher-owned**. LiquidateUser callers must pass **Settled batch** with `mark_valid`.

## Historical plan

Prior commit-reveal milestones M1–M8 remain in `docs/ai/planning/README.md` as audit trail. **Do not implement new commit-reveal work from that file.** Active matching/lifecycle work is **this document (M9)**.

## Summary

M9 DFBA migration is **past the critical path**: dual auction, PostOrder, batch lifecycle, settle fills/fees, mark/liq gates, SDK/keeper, and dual/one-sided BPF e2e are green. Remaining work is **hardening and product alignment** — rest-across-batch e2e, pause/mark purity, funding index staleness, governance batch params (makers free + slot caps), CU measurement, and DFBA-specific error codes. Frontend has a minimal PostOrder path; full UX polish stays deferred (M9.7).
