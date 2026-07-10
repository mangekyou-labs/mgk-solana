---
phase: grant-proposal
title: mgk Perps DEX — Grant Application ($50,000)
description: Fully on-chain perps DEX on Solana — commit-reveal CLOB, ~2-4s latency, MEV-mitigated, no sequencer. Live on devnet: 3 programs executable, resting orders placed via frontend, ClearBatch + SettleBatch verified on-chain.
---

# mgk Perps DEX — Grant Application

**$50,000 USDG | Solana DeFi Infrastructure**
**Applicant:** mgk Protocol
**Apply:** https://superteam.fun/earn/grants/agentic-engineering

| | |
|---|---|
| **Repository** | https://github.com/aeyakovenko/percolator |
| **Architecture doc** | [`docs/ARCHITECTURE.md`](../../ARCHITECTURE.md) — commit-reveal CLOB design, batch lifecycle, safety stack, worked examples |
| **Devnet (core)** | `3jYQ4mpWBBtwrzYQ4zzKhgqVcWWsG2HpXi9oXTBpekja` — [explorer](https://explorer.solana.com/address/3jYQ4mpWBBtwrzYQ4zzKhgqVcWWsG2HpXi9oXTBpekja?cluster=devnet) ✅ Executable |
| **Devnet (matcher)** | `AU4EKQAQupEbMWPK9fuJA7CZqfcjM5Bpgf6Ew9Y7o2FF` — [explorer](https://explorer.solana.com/address/AU4EKQAQupEbMWPK9fuJA7CZqfcjM5Bpgf6Ew9Y7o2FF?cluster=devnet) ✅ Executable |
| **Devnet (oracle)** | `6M9eEiDKy8imbDi44ZqquyfknNbveRjD4j9VnvYaHtmA` — [explorer](https://explorer.solana.com/address/6M9eEiDKy8imbDi44ZqquyfknNbveRjD4j9VnvYaHtmA?cluster=devnet) ✅ Executable |
| **Live tx (ClearBatch)** | [2KuYdsDx…kXsXQBv](https://explorer.solana.com/tx/2KuYdsDxjnq8VAUcRsMYGUs6PcqszWZ4BYZmXV3XqSWk548LJvMLJWiVsd5NYqY6qsCh52n6A64WJQLw9kXsXQBv?cluster=devnet) — slot 473186843, `err: None` |
| **Live tx (SettleBatch)** | [5kSxSdUF…p2snPkavn](https://explorer.solana.com/tx/5kSxSdUFtMwAXjBTp2fxPMBS96qWFDTWKut64C5MPh6xMkwreSKhYvAVjug9SM4NrM13XLyCJr6SY5mp2snPkavn?cluster=devnet) — slot 473187751, `err: None` |
| **Tests** | 954 total — 322 Rust (`cargo test --all-features`) + 632 frontend (426 Vitest web + 151 SDK + 28 indexer + 27 Playwright E2E) |
| **Demo video** | _[TODO: 60–90s Loom walkthrough: deposit → commit → reveal → ClearBatch → SettleBatch → position]_ |

---

## Architecture

mgk is a fully on-chain perpetual futures DEX on Solana. Every order, fill, and settlement is verifiable on-chain.

**What it is.**

- **Commit-reveal batch CLOB** — ~2–4s batch latency (T_min=2 slots, T_reveal=3 slots, T_max=15 slots). No sequencer.
- **Persistent GTC order book** — resting orders survive across batches; makers earn rebates; capital accumulates.
- **Cross-margin portfolio** — single SOL-collateralized account per wallet.
- **3-layer safety stack** — liquidation optimizer → insurance fund → auto-deleveraging (ADL); plus an independent 4-flag emergency pause (trading, withdrawals, liquidations, funding).
- **Rust + Pinocchio BPF** — `no_std`, zero-allocation, single-byte discriminators, checked arithmetic throughout.

**Why this design.**

Solana has fast blocks (~400 ms), parallel execution, and sub-cent tx costs — yet no live perps DEX combines MEV-mitigated on-chain CLOB matching with a sequencer-free architecture on a rigorous risk foundation. Existing models force a trade-off: fast but trust a sequencer (Drift, Mango, Zeta), or permissionless but AMM-capped with no resting depth (Jupiter Perps, Perpetual Protocol). mgk takes a third path.

MEV mitigation is structural, not trust-based:

- **Commit-reveal** hides order contents from the mempool until after the batch closes.
- **Fisher-Yates shuffle** eliminates time-advantage within a batch.
- **Structural priority queues** guarantee price-time fairness across revealed orders.

**What it is not.**

- No RFQ layer — the order book is the execution model.
- No AMM curve — price discovery is two-sided flow on a real book.
- No off-chain sequencer — every fill and settlement is on-chain.
- No multi-venue NBBO oracle — the book is price discovery; a fallback oracle (admin-pushed + Pyth) guards liquidations when the book is thin.

The design is one coherent direction, not a hybrid that hedges.

---

## Market opportunity

Perpetual futures are the largest category in DeFi by volume. Decentralized perps platforms process **~$27.4B/day in volume**, hold **~$17.1B in open interest**, and clear **>$1.3T/month** ([DefiLlama](https://defillama.com/perps)). Solana is suited to on-chain perps — fast finality, parallel execution, sub-cent costs — yet its perps landscape is dominated by hybrid off-chain-matching + sequencer models. **No live, fully on-chain CLOB perps DEX with persistent GTC depth exists on Solana.** Anchoring to a 1% capture of decentralized perps daily volume (~$274M/day) at a 5 bps taker fee yields ~$1.37M/day in protocol fees, ~$500M annualized.

mgk is pre-TVL, pre-beta-user. The proof of work is engineering depth + devnet liveness, not adoption metrics. The grant's Phase 2 and Phase 4 tranches convert that proof-of-work into real beta-user traction before any mainnet deployment.

---

## Proof of work — live on devnet

**Three programs deployed and executable.** Verified via `getAccountInfo`:

| Program | Devnet ID | Status |
|---|---|---|
| perps-core | `3jYQ4mpWBBtwrzYQ4zzKhgqVcWWsG2HpXi9oXTBpekja` | ✅ Executable |
| perps-matcher | `AU4EKQAQupEbMWPK9fuJA7CZqfcjM5Bpgf6Ew9Y7o2FF` | ✅ Executable |
| oracle | `6M9eEiDKy8imbDi44ZqquyfknNbveRjD4j9VnvYaHtmA` | ✅ Executable |

**Real on-chain trade lifecycle exercised.** `ClearBatch` (slot 473186843) and `SettleBatch` (slot 473187751) confirmed on devnet with `err: None`, from a real wallet. Logs show `Program 3jYQ4mpW… Instruction: ClearBatch` / `SettleBatch`.

**Resting orders live on book.** A GTC resting order (buy @ 150000, qty 100, instrument 0) is live on the on-chain book, placed through the mgk frontend. The book persists across batches — the core architectural promise of a persistent GTC CLOB, demonstrated on devnet. Active state: batch #3, registry `F7zWN2XrVqNDBBYqsYpgxHa6AuPK1aQE33kHwM4f8ayV`, vault `3FZS8JUn8FGz1CUroGYwrBVHqotaUquJMNnSuBCQxheT`, book `5nfbjqTYpsnHnmCifdFpwLwajhyb8n6orVvbMbSrGT6w`.

**Frontend live.** Next.js 15 trade page with TradingView chart, order book, order form, wallet connect. Deposits, withdrawals, and order placement flow through the frontend to the on-chain programs. SDK package ships instruction encoders, PDA derivation, and state decoders.

**On-chain instruction set (20 core + 5 matcher + 5 oracle).**

- **Core:** Initialize, InitPortfolio, Deposit, Withdraw, CommitOrder, RevealOrder, CloseCommitting, ClearBatch, SettleBatch, LiquidateUser, AddInstrument, CancelRestingOrder, ModifyRestingOrder, CancelAllRestingOrders, SetPauseFlags (disc 0–14), plus 5 bootstrap instructions for Solana 4.x PDA/account creation (disc 15–19).
- **Matcher:** ComputeClearing, CancelResting, ModifyResting, ClearAndMatch, CancelAll — the monolithic match instruction decomposed into 5 modular instructions for BPF stack safety.
- **Oracle:** Initialize, UpdatePrice, SetAuthority, Activate, Deactivate — admin-pushed fallback feed.

**Safety stack — shipped.** Liquidation optimizer (hedge-preserving, impact-ratio ranked, up to 10 iterations) → insurance fund → ADL → 4-flag emergency pause (gates verified in commit/reveal/withdraw/liquidate/settle paths).

**Tests.** 322 Rust across 4 crates; 632 frontend (426 web + 151 SDK + 28 indexer + 27 E2E). `cargo clippy --all-targets --all-features -- -D warnings` clean. `cargo build-sbf` clean, zero stack-overflow errors. Matcher BSS scratch buffers in `.data.S` link section for BPF 4096-byte stack safety.

**Design depth.** 1,165-line design doc (`docs/ai/design/feature-onchain-perps-dex.md`); file-by-file implementation report flagging every deviation and open item; public architecture doc ([`docs/ARCHITECTURE.md`](../../ARCHITECTURE.md)) with worked numeric examples.

---

## Success criteria

The grant funds five phases of devnet-validation work (Phases 1–5 = $50K); Phase 6 (mainnet readiness prep) is described but unfunded, gated on a post-grant independent security review whose cost exceeds the grant scope. v1 success criteria are devnet-only.

| # | Criterion | Phase | Measurement |
|---|---|---|---|
| 1 | Rust tests pass | 1, 2, 5 | `cargo test --all-features` exits 0 (≥322 tests) |
| 2 | Clippy clean | 1, 2, 5 | `cargo clippy --all-targets --all-features -- -D warnings` exits 0 |
| 3 | SBF builds, no stack overflow | 1, 2, 5 | `cargo build-sbf` exits 0; matcher BSS scratch buffers verified |
| 4 | Three devnet-deployed programs | 1 | All 3 program IDs executable on devnet |
| 5 | E2E batch lifecycle on devnet | 1 | ClearBatch + SettleBatch txs with `err: None` from external wallet |
| 6 | Liquidation path tested on devnet | 1 | Forced underwater portfolio → optimizer → insurance/ADL exercised on-chain |
| 7 | PauseFlags gates live on devnet | 1 | Each of the 4 flags toggled and verified in commit/reveal/withdraw/liquidate/settle |
| 8 | Toxic-taker detection observable | 5 | Synthetic toxic taker faces wider spreads vs benign taker |
| 9 | Insurance-fund inventory visible | 5 | Inventory rebalance observable post-liquidation; indexer `/insurance` endpoint |
| 10 | Short-batch latency on devnet | 3 | ≥10 batches measured; p50 < 4s, p99 < 8s end-to-end |
| 11 | Pre-signed reveal relayer operational | 3 | ≥50 orders across ≥10 batches; zero user slashes from reveal-window timeout |

---

## Funded scope ($50K)

The on-chain CLOB, safety stack, and batch lifecycle are shipped and live on devnet. The funded scope is product-focused: get the perps dex working end-to-end, put it in front of real beta users, improve latency, do another beta round, then layer on the defensive enhancements.

### Phase 1 — Working Perps DEX on Devnet ($12,000) — MVP

Turn the shipped programs into a demonstrably working perps dex on devnet — the full trader flow, end-to-end. **Estimated completion: T+4 weeks.**

Most of the underlying on-chain + frontend work is already shipped (3 devnet programs, 954 tests, ClearBatch + SettleBatch verified). This tranche funds the integration gaps, the continuous batch-crank keeper, and liquidation-path exercising.

- [ ] Deposit SOL into portfolio via frontend
- [ ] Place commit-reveal orders (limit GTC, market, IOC, ALO) via frontend
- [ ] Resting orders persist on book across batches, visible in order book UI
- [ ] Cancel / modify resting orders via frontend
- [ ] Batch lifecycle runs continuously via keeper (close → clear → settle)
- [ ] Positions update after settlement, visible in portfolio UI
- [ ] Funding accrual visible after settlement
- [ ] Withdraw SOL from portfolio via frontend
- [ ] Mark price computed from book mid + fallback oracle
- [ ] Liquidation path exercisable (forced underwater portfolio → optimizer → insurance/ADL)

**Keeper — Batch Crank (~150 LOC, built here):** Node.js/TypeScript bot on a $5–20/mo VPS, watches `Batch.status == Committing`, calls `CloseCommitting` → `ClearBatch` → `SettleBatch` as soon as cadence criteria are met. Retry queue, RPC failover, slack webhook on missed crank slot. Open-source, single-Docker deploy.

**Deliverable:** A trader can deposit, place orders, see them rest/fill/settle, see position and PnL, and withdraw — all on devnet via the frontend.
**Measurement:** On-chain txs from an external wallet demonstrating (a) deposit, (b) commit/reveal, (c) ClearBatch, (d) SettleBatch, (e) position update visible in indexer, (f) withdraw; resting orders visible on the book PDA; liquidation path exercised at least once with `err: None`; pause-flag gates verified by toggling each of the 4 flags and asserting the expected reverts; batch crank keeper 24/7 operational, cranking ≥10 batches with crank slot lag ≤ 1 slot average, bot uptime ≥95% across the 7-day window.

### Phase 2 — Testing + Beta Users on Devnet ($10,000) — Hardening

Hardening and real-user feedback before any latency work. **Estimated completion: T+8 weeks.**

322 Rust + 632 frontend tests are already green; this tranche funds integration test gaps, liquidation-end-to-end depth, and beta-user recruitment incentives.

- [ ] Comprehensive integration tests: full trade lifecycle (commit → reveal → clear → settle → position → withdraw)
- [ ] Integration tests: liquidation path (underwater portfolio → optimizer → insurance/ADL)
- [ ] Integration tests: pause flags (each of the 4 flags toggled and verified)
- [ ] Onboard 5–10 beta testers from the Solana dev community
- [ ] Beta testers complete at least one full trade cycle each (deposit → order → fill → settle → withdraw)
- [ ] Collect UX feedback, fix blocking bugs
- [ ] Test suite green: `cargo test --all-features` + `cargo clippy --all-targets --all-features -- -D warnings` + `cargo build-sbf` + frontend suites

**Keeper — Liquidator (~300 LOC, built here):** Watches portfolio health via indexer WebSocket, computes effective leverage vs maintenance margin, invokes `LiquidateUser` when equity breaches `M_p`. Indexer-backed monitoring with on-chain state re-verification before each call (no stale-DB liquidations), priority-fee retry queue. Runs on the same VPS as the crank.

**Deliverable:** Test suite comprehensive and green; 5–10 external beta testers have completed trade cycles on devnet; blocking UX bugs fixed.
**Measurement:** Integration tests green with ≥90% coverage on trade lifecycle, liquidation path, and pause-flag paths; ≥5 distinct external wallets each complete one full deposit → order → fill → settle → withdraw cycle on devnet; full test suite green per criteria #1–#3; liquidator bot 24/7 operational, executes ≥10 synthesized liquidations with `err: None`, detects underwater portfolios within 1 slot average, zero stale-DB liquidations, positive returns after gas.

### Phase 3 — Short-Batch Latency ($10,000) — Latency

Shrink batch windows from 30–60s to ~2–4s for viable trader latency. Keep the commit-reveal MEV mitigation. **No on-chain program changes required** — batch params are governance-configurable. **Estimated completion: T+12 weeks.**

- [ ] Set governance params on devnet: T_min=2 slots, T_reveal=3 slots, T_max=15 slots
- [ ] Frontend dual-sign flow: wallet signs `CommitOrder` + `RevealOrder` in one action, hands pre-signed reveal to relayer
- [ ] Pre-signed reveal relayer bot (~100 LOC): watches for commit confirmation, submits pre-signed reveal within 1 slot
- [ ] Relayer fee model: small relay fee deducted from commitment deposit return
- [ ] Load test: 50+ orders across 10+ batches, measure p50 < 4s, p99 < 8s end-to-end
- [ ] Zero user slashes from reveal-window timeout across all test orders

**Keeper — Pre-signed Reveal Relayer (~100 LOC, built here):** Watches for `CommitOrder` confirmation, immediately submits the pre-signed `RevealOrder` the user signed earlier; submits within 1 slot of commit confirmation. Priority-fee escalation, failover to backup RPC, slack alert on missed reveal. Runs on the existing Phase 1 VPS. The relayer never has custody — it submits a user-signed tx. Multiple competing relayers keep each other honest.

**Deliverable:** Live devnet trading with <8s p99 batch latency, zero slashes.
**Measurement:** ≥10 batches with ≥50 total orders measured end-to-end; p50 < 4s and p99 < 8s reported (CSV of per-order latencies attached); zero user slashes (verified via `Commitment.status == Slashed` count == 0); relayer bot 24/7 operational with ≥95% of reveals submitted within 1 slot of commit confirmation; open-source, single-Docker deploy.

### Phase 4 — Short-Batch Beta Rollout ($6,000) — Beta

Get users back on the faster version. Measure whether the latency improvement changes adoption behavior. **Estimated completion: T+16 weeks.**

- [ ] Invite beta testers from Phase 2 back to try the short-batch version
- [ ] Onboard new beta testers (target 10–20 total)
- [ ] Each tester completes at least 5 trade cycles on the short-batch version
- [ ] Collect latency perception feedback (is ~2–4s acceptable for active trading?)
- [ ] Measure p50/p99 latency from real user sessions
- [ ] Iterate on UX based on feedback (relayer reliability, signing flow, order status clarity)
- [ ] Zero user slashes across all beta testing

**Deliverable:** 10–20 beta testers have used the short-batch version; latency feedback collected; UX iterated.
**Measurement:** 10–20 distinct external wallets each complete ≥5 trade cycles on the short-batch version (verifiable via SettleBatch sender list); p50/p99 latency reported per user session; ≥80% of beta testers return "acceptable for active trading" in a structured post-test survey; zero user slashes.

This is the **core product-risk gate**: ~2–4s batch latency is the named assumption. If beta testers find it unacceptable for active trading, we learn that before mainnet, not after. Failure here triggers a re-evaluation of the latency target before Phase 5 proceeds.

### Phase 5 — Defensive Enhancements + Kani Proofs ($12,000) — Hardening

Two PropAMM-inspired defensive features plus formal verification, layered on top of the working, beta-validated dex. **Estimated completion: T+20 weeks.**

This tranche funds net-new on-chain engineering: 1 new PDA type (`FlowQualityScore`), toxic-taker scoring wiring, 2 new `Vault` fields, and 6 new Kani system-invariant proofs.

#### Toxic-Taker Detection

Score takers by historical PnL-to-protocol over a rolling window. Known-toxic flow faces widened spreads or withheld depth — economic friction, never a hard reject.

- [ ] New `FlowQualityScore` PDA — seed `["flow_quality", address, instrument_id]` — one per address per instrument
- [ ] Scoring logic in `state/risk_callback.rs`: `score = sum(PnL_to_protocol_over_N_batches) / N` where PnL-to-protocol = maker_rebates − taker_fees − funding_payments for all fills by this address over the N most-recent batches
- [ ] Score > 0: benign taker (net payer to protocol). Score ≤ 0: toxic taker (net drainer)
- [ ] Toxic-taker behavior in matcher: effective spread multiplied by `max(1.0, 1.0 + |score|/threshold)` capped at a max multiplier; alternatively, top-of-book depth withheld (taker sees depth from level 2)
- [ ] Per-instrument scoring: toxic on SOL-PERP does not affect BTC-PERP score
- [ ] Score updated at end of each `settle_batch`; N = 100 batches (rolling window, governance-configurable)
- [ ] Indexer `/flow-quality/{address}` endpoint exposes the score

Without flow-quality defense, a toxic taker can systematically drain the protocol's maker rebates and insurance fund. The taker is never hard-rejected (always a valid fill path) — the effect is economic friction, not exclusion.

#### Insurance-Fund Inventory Management

Track the insurance fund's base/quote inventory separately so the liquidation optimizer can prefer rebalancing sweep directions.

- [ ] Add `insurance_base_reserves: i128` and `insurance_quote_reserves: i128` to the `Vault` struct
- [ ] Update liquidation optimizer tiebreaker: when two positions have the same impact ratio (IR), prefer the reduction that moves insurance fund inventory toward target balance (e.g., 50/50 base/quote)
- [ ] IR remains the primary ranking signal — inventory is a soft tiebreaker only
- [ ] Indexer `/insurance` endpoint exposes the inventory breakdown
- [ ] Post-liquidation state shows inventory rebalance direction

Without inventory tracking, repeated liquidations in one direction can leave the insurance fund one-sided. The rebalancing tiebreaker keeps the fund diversified without manual intervention.

#### Formal Verification (Kani)

Extend the existing 10 Kani math proofs to the safety-critical system invariants.

- [ ] Conservation: no value created or destroyed across pools (deposits + positions + insurance fund + fees = constant)
- [ ] No-over-withdrawal: a portfolio cannot withdraw more than its free collateral
- [ ] Liquidation progress: each optimizer iteration strictly reduces the margin gap or terminates (no infinite loop, no stalling)
- [ ] Funding conservation: funding payments are zero-sum across longs and shorts
- [ ] Self-trade prevention: a user can never match against their own resting order
- [ ] Batch integrity: all revealed orders are either matched, rested, or cancelled — none silently dropped

Kani is bit-precise model checking — it proves these invariants hold for all reachable states, not just the states our tests happen to cover.

**Phase 5 deliverable:** Toxic-taker detection + insurance inventory live on devnet, Kani proofs passing, indexer endpoints exposing flow-quality / insurance inventory. Full test suite green.
**Phase 5 measurement:** A synthetic toxic taker (constructed via setup txs) faces wider effective spreads vs a benign taker, with `FlowQualityScore` readable via indexer `/flow-quality/{address}`; inventory rebalance observable post-liquidation via `/insurance` endpoint; all 6 Kani system-invariant proofs pass (`kani --proof` exit 0); `cargo test --all-features` + clippy + build-sbf green.

### Phase 6 — Mainnet Readiness Prep ($0 funded — post-grant)

v1 requirements specify devnet-only. Mainnet deployment is the post-grant production step — gated on (a) an independent security review of the 3 on-chain programs, and (b) the beta-validated latency assumption from Phase 4. A Solana audit of mgk's three Pinocchio programs (the matcher alone is ~5,900 LOC) costs **$25K–$40K** — outside the $50K grant's scope. This tranche is not grant-funded; it describes the readiness preparation funded separately.

- [ ] Procure an independent security review of all 3 on-chain programs by an established Solana audit firm (candidates: Sec3, OtterSec, Neodyme, Zellic). No mainnet deploy without a public audit report with all critical/high findings remediated and reverified.
- [ ] Squads multisig (3-of-5) for privileged actions: program upgrade authority, pause authority, governance
- [ ] Mainnet program deploy (post-audit, post-multisig)
- [ ] Keeper infrastructure for mainnet — batch crank + liquidator + relayer — on multi-region VPS
- [ ] Frontend polish for production trading
- [ ] DEX aggregator outreach (2+ integrations)
- [ ] $100K cumulative trading volume within 30 days of mainnet deploy

**Deliverable:** Readiness preparation artifacts (audit procurement plan + multisig setup + governance docs + deploy runbook). Mainnet deploy itself is post-grant, gated on audit pass + beta-validated latency.

---

## Milestones & Tranches

| Tranche | Amount | Milestone | Verification |
|---|---|---|---|
| 1 | **$12,000** | Working perps dex on devnet — full trader loop via frontend | On-chain txs showing deposit, commit/reveal, ClearBatch, SettleBatch, position update, withdraw from an external wallet; resting orders visible; liquidation path exercisable; batch crank keeper 24/7 |
| 2 | **$10,000** | Testing + beta users on devnet | Integration tests green (trade + liquidation + pause flags, ≥90% coverage); 5–10 external beta testers each completed a full trade cycle; liquidator bot 24/7 with ≥10 synthesized liquidations |
| 3 | **$10,000** | Short-batch latency live on devnet | Batch params set (T_min=2/T_reveal=3/T_max=15), relayer bot operational, 10+ batches measured p50 < 4s p99 < 8s, zero slashes |
| 4 | **$6,000** | Short-batch beta rollout | 10–20 beta testers each completed 5+ trade cycles; latency feedback collected; ≥80% find ~2–4s acceptable; zero slashes |
| 5 | **$12,000** | Defensive enhancements + Kani proofs on devnet | Toxic taker faces wider spreads vs benign; inventory rebalance observable post-liquidation; 6 Kani system-invariant proofs pass; full test suite green |
| 6 | **$0** (post-grant) | Mainnet readiness artifacts (audit procurement, multisig, runbook) | Audit procurement plan + signed engagement letter; Squads multisig config; deploy runbook with go/no-go criteria |

**Grant total: $50,000** (Tranches 1–5). Tranche 6 is readiness prep and is not grant-funded.

---

## Keepers

mgk's *execution* is fully on-chain — every fill, settlement, liquidation verifiable on-chain — but the protocol does not self-advance. Three permissionless Node.js/TypeScript bots (~550 LOC total) are built and operated across the tranches, folded into the phases where they are intrinsic:

| Keeper | Built in | LOC | Measurement |
|---|---|---|---|
| **Batch Crank** | Phase 1 | ~150 | Cranks ≥10 batches at ≤1 slot lag average; uptime ≥95% |
| **Liquidator** | Phase 2 | ~300 | Executes ≥10 synthesized liquidations; detects underwater within 1 slot; positive returns after gas |
| **Pre-signed Reveal Relayer** | Phase 3 | ~100 | Submits ≥95% of reveals within 1 slot of commit confirmation |

Every keeper role is open-source and runnable by anyone; the relayer never has custody (it submits a user-signed tx). Devnet VPS operation across all phases (~$1K total) is folded into the tranches.

---

## Go-to-market

**Stage 1 — Public devnet stress test (Phase 2).** Open devnet to all comers before latency optimization. Recruit 5–10 beta testers from the Solana developer community via MadToast hackathons + Solana Hacker Houses, Discord/Reddit, and Twitter/X demo videos. Goal: 5–10 external wallets completing a full deposit → order → fill → settle → withdraw cycle.

**Stage 2 — Latency beta (Phase 4).** Invite Phase 2 testers back, plus new ones (target 10–20 total). Each completes ≥5 trade cycles on the short-batch version. Structured post-test feedback on latency acceptability, signing flow, order-status clarity. This is the core product-risk gate.

**Stage 3 — Coordinated mainnet rollout (Phase 6, post-grant).** Two weeks before mainnet: publish the independent security audit report, open-source the production frontend, announce launch partners. Mainnet launch markets — SOL-PERP, BTC-PERP, ETH-PERP from day one. Press + partner announcements coordinated to launch day.

**Stage 4 — Genesis Trading Campaign (post-mainnet, post-grant).** A 90-day mainnet incentive program funded from protocol revenue: boosted maker rebates, leaderboard rewards, trading competitions.

**Stage 5 — DEX aggregator + wallet integrations.** 2+ aggregator listings within 30 days of mainnet; Phantom/Solflare deep-link integration; SDK published to npm.

---

## Adoption metrics

| KPI | Target | When |
|---|---|---|
| Beta testers (devnet) | 10–20 by end of Phase 4 | Unique addresses completing trade cycles on devnet |
| Cumulative trading volume | $1M within 60 days of mainnet | On-chain settlement txs |
| Daily active traders | 50+ within 30 days of mainnet | Unique addresses with settled trades |
| TVL | $50K within 30 days | On-chain vault balances |
| DEX aggregator integrations | 2+ | Referral links or on-chain call data |
| Keeper network | 3+ independent keepers | Keeper registry count |

Core product-risk assumption: ~2–4s batch latency is acceptable for on-chain-preferring traders. Validated in two stages — Phase 2 beta (long-batch) and Phase 4 beta (short-batch) — before mainnet.

---

## Long-term impact

mgk is a reusable primitive for sequencer-free on-chain execution on Solana. The commit-reveal CLOB + Fisher-Yates shuffle + structural priority queue pattern transfers to other venues that currently rely on off-chain sequencers — options markets with continuous premium discovery, structured products with periodic batch auctions.

Ecosystem impact beyond mgk:

- Proves fully on-chain CLOB execution is viable without a sequencer trust assumption — a differentiated story against L2-based DEXs.
- The 4-layer fair ordering design (commit-reveal + shuffle + priority queues + price-time CLOB) is a template other Solana protocols can adopt.
- Kani bit-precise proofs on safety-critical perps invariants raise the bar for Solana DeFi correctness.
- Every keeper role is open-source and runnable by anyone, distributing protocol operation across the community.

---

## Why $50K

$50K funds **devnet validation** — Phases 1 through 5 — not mainnet deployment. Mainnet is gated on a post-grant independent security review whose cost ($25K–$40K for a 3-program Pinocchio scope of this size) exceeds the grant. We commit to no mainnet deploy without that audit passing. Phase 6 (readiness prep) is unfunded grant work that makes the path from grant-end to mainnet explicit and accountable.

$50K gets mgk from "3 programs deployed and architecturally complete on devnet" through "beta-validated short-batch DEX + defensive hardening + Kani proofs + 3 production-grade permissionless keepers operational on devnet" — ready to procure an independent audit and deploy mainnet the moment audit funding is secured.

---

## Team

mgk Protocol is led by a name of the founder or pseudonymous team. _[TODO: name, role, LinkedIn / GitHub / Twitter handles. A real name plus prior work beats a pseudonymous one. If pseudonymous, the proof-of-work (devnet programs, design docs, test coverage) substitutes for a public identity.]_

**Lead Engineer** — architecture, all on-chain programs (Rust + Pinocchio), indexer, frontend integration, keeper infrastructure. _[TODO: prior DeFi / Solana / Rust projects, GitHub handle, years of experience.]_

**Advisors** — _[TODO: token-economic review (funding rate design, liquidation mechanics); Solana ecosystem/partnerships (mainnet launch, aggregator discussions, foundation introductions).]_

**Proof of work (substitutes for team breadth at pre-beta stage):**

- **GitHub:** https://github.com/aeyakovenko/percolator
- **Devnet deploys:** 3 programs live and executable (core `3jYQ4mpW…`, matcher `AU4EKQAQ…`, oracle `6M9eEiDK…`)
- **On-chain verified:** ClearBatch (slot 473186843) + SettleBatch (slot 473187751), `err: None`
- **Tests:** 954 passing — 322 Rust + 632 frontend
- **Design depth:** 1,165-line design doc; file-by-file implementation report; public architecture doc
- **Code quality:** clippy clean (`-D warnings`); `cargo build-sbf` clean

Single-founder / pseudonymous teams are not disqualified — the proposal's substance (depth of work, devnet liveness, design rigor) compensates. Advisors will be named in the mainnet readiness phase.

---

## How to verify

- **Repo + git history:** https://github.com/aeyakovenko/percolator (`git log --oneline`)
- **Design doc:** `docs/ai/design/feature-onchain-perps-dex.md` · **Requirements:** `docs/ai/requirements/2026-06-18-feature-onchain-perps-dex.md` · **Implementation report:** `docs/ai/implementation/2026-07-03-feature-onchain-perps-dex.md`
- **Devnet explorer (core):** https://explorer.solana.com/address/3jYQ4mpWBBtwrzYQ4zzKhgqVcWWsG2HpXi9oXTBpekja?cluster=devnet
- **Devnet explorer (matcher):** https://explorer.solana.com/address/AU4EKQAQupEbMWPK9fuJA7CZqfcjM5Bpgf6Ew9Y7o2FF?cluster=devnet
- **Devnet explorer (oracle):** https://explorer.solana.com/address/6M9eEiDKy8imbDi44ZqquyfknNbveRjD4j9VnvYaHtmA?cluster=devnet
- **Registry (live):** https://explorer.solana.com/address/F7zWN2XrVqNDBBYqsYpgxHa6AuPK1aQE33kHwM4f8ayV?cluster=devnet
- **ClearBatch tx:** https://explorer.solana.com/tx/2KuYdsDxjnq8VAUcRsMYGUs6PcqszWZ4BYZmXV3XqSWk548LJvMLJWiVsd5NYqY6qsCh52n6A64WJQLw9kXsXQBv?cluster=devnet
- **SettleBatch tx:** https://explorer.solana.com/tx/5kSxSdUFtMwAXjBTp2fxPMBS96qWFDTWKut64C5MPh6xMkwreSKhYvAVjug9SM4NrM13XLyCJr6SY5mp2snPkavn?cluster=devnet
- **Tests:** `cargo test --all-features` (322 Rust) + `pnpm -r test` (632 frontend) + `pnpm exec playwright test` (27 E2E)

---

**Apply:** https://superteam.fun/earn/grants/agentic-engineering
