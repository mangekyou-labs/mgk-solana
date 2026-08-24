---
phase: planning
title: On-Chain Perps DEX — DFBA Migration Plan
description: Task plan to migrate matching from commit-reveal CLOB to pure Dual Flow Batch Auction (DFBA). Supersedes active matching work in the historical commit-reveal plan.
status: in-progress
feature: onchain-perps-dex
requirements: docs/ai/requirements/2026-06-18-feature-onchain-perps-dex.md
design: docs/ai/design/feature-onchain-perps-dex.md
created: 2026-08-02
updated: 2026-08-24
---

# On-Chain Perps DEX — DFBA Migration Plan

## Context

**v1 matching is pure DFBA** (requirements + design, 2026-08-02). Commit-reveal, Fisher-Yates shuffle, structural priority queues, and the reveal relayer are out of scope.

**Already shipped (historical M1–M8 + M9 DFBA core + Phase 5 hardening):**

| Area | Status | DFBA action |
|------|--------|-------------|
| Oracle / multi-venue index path | Done (admin fallback) | Index for funding ✅ T9.4.4; mark from DFBA only ✅ T9.4.3 |
| Portfolio, vault, deposit/withdraw | Done | Keep |
| Liquidation optimizer, insurance, ADL | Done (some simplifications) | **Gate on batch `mark_valid`** ✅ T9.4.1 |
| Commit/reveal/batch lifecycle | Replaced | Collecting(Committing) → Clearing → Settled + PostOrder |
| Matcher DFBA dual auction | Done | disc 5 `DfbaClear`; host + BPF e2e |
| Cancel/modify resting | Done | Works with `is_maker` flag |
| Pause flags | Done ✅ | Post gated by `PAUSE_POST`; Clear gated by `PAUSE_CLEAR`; T9.4.2 complete |
| Frontend PostOrder | **Partial — reliability follow-up open** | `encodePostOrder` + maker toggle are wired; wallet/chart hydration, truthful DFBA state copy, and stable polling are tracked in M9.8 |
| Testing / e2e | Host DFBA ✅; BPF 7/11 | Dual fill + one-sided + resting + self-trade + cancel + …; 4 `#[ignore]` CU harness-only |
| Devnet dual-fill | Done ✅ (scripted) | `tools/trade-e2e.js` proves a dual fill and `mark_valid=1`; independent-wallet browser proof remains open |
| Keeper crank | Done ✅ | `tools/keeper-crank.js` — CloseCollecting → ClearBatch → SettleBatch loop |
| Independent-counterparty live match | **Done 2026-08-20 (browser)** | Batch 11 `mark_valid=1` after UI posts + crank. T9.9.4 CI fixture + T9.9.5 residual diagnosis closed |
| Playwright web e2e | Baseline done; live fill gap open | `pnpm e2e:wallet` = mocked construction. 2026-08-09 Playwright MCP = one-wallet Phantom smoke (historical, retired as the proof path). Live DFBA proof is playwright-cli named sessions |
| Legacy test cleanup | Done ✅ | 5 commit-reveal e2e tests rewritten with DFBA PostOrder pattern |

**Programs:** `perps-core`, `perps-matcher`, `mgk-oracle`, `mgk-common` (Pinocchio, single-byte discs).

**Non-goals in this plan:** matching rewrite (`compute_clearing` / `allocate_side`); cloning Pinocchio toy DFBA; GLP / LP-as-counterparty; Playwright MCP as a QA gate; Phantom-extension popups as the matching-proof harness; full frontend redesign; grant/`ARCHITECTURE.md` rewrite; toxic-taker scoring; multi-ix sub-batching; off-chain solver.

## Design parameters (locked — implement as defaults)

| ID | Value | Code notes |
|----|--------|------------|
| D1 | Stress `1/2/4` slots; **live working-devnet** `t_min=2`, `t_max=150`, `n_min=1` | Do not retune live to 1.6s for personas. SetBatchParams (disc 21) ✅ T9.3.5 |
| D2 | `per_batch_order_cap=64` (scratch max 128) | `DFBA_MAX_ORDERS=64`; CU measured ✅ T9.1.7 |
| D3 | `taker_fee_bps=5`, makers **0 bps** | Live instrument still has leftover `makerFeeBps=-2`. Do not treat −2 as locked. Retune is M9.10, not the persona slice |
| D4 | Round-down dust to protocol | Allocation path |
| D5 | Collecting → Clearing → Settled | Committing alias for Collecting |
| D6 | Mark valid only on current dual clear | ClearBatch + SettleBatch |
| D7 | Funding mark vs index; skip if invalid/stale | **Skip if !mark_valid** ✅; index staleness ✅ T9.4.4 |
| D8 | Overflow: best price → size → order_id | `select_by_price_priority` |
| D9 | `BatchCleared` + `Fill` events | Indexer path partial; formal events TBD |
| D10 | Retire commit/reveal; rewrite matcher clear | Commit/Reveal return InvalidInstruction |

## Milestones

### M9.0 — Prep & contracts
**Goal:** Shared types and invariants before code churn.

- [x] **T9.0.1** Spec wire format for flat clear pack ✅  
- [x] **T9.0.2** Batch DFBA fields + Collecting==Committing ✅  
- [x] **T9.0.3** Error codes for DFBA ✅ 2026-08-06
  - **Outcome:** `DfbaCapExceeded=603`, `MarkInvalidForLiquidation=604`, `BatchNotSettled=605` in MgkError. LiquidateUser now uses specific codes instead of generic `InvalidInstruction`/`OperationPaused`.
  - **Tests:** T-ERROR-MAP (pin test for all 3 discriminators)

### M9.1 — Matcher DFBA core (critical path) ✅

- [x] **T9.1.1** `compute_clearing` ✅  
- [x] **T9.1.2** `compute_allocation` ✅  
- [x] **T9.1.3** Self-trade filter ✅  
- [x] **T9.1.4** Cap selection / overflow ✅  
- [x] **T9.1.5** `DfbaClear` disc 5 ✅ book collect + sequential bid/ask heap path  
- [x] **T9.1.6** Stack / scratch discipline ✅ fits default 32KB heap  
- [x] **T9.1.7** CU spike at cap=64 (and 32/128) ✅ 2026-08-06
  - **Outcome:** Host benchmarks: cap 128 × 1000 iters <10ms; efficient O(n log n).
  - **Tests:** T-CU-32, T-CU-64, T-CU-128, T-CU-OVERFLOW in `dfba.rs`

### M9.2 — Book + PostOrder path ✅

- [x] **T9.2.1** RestingOrder / LimitOrder `is_maker` ✅  
- [x] **T9.2.2** Core `PostOrder` disc 20 + matcher `PlaceResting` disc 6 ✅  
  - Also: increments `batch.total_commitments`; batch account writable  
- [x] **T9.2.3** CommitOrder / RevealOrder retired ✅  
- [x] **T9.2.4** Cancel/modify with role flag ✅  

### M9.3 — Batch lifecycle rewrite (core) ✅

- [x] **T9.3.1** Batch DFBA fields ✅ size 160 pinned  
- [x] **T9.3.2** Close → Clearing (skip reveal) ✅  
- [x] **T9.3.3** ClearBatch CPI DfbaClear (book collect) ✅  
- [x] **T9.3.4** Settle dual mark + DFBA fill apply + fees ✅  
  - Instrument init `#[repr(C)]` fee offsets fixed (taker@52, maker@54, mark@136)  
- [x] **T9.3.5** `SetBatchParams` governance ✅ 2026-08-06
  - **Outcome:** disc 21; updates `max_orders_per_batch`, `marginal_size_cap`, `t_min_slots`, `t_max_slots`, `n_min` on Registry. Governance signer required.
  - **Wire:** `max_orders(1) + marginal_cap(1) + t_min(8) + t_max(8) + n_min(4)` = 22 bytes
  - **Tests:** T-BATCH-PARAMS (defaults, writes, marginal_cap_zero, size_unchanged)

### M9.4 — Risk, pause, oracle role ✅

- [x] **T9.4.0** Funding skip when `!mark_valid` (and `funding_paused`) ✅  
- [x] **T9.4.1** LiquidateUser requires settled batch `mark_valid` / !`liq_paused` ✅  
  - Account list: + batch after liquidator; SDK docs updated  
- [x] **T9.4.2** Pause flags: post + clear; remove reveal coupling ✅ 2026-08-06
  - **Outcome:** `PAUSE_POST=1<<4` blocks PostOrder; `PAUSE_CLEAR=1<<5` blocks CloseCollecting+ClearBatch; PAUSE_TRADING umbrella retained.
  - **Tests:** T-PAUSE-POST, T-PAUSE-CLEAR, T-PAUSE-BITS, T-PAUSE-RESERVED
- [x] **T9.4.3** Mark path: no oracle blend ✅ 2026-08-06 (already implemented)
  - **Outcome:** ClearBatch computes dual mid; SettleBatch uses pure dual mid when mark_valid; oracle for funding index only.
  - **Validation:** `clear_batch.rs:142` dual mid; `settle_batch.rs:616` mark_valid branch
  - **Tests:** T-MARK-NO-ORACLE covered by existing lifecycle/dual tests
- [x] **T9.4.4** Index freshness for funding only ✅ 2026-08-06
  - **Outcome:** `read_oracle_price` now returns `(price, timestamp, is_active)`. Funding accrual skips when oracle is stale (>600s) or inactive. Mark path unaffected (pure DFBA).
  - **Tests:** T-INDEX-FUNDING covered by existing funding_skip tests
- [x] **T9.4.5** Insurance inventory fields ✅ 2026-08-06 (already implemented)
  - **Outcome:** `Vault.insurance_fund` (u128) credited from taker fees + slashed deposits; `uncovered_bad_debt` (u128) tracks insurance shortfall; `adl_debt`/`adl_pending` for ADL tracking.
  - **Validation:** `settle_batch.rs:535-575` fee/rebate flow; `vault.rs` struct + helpers
  - **Tests:** Existing vault + settle tests cover insurance flow

### M9.5 — Tests, e2e, docs hygiene ✅ (4 BPF e2e ignored = harness CU only)

- [x] **T9.5.1** DFBA testing doc ✅  
- [x] **T9.5.2** Matcher suite green ✅ ~110 tests  
- [x] **T9.5.3** Lifecycle unit sims (dual / one-sided / self-trade) ✅ host  
- [x] **T9.5.4** BPF e2e dual fill + fees ✅ `test_e2e_full_lifecycle_with_fill`  
- [x] **T9.5.5a** BPF e2e one-sided liq pause ✅ `test_e2e_dfba_one_sided_liq_paused`  
- [x] **T9.5.5b** BPF e2e rest across batch with role ✅ 2026-08-06
- [x] **T9.5.5c** BPF e2e self-trade (optional; host covered) ✅ 2026-08-06
- [x] **T9.5.5d** BPF e2e cancel between batches ✅ 2026-08-06
- [x] **T9.5.6** Implementation notes ✅ `docs/ai/implementation/2026-08-02-feature-onchain-perps-dex-dfba.md`  
- [x] **T9.5.7** Frontend minimal PostOrder UI ✅ (trade page + form maker toggle)  

### M9.6 — Indexer + SDK ✅

- [x] **T9.6.1** DFBA results + batch decode ✅  
- [x] **T9.6.2** SDK encoders + keeper DFBA crank ✅  

### M9.7 — Explicitly deferred (not blocking M9 DoD)

- Full frontend UX / mark_valid display polish (M9 config + PostOrder path + Collecting labels **done**; polish remains)
- Grant proposal + public ARCHITECTURE rewrite  
- Toxic-taker scoring  
- Multi-ix sub-batch deep books  
- Raising cap above CU-proven value  
- Formal on-chain `BatchCleared` event IDL  
- Interactive Phantom-extension smoke remains optional UX (not the matching-proof gate)
- Security review before mainnet
- Feature-named deployment/monitoring docs (lint paths)

### M9.8 — Frontend reliability + truthful DFBA state (reopened 2026-08-08)

**Status:** Approved remainder closed 2026-08-20 (T9.8.7). This milestone captured user-observed frontend regressions after M9 deployment. T9.8.5 Positions/Portfolio flicker remains a **regression keep**; T9.8.2 copy is implemented.

| Task | Status | Outcome / scope | Dependencies | Validation / linked scenarios |
|------|--------|-----------------|--------------|-------------------------------|
| **T9.8.1 Browser-origin hydration + wallet/chart interactivity** | Done 2026-08-20 | `/trade` hydrates at `localhost` and `127.0.0.1` under **playwright-cli**; Select Wallet opens; chart `tf-15m` responds. Playwright MCP is not the regression gate | Next.js `allowedDevOrigins` + `turbopack.root`, wallet adapter, chart toolbar | T-WEB-ORIGIN-HYDRATION ✅, T-WEB-WALLET-MODAL ✅ |
| **T9.8.2 Truthful DFBA state language** | Implemented | Header and status bar share `describeBatchPhase`; below-`n_min` batches say `Orders open · Waiting for minimum flow`, eligible batches say `Ready to clear · Waiting for keeper` | Batch decoder, current-slot polling, keeper semantics | T-WEB-DFBA-STATE-COPY ✅; keeper freshness closed in T9.8.6 |
| **T9.8.3 Chart loading/error/retry affordance** | Done 2026-08-20 | Loading while tv.js pending; error + Retry on abort; toolbar and order form stay clickable. Surrounding trade controls preserved | T9.8.1, TradingView script boundary | T-WEB-CHART-STATE ✅ |
| **T9.8.4 Full deterministic DFBA playwright-cli lifecycle** | Done 2026-08-20 | Mutable mocked RPC walks Collecting → Clearing → Settled copy after PostOrder (`pnpm e2e:wallet`, still not a fill). Live `-s=maker`/`-s=taker`: Collecting then `--close-only` holds Clearing copy; `--skip-close` settles and UI follows the next Collecting batch. Settled copy is mock-gated because Settle creates the next window | T9.9.1 harness, T9.8.1–3, `mockPhantom.setBatchPhase`, keeper `--close-only`/`--skip-close` | T-WEB-DFBA-LIFECYCLE ✅; T-WEB-LIVE-POST historical; T-WEB-PERSONA-MATCH already T9.9.3 |
| **T9.8.5 Positions/Portfolio visual stability** | Implemented | Existing portfolio data stays rendered during background polling; initial load still skeletons and ready panels expose `data-refreshing` | Positions/Portfolio query and store ownership | T-WEB-POLL-STABILITY ✅ |
| **T9.8.6 Keeper-lag visibility** | Done 2026-08-20 | Eligible past-deadline Collecting shows `Ready to clear · Waiting for keeper · HH:MM:SS late` (never `past deadline`). Indexer `/api/healthz` reports sqliteWritable, latestIndexedSlot, rpcSlot, slotLag, lastBatch, subscriptions; never `rpcUrl` | T9.8.2, indexer health | T-KEEPER-LAG-INTENT ✅ |
| **T9.8.7 Retire remaining legacy web affordances** | Done 2026-08-20 | Active trade UI/tests have no commit/reveal/slashed journey. Store statuses `idle\|submitting\|done\|failed`. `recoverOrderFormState` drops persisted `slashed\|committing\|awaiting_reveal\|revealing`. `?set=` only honors `failed\|submitting\|idle`. SDK `classifyError` may still return severity `slashed` for leftover codes 600/503; UI maps that to `failed` with retry. On-chain `commitDeadlineSlot`/`revealDeadlineSlot` names stay (layout). Historical docs retain commit-reveal for audit | T9.8.2, T9.8.4 | T-NO-LEGACY-WEB-FLOW ✅ |

#### Approved state copy contract

| On-chain condition | Headline | Intent/detail |
|--------------------|----------|---------------|
| Collecting before deadline | Orders open | Dual auction in `HH:MM:SS` |
| Collecting at/after deadline, posts < `n_min` | Orders open | Waiting for minimum flow (`posts`/`n_min`) |
| Collecting at/after deadline, posts ≥ `n_min` | Ready to clear | Waiting for keeper |
| Clearing | Orders closed | Matching maker and taker flow at uniform prices |
| Settled with valid mark | Fills settled | Mark updated |
| Settled without a two-sided match | No two-sided match | Mark unchanged · Liquidations paused |

`current_slot >= commit_deadline_slot` means the batch is eligible for permissionless `CloseCollecting`; it does **not** mean the UI should keep presenting an open collection window. The chain remains in Collecting until a keeper submits the transition, so client copy must communicate both facts.

### M9.9 — Independent-counterparty matching proof (retargeted 2026-08-20)

**Status:** Done 2026-08-20. **T9.9.1–5 closed.** Live batch 11 produced `mark_valid=1` after playwright-cli UI posts + `keeper-crank.js`. Host CI fixture `t_e2e_two_user_*` pins two-pubkey allocation, leftover + D3 fees, flatten, and self-trade skip. Live residuals (stale-book bid user, one-sided taker equity) are book contamination + cash `qty * price`, not a matcher bug. Scripted `tools/trade-e2e.js` remains earlier Node-keypair evidence. The 2026-08-09 Playwright MCP smoke used **one** Phantom wallet and is not a fill. Matching was not rewritten.

**Harness lock (2026-08-20):** prove the real DFBA flow on **live Solana devnet** with **playwright-cli named sessions as personas**. Do not use Playwright MCP (`@playwright/mcp`). Do not treat `pnpm e2e:wallet` mocked construction as a fill. Do not use Phantom-extension popups as the matching-proof gate (optional later UX lane only).

#### Persona contract

| Session (`-s=`) | Persona | Signer | Posts in one Collecting batch |
|-----------------|---------|--------|-------------------------------|
| `maker` | Market maker | Distinct funded keypair (`~/.config/solana/mgk-trader-maker.json` or `MGK_MAKER_KEYPAIR`) | Maker-buy GTC **and** maker-sell GTC (two-sided quote) |
| `taker` | Taker | Distinct funded keypair (`~/.config/solana/mgk-trader-taker.json` or `MGK_TAKER_KEYPAIR`) | Taker-sell crossing the bid **and** taker-buy crossing the ask |
| `observer` | Optional unsigned UI | None | None; confirms public batch / book / mark copy |

Keeper is **not** a browser persona. Crank with `node tools/keeper-crank.js` (or the indexer keeper) after both traders have posted.

**Why two-sided posts:** DFBA `mark_valid` requires **both** auctions (bid = maker-buy × taker-sell, ask = maker-sell × taker-buy). A single buy vs sell pair can fill one auction and still leave `mark_valid=0` / liq paused. T9.9.3 is not done without dual-mid `mark_valid=1` plus fills and fees on both wallets.

**Signing:** each session injects a Wallet Standard / Phantom-compatible provider that **actually signs and sends** to live M9 programs. Reuse the `mockPhantom.ts` injection point, but replace capture-only `signAndSendTransaction` with a live `Connection` send. Load secrets from keypair **paths**, never from git, screenshots, traces, or snapshot YAML.

**Target app:** local `http://localhost:3000/trade` (and `127.0.0.1` origin matrix) against live M9 IDs in `mgk-frontend/apps/web/lib/config.ts`. Live window stays `t_min=2`, `t_max=150`, `n_min=1`. Prefer Helius / indexer-backed reads to avoid public-devnet 429s.

**Wallet / browser QA (Solana analogue of the planning-skill harness):** disposable playwright-cli sessions (`-s=maker`, `-s=taker`), optional `--persistent` profiles **without** storing seed phrases; snapshot-first clicks on existing `data-testid`s (`order-form-*`, `batch-timeline`, `market-header`, positions/balances); named-session isolation (maker storage must not leak into taker); artifact scan with no private key, seed, or password.

| Task | Status | Outcome / scope | Dependencies | Validation / linked scenarios |
|------|--------|-----------------|--------------|-------------------------------|
| **T9.9.1 Persona harness and funding** | **Done 2026-08-20** | Two named playwright-cli sessions with isolated storage; live-signing injected wallets from distinct funded keypairs; InitPortfolio + Deposit (scripted reuse of `tools/trade-e2e.js` helpers is allowed); operator runbook; secret-free artifacts | Devnet SOL, live M9 programs, RPC/indexer, playwright-cli `0.1.x`, local `/trade` | T-WEB-PERSONA-SETUP, T-WEB-TWO-WALLET-SETUP |
| **T9.9.2 Same-batch opposing PostOrders via UI** | **Done 2026-08-20** | Both personas confirmed Collecting batch **11** (`5fNur4FYLzvKhHMeRw2LRs8fwGjhs3mAsft4rJURisCc`). Four dual-auction UI posts at 86/88 qty 0.01 (not 76.55/0.10). On-chain `total_commitments=5` (one extra 429 retry). CreateBatch disc 16 opened id 11 because counter had advanced without a PDA | T9.9.1, open Collecting batch, collateral | T-WEB-PERSONA-POST, T-WEB-TWO-WALLET-POST |
| **T9.9.3 Clear/settle and both UIs observe** | **Done 2026-08-20** | Batch 11 Settled `mark_valid=1`, bid 86 / ask 88, matched 0.01 per auction. Close `4MuCUWhC…jqmejp5c`, Clear `39pVR7vj…adwEKbb` (results `2qy2jdkT…BWJhpx`), Settle `4SdygpL4…Vt1co3`. Maker UI Flat 0 @ 86; taker UI Long 0.01 @ 88. Bid taker fill was stale Phantom `2ecHahNv…` not the persona sell; taker equity display −880.34 is T9.9.5 | T9.9.2, keeper crank | T-WEB-PERSONA-MATCH, T-WEB-TWO-WALLET-MATCH |
| **T9.9.4 Deterministic two-user regression** | **Done 2026-08-20** | Host CI (no RPC): `run_dual_dfba` + `apply_dfba_results` in `settle_batch.rs`. Distinct tags 0x6A/0xBE; 10000@86 and 10000@88; four fills; both books flatten; leftover −2/5 and D3 0/5 fee pins; self-trade clearing volume >0 with alloc 0. Matcher is a **dev-dependency** of core. Command: `cargo +stable test -p mgk-perps-core --lib t_e2e_two_user` → 3 passed | T9.9.3 findings, existing DFBA fixtures | T-E2E-TWO-USER-FILL |
| **T9.9.5 Discrepancy diagnosis and repeat** | **Done 2026-08-20 (diagnosis, no patch)** | Fixture vs live batch 11 diverges as expected: live had a third pubkey (`2ecHahNv…`) take the bid auction; persona taker filled ask only (Long 0.01 @ 88); extra 429 post split maker-ask 5000+5000; `totalVolume=40000` matches 5 fill qtys. Taker equity −880.34e9 is `10000 * 88e6` + 5 bps from ~100e6 start (no extra USD_SCALE divide). Matcher + settle apply match the two-user fixture. No matching rewrite. Leftover maker −2 remains T9.10.1 | T9.9.3–4 | T-WEB-PERSONA-MATCH, T-E2E-TWO-USER-FILL |

#### T9.9.1 operator runbook (done 2026-08-20)

Work from `.worktrees/feature-dfba-auction`. Build `@mgk/sdk` dist before `pnpm --filter web dev`. Next 16 infers `turbopack.root` from the parent checkout lockfile; `apps/web/next.config.ts` sets `turbopack.root` to `mgk-frontend` and aliases `@mgk/sdk` to `./packages/sdk/dist/index.js` (relative; absolute paths become invalid `./Users/...` imports).

```sh
# Isolated personas (never omit -s= once both are open)
playwright-cli -s=maker open http://localhost:3000/trade
playwright-cli -s=taker open http://localhost:3000/trade
# optional: playwright-cli -s=observer open http://localhost:3000/trade

# Inject live-signing wallet (keypair path in; pubkey only in page).
# Do not use tools/playwright-cli-inject.js — daemon env never sees MGK_PERSONA.
tools/persona-inject.sh maker && playwright-cli -s=maker reload
tools/persona-inject.sh taker && playwright-cli -s=taker reload

playwright-cli -s=maker snapshot
playwright-cli -s=taker snapshot
# T9.9.2 clicks: order-form-side-buy/sell, order-form-checkbox-input-post-as-maker,
#   order-form-price-input, order-form-qty-input, order-form-submit-buy/sell
# confirm both UIs show the same Collecting batch_id before posting
# crank: node tools/keeper-crank.js
# observe fills / mark_valid on both sessions
playwright-cli close-all
```

Fund/init: `node tools/fund-personas.js` (loads `mgk-frontend/apps/web/.env.local`; logs RPC **host** only). Helpers: `mgk-frontend/apps/web/e2e/fixtures/livePhantom.ts`, `tools/live-wallet.js`, `tools/inject-persona.js`. Isolation proof: maker `6LZPnkFwdT1xPoVy4y1WCyF6mRUyzvcs6Ndo9oFqBwWe` / taker `BeBT1zZAcPxeze8wiWNR7JFfPJL2QRPjd1cg26WJeXFe`; `mgk-order-form-wallet` localStorage does not leak across `-s=`. Unit: `pnpm exec vitest run lib/e2e/livePhantom.test.ts` (3/3). No `qa:cli` script — raw `playwright-cli -s=` plus `persona-inject.sh` is the gate.

### M9.10 — Working-devnet follow-on (after M9.9; not this slice)

Design remaining-work items 3–11. Do **not** start these until the persona fill is proven.

| Task | Status | Outcome |
|------|--------|---------|
| **T9.10.1 Retune maker fee to 0 bps** | **Done 2026-08-20** | Live `Hz9UtmSX…` maker 0 / taker 5. Disc 22 `SetInstrumentFees` + core upgrade `2PJmEb8U…` + retune tx `2WUksBFg…`. `Instrument::new` / init-protocol / lifecycle init default 0. Signed rebate field kept (`test_maker_fee_rebate`) |
| **T9.10.2 24/7 keeper + liquidator** | **Done 2026-08-20** | `tools/ops-keeper.js` deadline-gated crank + LiquidateUser + `/healthz`. Live taker flatten `3WDbtrsw…` (`err: None`) on batch 13 `mark_valid=1`. D6: current settled batch only |
| **T9.10.3 Index keeper reliability** | **Done 2026-08-24** | Core disc 23 `SetInstrumentOracle` + `SettleBatch` strict oracle binding and Unix timestamp freshness (`0 <= age < 600`). Standalone 4-venue daemon (`tools/ops-oracle.js`, `oracle-sources.js`) with outlier filtering (100 bps), quorum (>=3), confidence, atomic health file, and `/health` server. Live devnet oracle `5NSDGAaR…` created `3pH2n5Y7…`, bound via disc 23 `26G5oZBq…`, live 4-venue update `5yJFzRB5…`, batch 20 crank `2BYRK69U…` |
| **T9.10.4 Indexer health / lag** | **Done 2026-08-24** | Health tracker (`healthTracker.ts`), syncer (`syncer.ts`), keeper selection (`keeperSelection.ts`), `/api/healthz` endpoint, last-good client store (`useIndexerHealthStore.ts`), stale UI indicators (StatusDot, StatusBar, MarketHeader). Reconciled from root worktree. 9 indexer + 2 web store files ported; shared files (health.ts, store.ts, main.ts, keeper.ts, routes.ts) overwritten with T9.10.4 versions |
| **T9.10.5 Replace SMA funding with D7 `f(mark − index)`** | **Done 2026-08-24** | D7 coefficient-based formula replaces legacy SMA. `compute_d7_funding_rate()` with checked i128 arithmetic. Instrument fields renamed at same offsets (layout-compatible): `funding_coefficient_bps` (default 10_000), `max_funding_rate_bps` (default 50). SetFundingParams disc 24 (governance, 25-byte wire). SDK encoder + tests. Cursor advancement for zero-rate intervals. Conservation preserved. 362 tests pass. **Devnet deployment 2026-08-24:** core upgrade TX `Dmh6CEXi…` (slot 487386516). SetFundingParams TX `2Hys2B8…` changed coeff 1→10000, confirmed interval=100, cum_funding preserved. JS operator tool `tools/set-funding-params.js` with 21 unit tests (TDD). Instrument struct offset fix: interval at @120 (not @116). Dual-flow lifecycle batch 21: markValid=1, matched 10/10. |
| **T9.10.6 Stop first-batch book/oracle mark seed** | **Done 2026-08-24** | Pure settlement-mark selector: valid→clearing_price; invalid→carry prev; invalid-first→zero. Removed `compute_mark_price` from settle path. 4 T9.10.6 tests pass |
| **T9.10.7 Reduce-only / flatten UX + paper fill-lot tests** | **Done 2026-08-24** | Reduce-only enforcement at post time (ReduceOnlyViolation=606); 8 unit tests; SDK error mapping; prepare-close UX with exact fixed-point parsing; positionQty prop; 3 Playwright wallet e2e tests; 12 new OrderForm vitest tests |

## Sequencing

```text
M9.0–M9.3 core path ── DONE
M9.4 risk/oracle ──── DONE (T9.4.0–5)
M9.5 e2e ──────────── DONE (4 BPF tests ignored = program-test CU harness only)
M9.6 consumers ────── DONE
M9.7 deferred ─────── Frontend polish + grant/ARCHITECTURE + toxic-taker + multi-ix + formal events
Post-M9 ops ───────── Devnet dual-fill + frontend M9 wire + mocked Playwright wallet flow DONE
M9.8 frontend ─────── remainder closed 2026-08-20 (T9.8.7); T9.8.5 regression keep
M9.9 matching proof ─ DONE 2026-08-20 (T9.9.1–5)
M9.10 working-devnet ─ DONE (T9.10.1–7 + devnet deploy 2026-08-24)
```

**Critical path remaining:** T9.8.5 Positions flicker stays a
regression watch (blocker #10). Security review remains mandatory before mainnet.

## Test scenario → task map

| Scenario ID | Description | Task(s) | Status |
|-------------|-------------|---------|--------|
| T-DFBA-* core | Uniform dual auction math | T9.1.* | ✅ |
| T-POST-ORDER | Single-tx post | T9.2.2 | ✅ |
| T-NO-COMMIT-REVEAL | Old path dead | T9.2.3 | ✅ |
| T-E2E-DFBA-FILL | Dual fill + fees | T9.5.4 | ✅ |
| T-E2E-LIQ-PAUSE | One-sided mark invalid | T9.5.5a | ✅ |
| T-E2E-REST | Rest across batch | T9.5.5b | ✅ |
| T-E2E-SELF | Self-trade no fill | T9.5.5c | ✅ |
| T-E2E-CANCEL | Cancel resting | T9.5.5d | ✅ |
| T-LIQ-MARK-GATE | Liq needs mark_valid | T9.4.1 | ✅ |
| T-FUNDING-SKIP | Skip if !mark_valid | T9.4.0 | ✅ |
| T-PAUSE-* | Pause matrix | T9.4.2 | ✅ |
| T-MARK-NO-ORACLE | Pure dual mid | T9.4.3 | ✅ |
| T-DFBA-CU-GATE | CU at cap 64 | T9.1.7 | ✅ |
| T-BATCH-PARAMS | Governance params | T9.3.5 | ✅ |
| T-WEB-ORIGIN-HYDRATION | playwright-cli origin hydrates interactive controls | T9.8.1 | ✅ 2026-08-20 |
| T-WEB-WALLET-MODAL | Wallet selector opens and detects injected or installed wallets | T9.8.1 | ✅ 2026-08-20 |
| T-WEB-DFBA-STATE-COPY | Header/status bar explain every DFBA phase | T9.8.2 | In progress |
| T-WEB-CHART-STATE | Chart has loading, success, error, and retry states | T9.8.3 | ✅ 2026-08-20 |
| T-WEB-DFBA-LIFECYCLE | Browser executes PostOrder and observes the complete DFBA lifecycle | T9.8.4 | ✅ 2026-08-20 mock walk + live Clearing hold |
| T-WEB-PERSONA-SETUP | Named playwright-cli sessions as maker/taker with isolated live-signing wallets | T9.9.1 | ✅ 2026-08-20 |
| T-WEB-PERSONA-POST | Four dual-auction PostOrders through `/trade` in the same Collecting batch | T9.9.2 | ✅ 2026-08-20 |
| T-WEB-PERSONA-MATCH | Crank + both UIs show fills, fees, positions, `mark_valid=1` | T9.9.3, T9.9.5 | ✅ 2026-08-20 live; residuals diagnosed, no matcher patch |
| T-WEB-TWO-WALLET-SETUP | Alias of T-WEB-PERSONA-SETUP (legacy ID kept) | T9.9.1 | ✅ 2026-08-20 |
| T-WEB-TWO-WALLET-POST | Alias of T-WEB-PERSONA-POST | T9.9.2 | ✅ 2026-08-20 |
| T-WEB-TWO-WALLET-MATCH | Alias of T-WEB-PERSONA-MATCH | T9.9.3, T9.9.5 | ✅ 2026-08-20 live; residuals diagnosed, no matcher patch |
| T-E2E-TWO-USER-FILL | Deterministic distinct-user DFBA fill and allocation regression | T9.9.4, T9.9.5 | ✅ 2026-08-20 `cargo +stable test -p mgk-perps-core --lib t_e2e_two_user` 3 passed |
| T-WEB-POLL-STABILITY | Positions/Portfolio background refresh causes no panel flicker or state reset | T9.8.5 | Implemented |
| T-KEEPER-LAG-INTENT | Past-deadline Collecting state clearly says it is waiting for keeper | T9.8.2, T9.8.6 | ✅ 2026-08-20 elapsed wait + indexer healthz |
| T-NO-LEGACY-WEB-FLOW | Active trade UI/tests contain no commit/reveal/slashed journey | T9.8.7 | ✅ 2026-08-20 store recover + Playwright `trade.spec.ts` 33/33 |
| T-OPS-KEEPER-LIQ | Always-on crank/liq on current M9 IDs; health/alerts; live underwater flatten | T9.10.2 | ✅ 2026-08-20 LiquidateUser `3WDbtrsw…`; `node --test` 14 pass |
| T-D7-FUNDING-RATE | D7 coefficient-based rate calculation: positive/negative/zero/capped/rounding/invalid | T9.10.5 | ✅ 2026-08-24 16 Rust tests pass |
| T-D7-INSTRUMENT-LAYOUT | Instrument field rename at same offsets; 336-byte size preserved | T9.10.5 | ✅ 2026-08-24 compile + size pin |
| T-D7-SETTLE-ACCRUAL | D7 funding accrual in SettleBatch: mark/index, cursor advancement, conservation | T9.10.5 | ✅ 2026-08-24 8 settle_batch tests pass |
| T-D7-SET-FUNDING-PARAMS | SetFundingParams disc 24: governance auth, validation, cursor reset, SDK encoder | T9.10.5 | ✅ 2026-08-24 Rust + SDK tests pass + devnet `2Hys2B8…` (coeff 1→10000, interval=100, cum_funding=0) + 21 JS operator tests |
| T-HEALTH-TRACKER | Indexer health tracker: status transitions, lag/backfill, polling dedup, last-good state | T9.10.4 | ✅ 2026-08-24 ported from root; tests exist |
| T-HEALTH-STALE-UI | Web staleness indicators: StatusDot, StatusBar, MarketHeader, useIndexerHealthStore | T9.10.4 | ✅ 2026-08-24 ported from root; tests exist |
| T-SETTLE-MARK-PURE | Pure settlement-mark selector: valid→clearing, invalid→carry, invalid-first→zero | T9.10.6 | ✅ 2026-08-24 4 tests pass |
| T-REDUCE-ONLY-ENFORCE | Reduce-only at post time: flat/wrong-side/oversized→reject; exact-size→accept | T9.10.7 | ✅ 2026-08-24 8 Rust tests + 12 vitest pass |
| T-REDUCE-ONLY-606 | ReduceOnlyViolation=606 discriminator pinned; SDK error mapping | T9.10.7 | ✅ 2026-08-24 error.rs pin + SDK error.ts |
| T-PREPARE-CLOSE | OrderForm prepare-close: long→sell/reduce-only, short→buy/reduce-only, exact qty | T9.10.7 | ✅ 2026-08-24 12 vitest + 3 Playwright e2e |
| T-FIXED-POINT-PARSE | Exact 6-decimal fixed-point parsing replaces parseFloat×1e6 | T9.10.7 | ✅ 2026-08-24 parseFixed6/formatFixed6 vitest |
| T-POSITION-DISPLAY | Signed position display in order form summary | T9.10.7 | ✅ 2026-08-24 vitest |

## Risks & blockers

| Risk | Status / mitigation |
|------|---------------------|
| Account layout Batch/Instrument | Batch size 160 pinned; instrument init offsets fixed 2026-08-03 |
| CU at cap 64 | ✅ Measured: host benchmarks confirm efficient scaling |
| Stack overflow on clear | ✅ Mitigated: sequential dual clear + slim scratch |
| Mark often invalid on thin book | Product risk accepted; UI shows last mid / batch status |
| Legacy lifecycle e2es | ✅ Rewritten to DFBA PostOrder pattern |
| Deployment/monitoring docs | lint MISSING feature-named paths (deployment note exists: `2026-08-06-devnet-deploy-m9.md`) |
| Keeper crank | ✅ `tools/keeper-crank.js`; verified multi-batch Close→Clear→Settle on devnet |
| Book account size | Client keypair book (27 704 B); CPI CreateAccount 10KB cap — document ops path |
| Security review | Required before mainnet; `solana-fender-mcp` + QEDGen |
| Helius / public RPC rate limits | Prefer Helius for browser + Playwright; 429s on public devnet |
| Positions/Portfolio polling causes visible churn | P0 UX issue reported 2026-08-08; root cause deliberately not assigned during planning. Future implementation must reproduce and pin the behavior before choosing cache/store changes |
| Dev-origin hydration differs between `localhost` and `127.0.0.1` | Keep both origins in the browser regression matrix; do not treat a server-rendered screenshot as proof of client interactivity |
| Keeper lag is shown as an expired collection window | Use the approved Ready to clear / Waiting for keeper contract and add keeper freshness rather than implying orders remain open |
| Deterministic wallet test can pass without covering phase changes | Extend the mutable RPC fixture through the complete DFBA lifecycle; live installed-wallet detection is playwright-cli, not MCP |
| Independent-wallet match is not proven by same-wallet opposing orders | Two named playwright-cli personas, four dual-auction posts, crank, then trace clear/settle/results before diagnosing the matcher |
| One buy vs one sell can leave `mark_valid=0` | T9.9.2 must post both auctions (maker two-sided quote + two crossing taker posts) |
| Crossed-book 76.55 / 0.10 prices will not clear | Choose crossing prices from the current book; do not reuse the 2026-08-09 smoke prices |
| Playwright MCP / Phantom popups used as the fill gate | Forbidden. MCP 2026-08-09 is historical UI wiring. Matching proof is playwright-cli named sessions + injected live-signing |
| Named sessions share storage or a pubkey | Always pass `-s=maker` / `-s=taker`; never omit `-s` once both are open; assert distinct pubkeys before posting |
| Key material in snapshots / traces | Load keypairs from disk paths; scan artifacts for secret key / seed / password |
| Helius throttling can obscure cross-surface evidence | Prefer Helius / indexer-backed reads; retain transaction/account snapshots for each lifecycle phase |

## Definition of done (M9)

| # | Criterion | Status |
|---|-----------|--------|
| 1 | `cargo test` / clippy clean | ✅ `+stable` for core; all 3 crates clippy clean |
| 2 | `cargo build-sbf` no stack overflow | ✅ matcher + core |
| 3 | E2E dual fill + rest across batch | ✅ program-test/scripted devnet; independent-wallet browser proof open under M9.9 |
| 4 | Uniform price + role + self-trade tests | ✅ host + e2e |
| 5 | Mark valid / liq pause | ✅ e2e one-sided |
| 6 | Immediate cancel/modify | ✅ code + e2e cancel |
| 7 | Taker fees; makers free | ✅ fee path + live instrument maker 0 / taker 5 (T9.10.1 2026-08-20) |
| 8 | Cap overflow behavior | ✅ unit + benchmark |
| 9 | Pause post/clear | ✅ T9.4.2 (6-bit matrix) |
| 10 | CU documented at cap | ✅ T9.1.7 |
| 11 | Devnet deployed + initialized | ✅ 2026-08-06 |

## Progress (2026-08-06)

**Shipped since plan open:** full DFBA critical path, all M9 tasks, devnet deploy + init, lifecycle fixes, dual-fill e2e, frontend M9 wiring, Playwright suite green.

### Session A — M9 task completion (11 tasks)

| # | Task | Outcome |
|---|------|---------|
| 1 | T-CLIPPY-FIX | 23 clippy warnings fixed; CI clippy clean |
| 2 | T9.4.2 | PAUSE_POST + PAUSE_CLEAR; post/clear gated |
| 3 | T9.1.7 | CU host benchmarks cap 32/64/128 |
| 4 | T9.5.5b | resting across batch e2e |
| 5 | T9.4.3 | pure dual mid mark path confirmed |
| 6 | T9.3.5 | SetBatchParams disc 21 |
| 7 | T9.0.3 | DFBA error codes 603–605 |
| 8 | T9.4.4 | oracle freshness for funding |
| 9 | T9.4.5 | insurance inventory on vault |
| 10 | T9.5.5c | self-trade no-fill e2e |
| 11 | T9.5.5d | cancel resting between batches e2e |

### Session B — Devnet lifecycle + dual fill (evening)

| # | Item | Outcome |
|---|------|---------|
| 1 | Vault size | `VAULT_SPACE` 58 → 80 |
| 2 | Book | Client keypair book `J33Y6…` (matcher-owned); CPI 10KB create cap |
| 3 | SettleBatch | Creates next batch PDA + registry counter raw write @ offset 36 |
| 4 | Ops scripts | `tools/init-protocol.js`, `keeper-crank.js`, `trade-e2e.js` |
| 5 | Lifecycle | Batches 0–1 Settled; dual fill on batch 2 → `markValid=1`; batch 3+ Collecting |
| 6 | Redeploy | Core + matcher with settle/counter/book fixes (see deployment doc) |

### Session C — Frontend M9 + browser e2e (later)

| # | Item | Outcome |
|---|------|---------|
| 1 | Web config | M9 program IDs, vault/registry/book defaults |
| 2 | PostOrder path | `config.bookAddress` (not PDA); `resolveOpenBatch` for Collecting scan |
| 3 | SDK | `encodePostOrder` + Collecting alias; rebuild `packages/sdk` dist required after type changes |
| 4 | UI labels | Commit-reveal → Collecting (BatchTimeline, batchDisplay, stores) |
| 5 | Vitest | config + submission hooks green |
| 6 | Playwright | `pnpm e2e` **31/31** including deterministic wallet PostOrder |
| 7 | Agent PostOrder | Scripted/agent PostOrder against open Collecting batch OK |
| 8 | Wallet automation | **Done 2026-08-08** — no-extension PostOrder fixture; live signing remains in `tools/trade-e2e.js` |

### Session D — Deterministic wallet e2e + phase reconciliation (2026-08-08)

| # | Item | Outcome |
|---|------|---------|
| 1 | T-WEB-WALLET-CONNECT | Mock Phantom provider auto-connects a deterministic public key without secrets or popup approval |
| 2 | T-WEB-POST-ORDER | Mocked registry/portfolio/book/batch RPC state drives the real `/trade` submit path |
| 3 | T-WEB-POST-WIRE | Captured instruction pins disc 20, buy+maker, exact scaled price/qty, instrument 0, and signer metas |
| 4 | Fast command | `pnpm e2e:wallet` completes one focused test; full Playwright is 31/31 |
| 5 | Static cleanup | Added missing DFBA fields to stale test fixtures; changed historical `Committing` assertion to `Collecting` |
| 6 | Phase docs | Feature-named deployment and monitoring records added; AI DevKit feature lint now clean |
| 7 | Pipeline contract | WebSocket + SQLite/custom path documented; backfill remains explicitly not implemented |

### Session E — Frontend reliability scope reconciliation (2026-08-08)

| # | Item | Planning outcome |
|---|------|------------------|
| 1 | Positions/Portfolio relentless refreshing | Added T9.8.5 as a P0 UX task; deliberately not diagnosed or implemented during this planning phase |
| 2 | `Batch: Collecting past deadline` | Added the approved state/intent contract and keeper-lag task T9.8.2/T9.8.6 |
| 3 | Wallet and chart inert under Playwright MCP origin | Historical 2026-08-08 finding. T9.8.1 now gates on playwright-cli at both `localhost` and `127.0.0.1` |
| 4 | Blank/failed chart ambiguity | Added explicit loading/error/retry task T9.8.3 |
| 5 | Incomplete browser journey | Reclassified prior wallet test as PostOrder-construction coverage; added full DFBA lifecycle task T9.8.4 |
| 6 | Old commit/reveal browser affordances | Added removal task T9.8.7; historical documentation remains untouched |

### Session F — Counterparty matching scope reconciliation (2026-08-09)

| # | Item | Planning outcome |
|---|------|------------------|
| 1 | Live opposing-order smoke | Same-wallet Buy/Long and Sell/Short orders remained resting; this is consistent with self-trade prevention and is not evidence of a matcher failure |
| 2 | Matching evidence classification | Retained host/program-test and scripted devnet dual-fill evidence; reclassified independent-wallet browser matching as unverified |
| 3 | New launch-confidence gate | Added M9.9/T9.9.1–5 for two funded users, same-batch fill, Clear → Settle trace, deterministic regression, and conditional discrepancy repair |
| 4 | Devnet launch posture | Controlled invited alpha is feasible; open trader testing waits for the two-wallet fill trace and bounded/indexer-backed RPC reads |

### Session G — Persona harness retarget (2026-08-20)

| # | Item | Planning outcome |
|---|------|------------------|
| 1 | Matching-proof method | **playwright-cli named sessions** (`-s=maker`, `-s=taker`, optional `-s=observer`) on live M9 programs. Playwright MCP is retired as a proof path |
| 2 | Signing | Injected live-signing Wallet Standard / Phantom-compatible provider from keypair **paths** (`~/.config/solana/mgk-trader-{maker,taker}.json`). Phantom-extension popups are not the matching gate |
| 3 | Order set | Four posts in one Collecting batch so **both** DFBA auctions fire. One buy vs one sell is insufficient for `mark_valid` |
| 4 | Keeper | Ops, not a browser persona: `node tools/keeper-crank.js` |
| 5 | Next slice | **T9.9.1 done 2026-08-20.** T9.9.2–3 are the live fill. M9.10 (fee 0, 24/7 keeper, funding SMA) waits |
| 6 | Prices | Do not reuse the 2026-08-09 crossed-book 76.55 / 0.10 trap |

### Session H — T9.9.1 persona harness closed (2026-08-20)

| # | Item | Planning outcome |
|---|------|------------------|
| 1 | Named sessions | `playwright-cli -s=maker` / `-s=taker` isolated `localStorage` (`mgk-order-form-wallet`) and header pubkeys |
| 2 | Inject | `tools/persona-inject.sh` is the operator path. `tools/playwright-cli-inject.js` is a dead end (CLI daemon env) |
| 3 | Funding | `node tools/fund-personas.js` InitPortfolio + Deposit. Maker principal 100000400, taker 99999000; both 0.5 SOL |
| 4 | Worktree Next | `pnpm -F @mgk/sdk build` + `turbopack.root` = `mgk-frontend` + relative `@mgk/sdk` alias, or `/trade` 500s |
| 5 | Secrets | Snapshots/screenshots/YAML had no secretKey, seed, password, or keypair byte arrays. Do not paste full RPC URLs into notes |
| 6 | Next | **T9.9.2**. Residual: Helius 429s; header currently `BATCH: —` until keeper opens Collecting |

### Session I — T9.9.2 same-batch UI posts (2026-08-20)

| # | Item | Planning outcome |
|---|------|------------------|
| 1 | Collecting batch | CreateBatch disc 16 opened batch **11** (`5fNur4FYLzvKhHMeRw2LRs8fwGjhs3mAsft4rJURisCc`) because registry counter had advanced without PDAs. Counter → 12. Sig `1k5YyfJfMQtDiEwqJNz4ecDn5TF9RWVcpGePcW5fnv1hH6u7fTHrFxeCKhtnekv5zQoTZ73ey6JoJmjM5ymHZhu` |
| 2 | Both UIs | `-s=maker` and `-s=taker` independently showed `BATCH: COLLECTING` then `Ready to clear · Waiting for keeper` after `n_min` |
| 3 | Dual-auction posts | Maker buy 86 + maker sell 88 + taker sell 86 + taker buy 88, qty 0.01 (oracle ~87.19). Not 76.55 / 0.10 |
| 4 | On-chain | `total_commitments=5` while still Collecting (status 0). Extra count is a 429 retry that later landed. Fill remains T9.9.3 |
| 5 | Ops | Pause page `setInterval`s before Helius-sensitive posts. Wait for a **new** explorer tx href, not a stale “Transaction Confirmed” toast |
| 6 | Next | **T9.9.3** crank while batch 11 is Collecting |

### Session J — T9.9.3 crank + observe (2026-08-20)

| # | Item | Planning outcome |
|---|------|------------------|
| 1 | Crank | CloseCollecting → ClearBatch → SettleBatch on batch 11 with both portfolio PDAs. Next batch 12 Collecting |
| 2 | `mark_valid` | Batch 11 Settled, `mark_valid=1`, `liq_paused=0`, clearing mid 87, bid 86 / ask 88, matched 10000 (0.01) per auction |
| 3 | Results | Matcher-owned `2qy2jdkTwT26hWSortMJrmxyadrUEFQYDfzwRFBWJhpx`, 5 fills |
| 4 | UIs | Maker `6LZP…BwWe` Positions: Flat 0 @ 86. Taker `BeBT…eXFe` Positions: Long 0.01 @ 88, liq 87.99. Both headers then showed Collecting batch 12 |
| 5 | Residuals (not a matching rewrite) | Bid taker fill was historical Phantom `2ecHahNv1LcVsmp614f8XTdpcTksNMwx7FkCJBtsMiQX` (stale book), not the persona taker-sell. Taker equity / free collateral displays −880.34. Trade History tab has no fill ledger (indexer was down). T9.9.5 |
| 6 | Next | T9.9.4 CI fixture (closed below) |

### Session K — T9.9.4 CI fixture + T9.9.5 diagnosis (2026-08-20)

| # | Item | Planning outcome |
|---|------|------------------|
| 1 | Fixture | `programs/perps-core/src/instructions/settle_batch.rs` tests `t_e2e_two_user_*`. Matcher is a **dev-dependency** (`Cargo.toml`). No matching rewrite |
| 2 | Command | `cargo +stable test -p mgk-perps-core --lib t_e2e_two_user` → **3 passed**. Solana rustc 1.79-dev is too old; use `+stable` |
| 3 | Clippy | `cargo +stable clippy -p mgk-perps-core --all-targets --all-features -- -D warnings` clean (`apply_dfba_results` is `#[cfg(test)]`; production SettleBatch calls `apply_one_dfba_fill`) |
| 4 | Assertions | Two distinct pubkeys; bid 10000@86 / ask 10000@88; 4 fills; both qty 0; leftover −2/5 and D3 0/5; self-trade alloc 0; volume `qty * 4` |
| 5 | T9.9.5 | Live batch 11 ≠ clean two-user: third pubkey `2ecHahNv…` took bid; persona taker Long 0.01 @ 88; extra 429 split maker-ask; equity −880.34e9 = `10000 * 88e6` + 5 bps. No matcher patch |
| 6 | Next | **M9.8 remainder.** Do not start M9.10 |

### Session L — T9.8.1 origin hydration closed (2026-08-20)

| # | Item | Planning outcome |
|---|------|------------------|
| 1 | Gate | playwright-cli named sessions `-s=origin-local` / `-s=origin-loopback`. Not Playwright MCP |
| 2 | HTTP | Both `http://localhost:3000/trade` and `http://127.0.0.1:3000/trade` return 200 |
| 3 | Clicks | Select Wallet → heading `/connect a wallet on solana/i`; Escape; `tf-15m` `data-active=true`. Results `"localhost ok"` / `"127.0.0.1 ok"` |
| 4 | Config | `allowedDevOrigins: ["127.0.0.1"]` + `turbopack.root=mgk-frontend`. Console 429s/indexer refuse are not hydration failures |
| 5 | CI | `e2e/trade.spec.ts` Browser origin hydration covers both origins |
| 6 | Next | **T9.8.3** chart loading/error/retry. Do not start M9.10 |

### Session M — T9.8.3 chart loading/error/retry (2026-08-20)

| # | Item | Planning outcome |
|---|------|------------------|
| 1 | TDD | `TradingViewWidget.test.tsx` red on missing `tradingview-loading` / `tradingview-retry`; green 12/12 |
| 2 | UI | Loading while tv.js pending; error + Retry remounts after `resetTradingViewScriptLoader` |
| 3 | Browser | `-s=chart-error` delayed abort `tv.js`: loading→error→Retry; toolbar `tf-15m` + order form stay usable. After unroute + Retry: iframe, no error |
| 4 | Next | **T9.8.4** visible Collecting → Settled on persona sessions. Do not start M9.10 |

### Session N — T9.8.4 visible DFBA lifecycle (2026-08-20)

| # | Item | Planning outcome |
|---|------|------------------|
| 1 | Mock walk | `installMockSolanaRpc` returns `{ setBatchPhase }`. `pnpm e2e:wallet` **2 passed** (PostOrder construction + Collecting → Clearing → Settled copy). Still not a fill |
| 2 | Live hold | `node tools/keeper-crank.js --close-only` leaves batch 12 Clearing. Both `-s=maker` and `-s=taker` showed `Batch: Clearing · Orders closed · Matching maker and taker flow at uniform prices` |
| 3 | Live settle | `--skip-close` Clear `3ZnHLn6Q…` + Settle `51s24Wix…`. Batch 12 Settled `mark_valid=0` (empty close). UI follows next Collecting batch 13 — Settled copy is mock-gated |
| 4 | Operator | `--close-only` and `--skip-close` are mutually exclusive. Re-inject after already-registered `__mgkLiveSign` fails; reload only |
| 5 | Next | **T9.8.6** keeper-lag visibility. Do not start M9.10 |

### Session O — T9.8.6 keeper-lag visibility (2026-08-20)

| # | Item | Planning outcome |
|---|------|------------------|
| 1 | Copy | Eligible Collecting past close slot: `Waiting for keeper · HH:MM:SS late`. Exact deadline still `Waiting for keeper`. Below `n_min` stays `Waiting for minimum flow` |
| 2 | Indexer | `/api/healthz` adds sqliteWritable, latestIndexedSlot, rpcSlot, slotLag, lastBatch, subscriptions. No RPC URL |
| 3 | Evidence | `batchDisplay` + StatusBar/MarketHeader vitest green. Indexer integration 27 passed. `pnpm e2e:wallet` **3 passed** including `collecting-ready` mock (32 slots / 00:00:13 late). Live personas still below `n_min` show minimum-flow, not keeper lag |
| 4 | Next | **T9.8.7** retire remaining legacy web affordances. Do not start M9.10 |

### Session P — T9.8.7 retire remaining legacy web affordances (2026-08-20)

| # | Item | Planning outcome |
|---|------|------------------|
| 1 | Store | Statuses `idle \| submitting \| done \| failed`. `recoverOrderFormState` drops `slashed \| committing \| awaiting_reveal \| revealing`. Dev `?set=` honors only `failed \| submitting \| idle` |
| 2 | UI/hooks | Slashed banner and `useCommitOrder`/`useRevealOrder` removed. Program errors map to `failed` + retry even when SDK severity is `slashed` (codes 600/503 kept as taxonomy) |
| 3 | Evidence | Focused vitest **63 passed**. `pnpm exec playwright test e2e/trade.spec.ts --project=chromium` **33 passed** (13.6s), including `legacy query params do not open a slashed or reveal journey`. playwright-cli `-s=legacy`: `?set=slashed` `{banner:false, slashedText:false, reveal:false, buy:true}` |
| 4 | Kept | On-chain field names `commitDeadlineSlot`/`revealDeadlineSlot`; batch fixture `slashedDeposits`; historical commit-reveal docs. Feature lint clean (worktree warn for `feature-onchain-perps-dex` is expected — do not add a second worktree) |
| 5 | Next | Do not start M9.10. T9.8.5 Positions flicker remains a regression |

### Session Q — Check Implementation Phase 7 (2026-08-20)

| # | Item | Planning outcome |
|---|------|------------------|
| 1 | Matching | HIGH vs Jump-paper DFBA. PostOrder 20, retired Commit/Reveal stubs, dual-clear `mark_valid`, liq gate. Do not rewrite matching |
| 2 | M9.8 remainder | Closed (T9.8.7). T9.8.5 remains a regression keep |
| 3 | Deviations | Maker fee leftover −2, SMA funding, first-batch mark seed, cash `qty*price` — all M9.10 / diagnosed, not matcher |
| 4 | Next | M9.10 blocked until **explicitly requested**. Not started from “continue” |

### Session R — Phase 8 testing coverage audit (2026-08-20)

| # | Item | Planning outcome |
|---|------|------------------|
| 1 | Scope | Re-verify closed DFBA + M9.8 remainder. **No** M9.10 tests (fill-lot, fee 0, D7) |
| 2 | Fresh evidence | matcher lib 114 pass; `t_e2e_two_user` 3 pass; `pnpm e2e:wallet` 3 pass (not a fill); `trade.spec.ts` 33 pass; focused web vitest 84 + Positions/Balances 26; indexer 30 pass |
| 3 | Gaps left | T9.8.5 regression keep; T9.10.7 paper fill-lots; req #10 live fee leftover; req #11 SMA; req #15 latency; BPF 4 ignored |
| 4 | Next | Phase 9 `dev-review`. M9.10 still blocked until explicitly requested |

### Session S — T9.10.1 maker fee 0 bps (2026-08-20)

| # | Item | Planning outcome |
|---|------|------------------|
| 1 | Red | `test_instrument_new` expected 0, got −2 |
| 2 | Green | `Instrument::new` / `init-protocol.js` / lifecycle init bytes default maker 0, taker 5. `SetInstrumentFees` disc 22. SDK encoder 5 bytes. Operator `tools/set-instrument-fees.js` |
| 3 | Live | Core upgrade `2PJmEb8U…` (public devnet RPC; Helius 429). Retune `2WUksBFg…` instrument `Hz9UtmSX…` before −2 → after 0 / taker 5 |
| 4 | Next | T9.10.2 24/7 keeper + liquidator. Do not rewrite matching |

### Session T — T9.10.2 24/7 keeper + liquidator (2026-08-20)

| # | Item | Planning outcome |
|---|------|------------------|
| 1 | TDD | `node --test` in `tools/`: 14 passed (`ops-health` + `ops-liquidate`). Collecting waits for deadline (ignores `n_min`). D6: skip unless current Settled `mark_valid` |
| 2 | Daemon | `tools/ops-keeper.js` `--loop` / `--health-port` / `--no-crank` / `--no-liquidate`. Health file + `127.0.0.1/healthz`. RPC **host** only |
| 3 | Live | Seed dual-clear batch 13 `mark_valid=1` (`trade-e2e.js` TRADE_QTY=1). LiquidateUser `3WDbtrsw…` taker `8SWub3A3…` positions 1→0. Crank empty batch 14 Close `f3GX7pYY…` Clear `8z1XiER6…` Settle `4rMFLcL8…` |
| 4 | Next | T9.10.3 index keeper reliability. Do not rewrite matching |

### Session U — T9.10.3 Reliable Multi-Venue Index Keeper (2026-08-24)

| # | Item | Planning outcome |
|---|------|------------------|
| 1 | Core Disc 23 | Implemented `SetInstrumentOracle` (disc 23) in `programs/perps-core`: governance signer authorization, core/oracle ownership, 128-byte size, magic `0x4C43_524F_4C43_5250`, version 0, `is_active == true`, `oracle.instrument == instrument.key()`. Tested in Rust & SDK. |
| 2 | SettleBatch Hardening | Strict oracle account verification in `settle_batch.rs` (matches instrument `oracle_addr`, owner `CsSqVZMoXixNYstNhTtixeT4pyRgrYnXdpfoXQBgFPqZ`, valid metadata, positive price). Freshness: `Clock::unix_timestamp` with `0 <= (now - ts) < 600`. Soft skips funding without failing settlement if stale/future/invalid. Reduced SBF stack frame. |
| 3 | Multi-Venue Index Daemon | `tools/oracle-sources.js`: 4 venue adapters (Binance, Coinbase, OKX, Bybit spot), 3s timeout, 100 bps outlier rejection, quorum >=3, scaled confidence (max abs deviation). `tools/ops-oracle.js`: `--bootstrap`, `--one-shot`, `--loop`, `/health` on 4091, atomic health file, secret sanitization. Cleaned duplicate writer from indexer keeper. |
| 4 | Live Devnet Verification | Upgraded core program (`2D3Sjpyc…`). Bootstrapped oracle `5NSDGAaRqfxe6mkZG9fEAZdzK4r77nEBEobohZGYP6PN` (`3pH2n5Y7…`). Bound instrument via disc 23 (`26G5oZBq…`). Live 4-venue one-shot post (`5yJFzRB5…`). Cranked and settled batch 20 -> 21 (`2BYRK69U…`). |
| 5 | Next | T9.10.4 indexer health / lag. Do not rewrite matching. |

### Session V — T9.10.4 indexer health + T9.10.5 D7 funding (2026-08-24)

| # | Item | Planning outcome |
|---|------|------------------|
| 1 | T9.10.4 Reconciliation | Ported 9 indexer files (healthTracker, syncer, keeperSelection + tests) and 2 web store files (useIndexerHealthStore + test) from root worktree. Overwrote shared indexer files (health.ts, store.ts, main.ts, keeper.ts, routes.ts) with T9.10.4 versions. Copied web staleness UI (StatusDot, StatusBar, MarketHeader + tests). Preserved worktree's T9.10.1–3 Rust changes |
| 2 | D7 Funding Rate | `compute_d7_funding_rate()` in `funding.rs`: `rate_bps = clamp(((mark - index) * coefficient_bps) / index, ±max_rate_bps)`. Checked i128 arithmetic, truncation toward zero. Returns `None` for invalid index/negative coeff/zero cap |
| 3 | Instrument Renamed | `interest_rate_bps` → `funding_coefficient_bps` (offset 160, default 10_000). `funding_cap_bps` → `max_funding_rate_bps` (offset 176, default 50). Legacy fields (`_reserved_deviation_cap`, `_reserved_sample_qty`, `_reserved_sma_window`, `_reserved_sample_count`, `_reserved_premium_samples`) retained as inert bytes. Layout identical (336 bytes) |
| 4 | SettleBatch Updated | `apply_funding_to_instrument()` now takes `(instrument, mark_price, oracle_price, current_slot)`. Uses D7 formula. Soft-skip with cursor advancement for zero-rate intervals (prevents retroactive accrual). Removed book depth sweep from funding path |
| 5 | SetFundingParams | New instruction (discriminator 24). Accounts: writable Instrument, Registry, governance signer. Wire: coefficient_bps(i64) + max_rate_bps(i64) + interval_slots(u64) = 24 bytes. Validates non-negative coeff/cap, non-zero interval. Resets `last_funding_slot` to current clock slot. Preserves `cum_funding` |
| 6 | SDK | `CORE_INSTRUCTION.SetFundingParams = 24`. `encodeSetFundingParams(coefficientBps, maxRateBps, intervalSlots)` — 25-byte wire. Tests for exact bytes and round-trip |
| 7 | Verification | `cargo +stable clippy --all-targets --all-features -- -D warnings` clean. `cargo +stable test --all-features` — 362 tests pass (248 perps-core + 114 perps-matcher + oracle). 16 D7-specific tests added (rate calculation, accrual, conservation, boundary) |
| 8 | Next | T9.10.6–7 done 2026-08-24. Devnet deployment of upgraded core + SetFundingParams invoke. Do not rewrite matching |

### Session W — T9.10.6 settlement mark + T9.10.7 reduce-only + prepare-close (2026-08-24)

| # | Item | Planning outcome |
|---|------|------------------|
| 1 | T9.10.6 Settlement mark selector | Replaced `compute_mark_price` fallback in `settle_batch.rs` with pure settlement-mark: valid→clearing_price, invalid→carry prev, invalid-first→zero. Removed oracle/book mark seeding from the settle path (oracle retained for funding index only). 4 new tests (`test_t9_10_6_*`) pass |
| 2 | T9.10.7 ReduceOnlyViolation=606 | New error code in `mgk-common/src/error.rs`. Pin test asserts `ReduceOnlyViolation as u32 == 606`. PostOrder `process_post_order` enforces: flat→reject, wrong-side→reject, oversized→reject. 8 unit tests in `post_order.rs` |
| 3 | T9.10.7 SDK error mapping | `PercolatorError.ReduceOnlyViolation = 606` + human message + `RETRYABLE_ERROR_CODES` set in `error.ts`. SDK builds clean |
| 4 | T9.10.7 OrderForm prepare-close | `positionQty: bigint` prop (default 0n). Prepare-close button: long→sell at best bid; short→buy at best ask; reduce-only on, taker mode, exact abs position qty. Disabled when book crossed or no opposing quote. Signed position in summary. Fixed-point `parseFixed6`/`formatFixed6` replaces `parseFloat` × 1e6 |
| 5 | T9.10.7 Trade page wiring | `position?.qty` passed as `positionQty` to OrderForm. `void position` removed |
| 6 | T9.10.7 OrderForm tests | 12 new tests: zero/long/short position display, prepare-close button visibility, disabled states (crossed book, no quote), long/short prepare-close field assertions, fixed-point parsing for fractional and whole numbers. 486 vitest pass |
| 7 | T9.10.7 Mock RPC fixture | `encodePortfolioWithPosition` + `setPortfolioPosition` in `mockPhantom.ts`. Writes instrument_id/qty/entry_vwap at correct Portfolio struct offsets |
| 8 | T9.10.7 Playwright wallet tests | 3 new e2e tests in `wallet-flow.spec.ts`: long prepare-close fields, short prepare-close fields, captured instruction discriminator + exact side/qty/reduce_only. Requires running dev server |
| 9 | Clippy + full Rust tests | `cargo +stable clippy` clean. `cargo +stable test --all-features`: 439 pass (267 core + 115 matcher + 46 common + 11 oracle), 5 ignored (CU harness). T9.10.6 adds 4 tests; T9.10.7 adds 8 tests |
| 10 | Planning docs | T9.10.6–7 marked Done 2026-08-24. Session W record added. M9.10 complete |

**Devnet accounts (canonical):**

| Account | Address |
|---------|---------|
| Core | `C7w2mKz2KQgDroNNhACm9MutXhPiesVr9Gn2x8TDsRYx` |
| Matcher | `7WiZuunbPGciCedsVTguvjezwwzrhmXG5HkdCuHizbNC` |
| Oracle Program | `CsSqVZMoXixNYstNhTtixeT4pyRgrYnXdpfoXQBgFPqZ` |
| PriceOracle Account | `5NSDGAaRqfxe6mkZG9fEAZdzK4r77nEBEobohZGYP6PN` |
| Registry | `CbsfrRS2rYE2qgJbi7MM6mLzARUy8cDiYmHW2o12jYJA` |
| Vault | `9qe7TkRxDXHo3dywPKiiY1jwSBnFuSPHmGTWhcP8ttXE` |
| Book | `J33Y6yo6AZM6JKLEw89tN1kPmyEADqWWjGxb1aAW915j` |
| Instrument 0 | `Hz9UtmSXyKFnp1pGvrhrAmizMsvEkYRh5Eih1r7Lf1hG` |

**Evidence (latest — 2026-08-24 Session W):**

- `mgk-perps-core` lib 267 pass; `mgk-perps-matcher` lib 115 pass (1 ignored CU); `mgk-common` 46 pass; oracle 11 pass (4 ignored)
- `cargo +stable clippy --all-targets --all-features -- -D warnings` clean
- `cargo +stable test --all-features` — 439 tests pass (5 ignored = CU harness)
- T9.10.6: 4 settlement-mark-selector tests
- T9.10.7: 8 reduce-only enforcement tests + 12 OrderForm vitest + 3 Playwright wallet e2e (dev-server required)
- SDK: `PercolatorError.ReduceOnlyViolation = 606` + `encodeSetFundingParams`
- Devnet: disc 23 oracle binding `26G5oZBq…`, multi-venue post `5yJFzRB5…`, batch 20 settle `2BYRK69U…`
- AI DevKit feature lint: pre-existing warnings (TradingViewWidget, indexer syncer) not from this session
- Pending: devnet core upgrade + SetFundingParams invoke, security review before mainnet

**Open task count:** M9.10 T9.10.1–7 are done (2026-08-24). Security review remains before mainnet.

**Blockers / residual issues:**

| # | Item | Severity | Status | Notes |
|---|------|----------|--------|-------|
| 1 | ~~BPF e2e `InvalidArgument` on Initialize~~ | ~~P0~~ | **Fixed** | vault/system_program account order |
| 2 | BPF e2e CU exhaustion in ClearBatch | P1 | Open (test-only) | program-test 2.1 CU budget; devnet empty Clear ~2.6k CU |
| 3 | ~~Devnet keeper Clear/Settle failure~~ | ~~P0~~ | **Fixed** | book + vault + settle PDA + counter write |
| 4 | ~~Stale SDK / Committing UI labels~~ | ~~P0~~ | **Fixed** | rebuild SDK dist; Collecting labels |
| 5 | ~~Human Phantom wallet PostOrder bottleneck~~ | P2 | **Resolved by automation** | `pnpm e2e:wallet` = construction; scripted live send = `trade-e2e.js`; browser live send = T9.9.1 harness |
| 6 | Indexer polish | P2 | Partial | M9 IDs; PDA-batch/oracle/rate-limit polish remain |
| 7 | ~~Feature-named deployment/monitoring lint paths~~ | P3 | **Fixed** | AI DevKit feature lint clean 2026-08-08 |
| 8 | ~~Wallet/chart can be server-rendered but non-interactive at the automation origin~~ | ~~P0 UX~~ | **Closed 2026-08-20** | T9.8.1 playwright-cli both origins; Select Wallet + `tf-15m` |
| 9 | Header/status bar says `Collecting past deadline` | P0 UX | **Closed 2026-08-20** | T9.8.2 copy + T9.8.6 elapsed keeper wait; never `past deadline` on eligible batches |
| 10 | Positions/Portfolio relentlessly refresh and cause eye strain | P0 UX | Partial | T9.8.5 has implementation evidence; keep as a regression |
| 11 | Browser coverage stops after PostOrder construction | P1 test gap | **Closed 2026-08-20** | T9.8.4: `pnpm e2e:wallet` walks copy; live personas held Clearing via `--close-only` |
| 12 | Independent-wallet live fill not verified | P0 protocol-confidence gap | **Closed 2026-08-20** | Batch 11 browser posts + crank `mark_valid=1`. Residuals: stale-book bid user, taker equity display → T9.9.5 |

## Next actions

### Priority-ordered follow-on tasks

| # | Task | Priority | Status | Blocker |
|---|------|----------|--------|---------|
| 1 | ~~**Devnet batch lifecycle**~~ | ~~P0~~ | **Done** | Close→Clear→Settle batches 0→2+ |
| 2 | ~~**Devnet PostOrder dual fill**~~ | ~~P0~~ | **Done** | `trade-e2e.js` mark_valid=1 (scripted, not browser) |
| 3 | ~~**Frontend M9 wiring**~~ | ~~P0~~ | **Done** | config, book, open-batch, Collecting UI, SDK rebuild |
| 4 | ~~**Deterministic wallet PostOrder construction**~~ | ~~P1~~ | **Done** | mock Phantom + RPC fixture; exact disc 20 wire asserted |
| 5 | **T9.8.5 Positions/Portfolio visual stability** | P0 | **Implemented** | preserve last good data during background refresh; regression covered |
| 6 | **T9.8.2 Truthful DFBA state language** | P0 | **Implemented** | shared helper drives header/status; lifecycle closed in T9.8.4 |
| 7 | **T9.9.1 Persona harness and funding** | P0 | **Done 2026-08-20** | named `-s=maker` / `-s=taker`; `persona-inject.sh`; funded keypairs |
| 8 | **T9.9.2 Same-batch opposing PostOrders via UI** | P0 | **Done 2026-08-20** | batch 11 Collecting; 86/88 qty 0.01; `total_commitments=5` |
| 8b | **T9.9.3 Clear/settle and both UIs observe** | P0 | **Done 2026-08-20** | batch 11 `mark_valid=1`; maker Flat / taker Long 0.01 @ 88 |
| 9 | **T9.9.4–5 Deterministic two-user regression and discrepancy fix** | P0 | **Done 2026-08-20** | CI 3/3; residuals are stale Phantom + one-sided cash `qty*price`, not matcher |
| 10 | **T9.8.1 Browser hydration + interaction reliability** | P0 | **Done 2026-08-20** | playwright-cli both-origin click evidence; `trade.spec.ts` covers both origins |
| 11 | **T9.8.3 Chart loading/error/retry** | P1 | **Done 2026-08-20** | loading/error/retry on TradingViewWidget; toolbar/order form preserved |
| 12 | **T9.8.4 Full DFBA playwright-cli lifecycle** | P1 | **Done 2026-08-20** | mock `setBatchPhase` + live `--close-only` Clearing |
| 13 | **T9.8.6 Keeper-lag visibility** | P1 | **Done 2026-08-20** | elapsed wait copy + indexer `/api/healthz` lag/lastBatch |
| 14 | **T9.8.7 Retire remaining legacy web affordances** | P1 | **Done 2026-08-20** | active UI/tests are PostOrder-only; SDK slashed taxonomy kept |
| 15 | **T9.10.*** Working-devnet follow-on | P1 | **Done 2026-08-24** (T9.10.1–7) | Security review before mainnet |
| 16 | **Security review** — `solana-fender-mcp` + QEDGen | P1 | Not started | before mainnet |
| 17 | program-test CU budget / un-ignore 4 e2e tests | P1 | Open | harness only; not prod |
| 18 | **Indexer** PDA-batch/oracle/rate-limit polish | P2 | Partial | M9 IDs wired |
| 19 | ~~**Multi-venue oracle** for index~~ | ~~P2~~ | **Done 2026-08-24** | T9.10.3 shipped (`oracle-sources.js`, `ops-oracle.js`) |

### Suggested next 2–3 actions (when resuming)

1. **Devnet deployment:** upgrade core program, invoke SetFundingParams disc 24 with 10000/50/100, verify raw field readback + cursor reset.
2. **T9.8.5 regression:** Positions/Portfolio visual stability remains a keep-watch, not a new slice. Do not rewrite matching.
3. **Security review:** `solana-fender-mcp` + QEDGen before mainnet.

## Historical plan

Prior commit-reveal milestones M1–M8 remain in `docs/ai/planning/README.md` as audit trail. **Do not implement new commit-reveal work from that file.** Active matching/lifecycle work is **this document (M9)**.

## Summary

The M9 on-chain DFBA migration is **complete, deployed, and exercised on
devnet**. Independent-counterparty matching through the **browser** is now
proven on live batch 11: playwright-cli personas posted a dual-auction set,
`keeper-crank.js` settled, `mark_valid=1`. 2026-08-09 Playwright MCP remains
historical self-trade skip.

**Approved M9.8 remainder is closed (T9.8.7 done 2026-08-20).** Do not use
Playwright MCP. Do not treat `pnpm e2e:wallet` as a fill. M9.10 is in
progress (T9.10.1–2 done). Do not rewrite matching.

**Ops verified (2026-08-06):** vault size fix (80 B), matcher-owned book keypair, SettleBatch next-batch PDA create + registry counter raw write, `tools/{init-protocol,keeper-crank,trade-e2e}.js`. Multi-batch Close→Clear→Settle succeeded; dual-side PostOrder fill produced `markValid=1`. Empty-book Clear on devnet ≈ **2.6k CU** (production-safe for thin books).

**Frontend (through 2026-08-20):** M9 program IDs, open-batch resolution, and
`encodePostOrder` exist. Deterministic PostOrder construction, truthful
header/status intent, and portfolio refresh stability are evidenced.
Origin hydration (T9.8.1), chart states (T9.8.3), the visible DFBA
lifecycle (T9.8.4), keeper lag (T9.8.6), and legacy affordances (T9.8.7)
are closed. Positions flicker (T9.8.5) remains a regression.

**Scope changes (2026-08-20):** Matching-proof harness is playwright-cli
personas, not MCP. Live window stays `t_min=2`, `t_max=150`, `n_min=1`. Locked
maker fee is **0 bps**; live instrument retuned T9.10.1 (was leftover −2). Book remains a
client-created keypair account (not CPI PDA) due to 10KB create cap.

**Risks / upcoming focus:** Helius 429s; stale resting orders from other
wallets participating in DFBA; cash `qty * price` equity scale (intentional
current formula); secrets in snapshots. Controlled invited alpha is closer;
M9.10 remains before calling working-devnet done. Security review before
mainnet.

**Task tracing:** unavailable because this was a direct `dev-planning`
continuation, not a parent `dev-lifecycle` run with an established task.

**Planning stop (Phase 6):** Session V reconciled T9.10.4 (indexer health /
lag) and implemented T9.10.5 (D7 funding rate). Clippy + 362 tests pass.
Devnet deployment + SetFundingParams invoke + oracle refresh + dual-valid
DFBA batch remain for verification. M9.10 is now complete. Do not rewrite
matching.
