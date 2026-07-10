---
phase: requirements
title: mgk On-Chain Perps DEX — Requirements & Problem Understanding
description: Solana on-chain perpetual futures DEX. Commit-reveal CLOB with Fisher-Yates shuffle, structural priority queues, price-time matching, persistent GTC order book, cross-margin, and four PropAMM-inspired defensive adoptions (multi-venue oracle, freshness-based mark price, toxic-taker detection, insurance-fund inventory). The PRIMARY system; the mgk-frontend is a dependent subsystem.
---

# mgk On-Chain Perps DEX — Requirements & Problem Understanding

> **PRIMARY system.** This is the on-chain mgk protocol (`programs/*`): `mgk-perps-core`, `mgk-perps-matcher`, `percolator-oracle`, `percolator-common`. The mgk-frontend is a dependent subsystem and has its own requirements doc at `docs/ai/requirements/2026-06-16-feature-mgk-frontend.md`.
>
> **M8 Decision (2026-06-19):** The wholesale PropAMM architecture — discrete tick book, `mgk-propamm` program, `LiquidateUserViaPropamm` (disc `0xF`), `PropAmmConfig`/`PropAmmPortfolio` accounts — is **rejected**. Four specific PropAMM-inspired features are **adopted** as surgical improvements to the existing CLOB. See § M8 Adoptions for the full decision log.
>
> **Short-Batch Decision (2026-07-03):** The commit-reveal batch windows are **shrunk from 30–60s to ~2–4s p50** (T_min=2 slots, T_reveal=3 slots, T_max=15 slots). The MEV protection claim is **downgraded from "MEV-resistant" to "MEV-mitigated"** — the shorter commit window (~0.8s hiding) provides less hiding time than long batches, but still prevents mempool front-running (hashed commitments), sandwich attacks (Fisher-Yates shuffle), and time-advantage (shuffle seed = close_slot). A **pre-signed reveal via permissionless relayer** eliminates slash risk from tight reveal windows: the user signs commit + reveal simultaneously, and a relayer submits the reveal after the commit confirms. The grant proposal (2026-06-24) is **amended** from "continuous CLOB, <400ms" to "short-batch commit-reveal, <8s p99" to match this direction. See § Short-Batch Decision Log for the full rationale and alternatives rejected.

## Problem Statement

Perpetual futures on Solana today are dominated by two market structures, both with known failure modes:

1. **Central limit order books run by off-chain sequencers** (Drift, Mango, Zeta, Phoenix-class). These are fast but introduce a single point of failure: a sequencer outage halts trading, and a sequencer compromise exposes the entire book. The trust assumption is "the sequencer is honest and online."
2. **Virtual AMMs with capped leverage** (Drift v2, Jupiter Perps, Perpetual Protocol v1). These are permissionless and always-on, but they use a fixed pricing curve and produce a single executable price — no resting depth, no price-time priority, no spread. The trust assumption is "the curve is correct."

mgk takes a third path: a **fully on-chain commit-reveal CLOB** where every order, fill, and settlement runs on-chain. The commit-reveal pattern is the on-chain equivalent of Bulk.Trade's BULKBFT quorum admission — it hides order contents during the commit phase, then admits revealed orders to a deterministic Fisher-Yates shuffle followed by structural priority queues (cancels → ALO → regular) and price-time matching against a persistent GTC book. There is no sequencer. There is no curve. There is only an order book, settled on-chain, every batch.

**Affected users:**
- **Traders** who want on-chain perpetual futures with CLOB-quality execution and no sequencer trust assumption.
- **Keepers** who want permissionless roles (batch crank, liquidator, oracle publisher) with fee-based incentives.
- **Market makers** who want price-time priority resting orders with maker rebates.
- **Oracle keepers** who run the multi-venue fair-value feed (Binance, Coinbase, OKX, Bybit → Solana), providing better mark prices, funding rates, and liquidation triggers for all protocol users.
- **Indexer / SDK consumers** who want a verifiable on-chain event stream to build applications on top of mgk.

## Goals & Objectives

### Primary goals

1. **Fully on-chain CLOB** — every order, fill, and settlement is verifiable on-chain. No off-chain matching, no off-chain order book.
2. **MEV-mitigated batch lifecycle** — commit-reveal seals orders (short ~0.8s commit window hides contents from mempool), Fisher-Yates shuffle eliminates time-advantage, structural priority queues guarantee fairness. Claim is "mitigated" not "resistant": the short commit window provides less hiding time than long batches, but the protection mechanisms (hash commitment, shuffle, structural priority) remain intact.
3. **Persistent GTC order book** — resting orders survive across batches; capital accumulates; makers earn rebates.
4. **Cross-margin portfolio** — single SOL-collateralized account per wallet; positions across instruments share margin.
5. **3-layer safety stack** — liquidation optimizer → insurance fund → ADL. No global haircut.
6. **Permissionless keepers** — anyone can crank batches, liquidate, or update the multi-venue oracle.
7. **PropAMM-inspired defenses (M8 adoptions):**
   - **7a. Continuous multi-venue fair-value oracle** — 4-venue CEX aggregation (Binance, Coinbase, OKX, Bybit), ~100ms updates, nonce-sequenced, on-chain via permissionless keeper. Better mark price, funding rate, and liquidation trigger than single-Pyth.
   - **7b. Freshness-based mark-price blending** — mark price weights CLOB vs. multi-venue oracle by oracle freshness (smooth graceful degradation when oracle is stale).
   - **7c. Toxic-taker detection** — flow-quality scoring in the matcher; known-toxic takers face widened spreads or withheld depth.
   - **7d. Insurance-fund inventory management** — fund tracks base/quote inventory; liquidation optimizer prefers sweep directions that rebalance the fund.
8. **Emergency pause** — independent pause for trading, withdrawals, liquidations, funding.

### Secondary goals

- **Kani formal verification** of safety-critical invariants: conservation, no over-withdrawal, liquidation progress, commitment integrity, funding conservation, batch atomicity, self-trade prevention, book integrity.
- **PDA authority isolation** — `mgk-perps-core` is the only program authorized to move user SOL.
- **Checked arithmetic throughout** — no `unwrap()` on arithmetic; rounding direction is protocol-favorable.
- **Graceful degradation** — if oracle is stale, liquidations pause but trading continues; if funding is stuck, positions remain but no new funding accrues.
- **Friendly error mapping** — every program error code in the 0–99 / 200–299 / 400–499 / 600–699 / 700–799 ranges maps to a human-readable message.
- **Public architecture document** — `docs/ARCHITECTURE.md` maintained alongside the internal design doc, using the Stellar Community Fund awarded-proposal benchmark format (intro, component responsibilities, contract reference table, data storage overview, operation flows with numeric examples, risk disclosure, decision log). Linked from the grant proposal and the repo README. Surfaces mgk's architecture to evaluators and integrators without requiring them to clone the repo or parse internal `docs/ai/` lifecycle docs. Surfaced as Persona 6 (Grant Evaluator) during the 2026-07-05 grant-proposal review.

### Non-goals (explicitly out of scope for v1)

- **Multi-collateral.** SOL-only. No USDC, no other SPL mints.
- **Cross-margin between markets** in the portfolio-risk sense. Cross-margin is within a single portfolio; instruments are margined independently in v1.
- **Mainnet launch pre-audit.** Devnet only. No real funds, no production hardening, no public marketing.
- **Mobile-native client.** Responsive web only. No React Native or native shells.
- **Governance token.** Single admin → Squads multisig pre-mainnet. No DAO, no token voting.
- **Wholesale PropAMM architecture (M8 full adoption).** The complete PropAMM system from Jump Crypto 2026 — discrete tick book (`mgk-propamm` program), `LiquidateUserViaPropamm` instruction (disc `0xF`), `PropAmmConfig`/`PropAmmPortfolio` accounts, offchain pricing engine as the sole price source — is explicitly out of scope. The CLOB is the architecture; PropAMM contributes defensive features, not the structure.
- **TEE-based keeper.** The multi-venue oracle keeper runs on commodity infrastructure (VPS, cloud). TEE (Intel TDX, AWS Nitro) is a post-v1 enhancement for keepers who want hardware attestation, not a requirement.
- **zkSNARK-proved oracle.** Proof generation time (~10-30s) is incompatible with the ~100ms update target. Re-evaluate when proof systems reach sub-100ms proving.
- **KYC / regulatory gating.** Anonymous wallets only. No jurisdiction checks, no sanctions screening.
- **Tokenized securities, prediction markets.** Out of scope; those are Jump Crypto's PropAMM extensions, not part of mgk.
- **Off-chain matching fallback.** Every match is on-chain. If the matcher CPI reverts, the batch retries — there is no "match in fallback path" mode.
- **Continuous-time trading (no batches).** The commit-reveal batch is the only execution model. A continuous CLOB mode is a v2+ feature.

## User Stories & Use Cases

### Persona 1: Trader (via frontend or third-party SDK)

- As a **trader**, I want to **submit a limit order** through the commit-reveal batch flow and have it rest on the GTC book until filled or cancelled, so that I can express a view without monitoring the market constantly.
- As a **trader**, I want to **cancel a resting order** immediately (outside the batch) and have it removed in one transaction, so that I can react to changing conditions without waiting for the next batch to clear.

### Persona 2: Keeper (batch crank + liquidator)

- As a **batch crank keeper**, I want to **advance the batch lifecycle** (`close_committing` → `clear_batch` → `settle_batch`) when the dynamic criteria are met, so that the protocol doesn't stall and I earn a share of taker fees (~10%).
- As a **liquidator keeper**, I want to **flatten an underwater portfolio** via the liquidation optimizer (hedge-preserving, impact-ratio ranked) and earn a liquidation bonus (~2.5% of liquidated notional), so that the protocol stays solvent.

### Persona 3: Oracle Keeper

- As an **oracle keeper**, I want to **watch CEX order books** (Binance, Coinbase, OKX, Bybit), compute a fair value every ~100ms, and **post a signed `PostMultiVenuePrice` transaction to Solana**, so that mgk's mark price, funding rate, and liquidation trigger reflect real cross-venue fair value.
- As an **oracle keeper**, I want my **keeper key registered** via governance, so that my updates are accepted on-chain and I earn keeper fees.
- As an **oracle keeper**, I want a **hot-standby failover** setup with PagerDuty alerting, so that if my keeper goes down another keeper's updates maintain the feed.

### Persona 3b: Reveal Relayer (Short-Batch)

- As a **reveal relayer**, I want to **watch for confirmed `CommitOrder` transactions** and **submit the user's pre-signed `RevealOrder` transaction** immediately after the commit lands, so that users never miss the tight ~1.2s reveal window and never get slashed for wallet/network latency.
- As a **reveal relayer**, I want to **earn a small relay fee** per successful reveal (paid from the commitment deposit return), so that running a relayer bot is economically sustainable.
- As a **trader**, I want my **wallet to sign commit + reveal in one action** and hand the pre-signed reveal to a relayer, so that I experience the two-step protocol as a single click with no slash risk.

### Persona 4: Toxic Taker (risk management perspective)

- As the **protocol**, I want to **score takers by historical PnL to the protocol** over a rolling window, so that known-toxic flow faces wider spreads or withheld depth.
- As the **protocol**, I want toxic-taker detection to be **per-instrument and rolling-window**, so that a trader who is toxic on SOL-PERP is not penalized on BTC-PERP where they may be benign.

### Persona 5: Indexer / SDK consumer

- As an **indexer operator**, I want to **subscribe to on-chain events** (fills, batch transitions, oracle updates, PropAMM oracle updates in M8) and serve a REST + WebSocket API with sub-500ms p99 query latency, so that the frontend and external integrators have a real-time view of protocol state.
- As a **third-party SDK consumer**, I want **raw instruction encoders and PDA derivation helpers** (single-byte discriminators, BPF layout) for every core/matcher/oracle instruction, so that I can integrate mgk into my application without re-implementing the wire format.

### Persona 6: Grant Evaluator / SCF Reviewer (documentation + grant-phase user)

> Not a runtime user of the DEX. A real user of the *grant submission artifacts*. Surfaced during the 2026-07-05 grant-proposal review against the awarded Stellar Community Fund precedent (Stellars Finance, $119.3K). Naming this persona makes the doc-artifact work (public architecture doc, demo video, team/gTM/measurements) explicit rather than emergent.

- As a **grant evaluator**, I want to **read a public-facing Architecture document** (Stellars-style skeleton: intro, component responsibilities, contract reference, data storage, operation flows with numeric examples, risk disclosure) so that I can assess technical depth without cloning the repo or parsing internal design docs.
- As a **grant evaluator**, I want to **see quantifiable per-deliverable Measurement blocks** for each grant tranche (e.g., "≥10 batches measured p50 < 4s, p99 < 8s", "≥95% of reveals submitted within 1 slot", "≥10 synthesized liquidations with `err: None`") so that I can verify milestones objectively rather than trust narrative claims.
- As a **grant evaluator**, I want to **see named team, advisors, prior work, and proof-of-work substitutes** so that I can assess execution credibility before granting funds.
- As a **grant evaluator**, I want to **see an explicit Go-To-Market plan** naming beta recruitment channels, Genesis Trading Campaign, and aggregator outreach so that I can judge post-grant adoption risk.
- As a **grant evaluator**, I want **honest mainnet-readiness disclosure** (audit cost realistic at $25K–$40K outside grant scope; Phase 6 = readiness prep not deploy) so that I can trust the team won't deploy unreviewed.

## Success Criteria

**v1 is done when (Devnet E2E):**

1. **All Rust tests pass** — `cargo test --all-features` exits 0; the test count is at least 316 (current) plus any new tests for M8 PropAMM when M8 lands. (Currently 316, with 1 BPF-only test ignored on host.)
2. **Clippy is clean** — `cargo clippy --all-targets --all-features -- -D warnings` exits 0 with no warnings. (Currently clean.)
3. **SBF builds with no stack overflow** — `cargo build-sbf` exits 0 and produces zero "Function ... Stack offset of N exceeded max offset of 4096 by M bytes" lines. This is the M7.7.R-R4b gate; it must hold after every change. (Currently clean — 0 overflow lines.)
4. **Three devnet-deployed programs** — `mgk-perps-core` (`DBrCzAMAJhxnPRQnBzEZGMhSALGfvQDDe6xEn2nU1uar`), `mgk-perps-matcher` (`AU4EKQAQupEbMWPK9fuJA7CZqfcjM5Bpgf6Ew9Y7o2FF`), `percolator-oracle` (`6M9eEiDKy8imbDi44ZqquyfjnNbveRjD4j9VnvYaHtmA`). Each is on devnet, has a fresh SHA-256, and is owned by the deployer key.
5. **End-to-end batch lifecycle on devnet** — at least one full `Committing → Revealing → Clearing → Settled` cycle has been exercised from a real wallet, with at least one resting order placed and at least one resting order cancelled via `CancelRestingOrder`. Mark price, funding accrual, and commitment deposit return all observed end-to-end.
6. **Liquidation path tested on devnet** — at least one liquidation flow has been triggered, with the optimizer selecting a reduction and the insurance fund or ADL absorbing any shortfall. (This may be a forced test by manipulating a portfolio into underwater state; no real funds at risk.)
7. **PauseFlags (M7.8) gates live on devnet** — `SetPauseFlags` (disc `0xE`) can independently pause `CommitOrder` / `RevealOrder` / `Withdraw` / `LiquidateUser` / funding step. Each flag has been toggled on and off, with the expected behavior verified in at least one transaction per flag.
8. **Multi-venue oracle live on devnet** — at least one registered keeper publishes `PostMultiVenuePrice` updates for SOL-PERP to the `MultiVenuePrice` PDA, with nonce incrementing on each accepted update. The indexer's `/multivenue` endpoint returns the current fair value and freshness.
9. **Freshness-based mark price active** — mark price computation in `settle_batch` blends CLOB mid and multi-venue fair value by oracle freshness (smooth degradation; no binary switch). Frontend shows oracle freshness indicator.
10. **Toxic-taker detection observable** — a synthetic adversarial taker (known-bad address) submitting aggressive orders is observed to face widened spreads vs. a benign taker, as verified by the indexer's `/flow-quality/{address}` endpoint.
11. **Insurance-fund inventory visible** — `Vault` tracks `base_reserves` and `quote_reserves` separately. Post-liquidation state shows inventory rebalance direction. Indexer `/insurance` endpoint exposes the inventory breakdown.
12. **Short-batch latency achieved on devnet** — batch parameters set to T_min=2 slots, T_reveal=3 slots, T_max=15 slots. At least 10 consecutive batches measured with p50 end-to-end latency < 4s and p99 < 8s (from first commit to batch settled). Frontend logs batch latency telemetry.
13. **Pre-signed reveal relayer operational** — at least one relayer bot running, submitting pre-signed `RevealOrder` txs within 1 slot of commit confirmation. Zero user slashes from reveal-window timeout across 50+ test orders. Frontend signs commit + reveal in one action and hands pre-signed reveal to the relayer.

These criteria are devnet-only. Mainnet success criteria (security audit, position caps, operational SLOs) are deliberately deferred and will be defined in a separate post-audit requirements doc.

## Constraints & Assumptions

### Technical constraints

- **Rust + Pinocchio**, `no_std`, zero-allocation, BPF-compatible. No Anchor macros, no IDL, no `anchor-spl`.
- **Single-byte discriminators** for instruction dispatch (`instruction_data[0]` = u8). Mapping table is the source of truth; see `docs/ai/design/feature-onchain-perps-dex.md` § API / Interface Contracts.
- **SBF v1 4096-byte stack limit per function** — enforced by the LLVM linker at `cargo build-sbf` time. Mitigated by `*_into` result-sink variants, BSS scratch buffers, and borrowing large state from account buffers (M7.7.R-R4b pattern).
- **Checked arithmetic throughout** — no `unwrap()` on arithmetic; rounding direction is protocol-favorable on every value-moving path.
- **PDA authority isolation** — `mgk-perps-core`'s vault PDA is the only key authorized to move SOL from portfolios. The matcher holds no funds.
- **CPI direction is one-way** — `mgk-perps-core` CPIs to `mgk-perps-matcher`; the matcher never calls back to core. Pyth is read-only (no CPI).
- **Commit-reveal is two transactions** — the matcher treats every order the same regardless of whether the submitter is a human trader or a PropAMM.

### Business / operational constraints

- **Devnet only** for v1. No mainnet, no real SOL, no real funds at risk.
- **Public RPC OK for devnet** — `https://api.devnet.solana.com` is the default; Helius free tier preferred for stability.
- **Indexer runs as a sibling service** — REST + WebSocket + SQLite. Must be runnable locally with `pnpm dev:indexer`. Lives in `mgk-frontend/apps/indexer`.
- **Single admin governance** — one key controls parameters. Pre-mainnet upgrade to Squads multisig (3-of-5 or similar) is required.

### Assumptions

- The on-chain programs are stable in their current form (M7.7 complete; M7.8 and M8 are additive). If the programs change, the TS encoders and PDA derivation in the SDK must change in lockstep.
- The on-chain batch cadence is set to **short-batch** parameters for viable trader latency: `t_min_slots` = 2 (~0.8s), `t_reveal_slots` = 3 (~1.2s), `t_max_slots` = 15 (~6s). Target: ~2–3s p50, <8s p99 end-to-end. These are governance-configurable on devnet and can be tuned based on load testing. See § Short-Batch Decision Log for rationale.
- **Pre-signed reveal via relayer:** The user signs both `CommitOrder` and `RevealOrder` transactions simultaneously (one wallet signing action). A permissionless relayer submits the pre-signed reveal tx after the commit confirms. This eliminates slash risk from tight reveal windows — the user never needs to sign a second time. The relayer cannot steal funds (the pre-signed tx has fixed instructions). Relayer infra is a simple off-chain bot (~100 LOC). See § Reveal Relayer persona.
- **Trader adoption hypothesis (named assumption):** ~2–4s batch latency is acceptable for traders who prioritize fully on-chain (no sequencer) settlement over sub-second sequencer-based execution. No on-chain perps DEX with 2–4s batch latency exists as a proven data point. Validated post-mainnet via grant KPI (50+ daily active traders within 30 days). If DAU < 50 after 30 days, revisit architecture (pivot to continuous CLOB). This is the core product-risk assumption.
- **Minimal on-chain changes for short-batch (named assumption):** The shipped on-chain programs (perps-core, perps-matcher, percolator-oracle) require NO structural changes for short-batch — only governance parameter updates (T_min/T_reveal/T_max). The `RevealOrder` instruction already accepts the right inputs with user-signer auth (satisfied by pre-signing). The work is frontend (sign commit+reveal together, hand pre-signed reveal to relayer) + new relayer bot + governance param tuning.
- Pyth has a working SOL/USD price feed on devnet. The mainnet SOL/USD feed ID is `H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG`. The devnet feed ID must be verified during frontend M5; if Pyth is unavailable on devnet, fall back to the on-chain admin-pushed `percolator-oracle`.
- One user = one wallet = one portfolio PDA. No multi-account, no subaccounts.
- The multi-venue oracle keeper (M8 adoption #1) can be run by the team on commodity infrastructure ($5–20/month VPS). TEE hardware is a post-v1 enhancement, not a v1 requirement.
- The Solana tx cost for `PostMultiVenuePrice` (~1-2KB signed tx, ~$0.00025 on mainnet-beta) is acceptable at 10 updates/second. Keeper operational cost is ~0.0002 SOL/day, negligible.
- Multi-keeper consensus (median or most-recent-valid) is sufficient trust model for v1. Dedicated TEE attestation (AWS Nitro, Intel TDX) is a post-v1 enhancement for keepers who want hardware attestation.

## Questions & Open Items

### Preconditions (must be resolved before v1 is done)

| # | Item | Owner | Blocks |
|---|------|-------|--------|
| 1 | **M7.8 PauseFlags** — only remaining P0. Implement `SetPauseFlags` (disc `0xE`) and gate `CommitOrder` / `RevealOrder` / `Withdraw` / `LiquidateUser` / funding step. | Implementation | Success criterion #7 |
| 2 | **Branch hygiene** — `feature-mgk-frontend` has M7.7 work as uncommitted changes; needs a clean merge from `feature/m7-liquidation-safety-stack`. | Repo hygiene | Lint cleanliness |
| 3 | **M7.7 design deviations** — 4 approved simplifications (no hedge-preserving, no impact-ratio, no market sweep CPI, stub ADL) are in the implementation but not yet backfilled into the design doc as "v1 simplifications." | Design follow-up | Doc/code alignment |

### M8 (PropAMM-Inspired Adoptions) — live open items

| # | Item | Owner | Blocks |
|---|------|-------|--------|
| 4 | **MultiVenuePrice account + instruction** — define `MultiVenuePrice` PDA (seed: `["multivenue", instrument_id]`), `PostMultiVenuePrice` instruction (disc `0x10`), and aggregation logic (median of valid keeper posts, or most-recent valid). No new program; add to `percolator-oracle` or core. | Implementation | M8 adoption #1 |
| 5 | **Keeper key registration** — governance can add/remove keeper pubkeys via a new `AddOracleKeeper` / `RemoveOracleKeeper` instruction. How many keepers minimum for quorum? What is the slashing/bonding mechanism for bad keeper data? | Design + governance | M8 adoption #1 |
| 6 | **`MultiVenuePrice` aggregation logic** — median of all valid posts? Most recent post from each keeper? Weighted median by keeper reputation? Fallback when < quorum posts? | Implementation | M8 adoption #1 |
| 7 | **Toxic-taker scoring parameters** — N (rolling window, batches), threshold (score below which spread widens), per-instrument flag. Configurable via governance? Stored in a new `FlowQualityScore` account per address? | Implementation | M8 adoption #3 |
| 8 | **Insurance fund inventory fields** — add `base_reserves: i128` and `quote_reserves: i128` to `Vault`. Update liquidation optimizer tiebreaker to prefer inventory-rebalancing sweep directions. Informational only (IR is primary signal). | Implementation | M8 adoption #4 |

### Short-Batch (2026-07-03 decision) — live open items

| # | Item | Owner | Blocks |
|---|------|-------|--------|
| 9 | **Reveal relayer bot** — implement a permissionless relayer (~100 LOC) that watches for confirmed `CommitOrder` txs and submits the user's pre-signed `RevealOrder` tx within 1 slot. Earns a small relay fee from the deposit return. | Implementation | Success criterion #13 |
| 10 | **Frontend dual-sign flow** — wallet signs `CommitOrder` + `RevealOrder` in one action, hands pre-signed reveal to relayer. User experiences single-click with no slash risk. | Implementation (frontend) | Success criterion #13 |
| 11 | **Governance param tuning on devnet** — set T_min=2, T_reveal=3, T_max=15 slots via `SetBatchParams` (or equivalent governance instruction). Load-test with 50+ orders to validate p50 < 4s, p99 < 8s. | Implementation + governance | Success criterion #12 |
| 12 | ~~**Grant proposal amendment** — update `docs/ai/planning/2026-06-24-mgk-perps-grant-proposal.md` Phase 1 from "continuous CLOB, <400ms" to "short-batch commit-reveal, <8s p99." Update scope, deliverable, and tranche 1 verification.~~ ✅ **DONE (2026-07-05)** — Grant proposal Phase 1 rewritten to short-batch; tranches restructured ($10K/$6K/$10K/$4K/$20K + Phase 6 unfunded readiness prep); Traction/GTM/Success-Criteria/Team sections added; `docs/ARCHITECTURE.md` public arch doc created; keeper subsections folded into Phase 1/2/3/5. See planning doc. |
| 13 | ~~**Relayer fee model** — how much does the relayer earn per reveal? Deducted from commitment deposit return? Fixed lamports per tx? Configurable via governance?~~ ✅ **RESOLVED (2026-07-05)** — **0.5% of locked commitment deposit**, governance-configurable; deducted from deposit-return on successful reveal; ~$170/day mainnet at ~$0.0002/tx × 864K txs/day. Multiple competing relayers keep fees honest; relayer never has custody (submits user-signed tx). Settled during grant-proposal Phase 3 keeper design; design doc § Keepers to be expanded. |
| 14 | ~~**Pre-signed tx blockhash expiry** — Solana pre-signed txs expire ~60–90s after signing (blockhash expiry). With ~1.2s reveal windows this is fine, but validate edge cases: commit tx delayed by congestion → pre-signed reveal may expire.~~ ✅ **RESOLVED (2026-07-05)** — Mitigation committed: if commit tx is delayed by congestion beyond ~80% of blockhash validity window, relayer re-requests signing from the user's wallet via a frontend callback. Default ~60–90s Solana blockhash is well above ~1.2s reveal window — edge case is rare, mitigation is straightforward. Resolved during grant-proposal Phase 3 keeper design. |

### Resolved (deferred to v2; not in v1 scope)

- **Wholesale PropAMM architecture** — the full PropAMM system (discrete tick book, `mgk-propamm` program, `LiquidateUserViaPropamm` disc `0xF`, `PropAmmConfig`/`PropAmmPortfolio` accounts, offchain pricing engine as sole quote source) is **rejected for v1**. Four specific PropAMM features are adopted as surgical improvements; three PropAMM components are rejected (discrete tick book replaces CLOB; offchain engine as only source of quotes is single-point-of-failure; 100ms cadence as only update rate ignores batch cadence). Rationale: prices must emerge from two-sided CLOB flow, not an external feed.
- **Multi-collateral** (USDC, etc.) — v2
- **Cross-margin between markets** in the portfolio-risk sense — v2
- **Governance token + DAO** — v2 or post-mainnet
- **Third-party oracle keepers** — v2. Registry is open in v2.
- **TEE-based keeper** — post-v1 enhancement. Commodity VPS is sufficient for v1.
- **zkSNARK-proved oracle** — post-v1. Incompatible with 100ms cadence given current proof generation times.
- **KYC / regulatory gating** — only if required for a specific fiat onramp
- **Tokenized securities, prediction markets** — Jump Crypto's PropAMM extensions, not mgk
- **Continuous-time trading (no batches)** — v3+ research item

## M8 Adoptions: Decision Log

**2026-06-19: Surgical PropAMM adoptions vs. wholesale architecture**

After reading the Jump Crypto PropAMM paper (April 2026) and the Solana.com "Understanding Proprietary AMMs" explainer, four specific features are adopted as surgical improvements to the existing mgk CLOB. The full PropAMM architecture is rejected.

### What was adopted (4 features)

| # | PropAMM feature | mgk equivalent | Implementation |
|---|----------------|-----------------|----------------|
| 1 | Continuous multi-venue fair-value oracle (~100ms, nonce-sequenced) | Multi-venue oracle keeper + `MultiVenuePrice` on-chain account | Keeper service (Node.js, ~300 LOC) + `PostMultiVenuePrice` instruction |
| 2 | Stale-oracle widening / freshness-based pricing | Freshness-weighted mark-price blend | Small change to `state/mark_price.rs` |
| 3 | Toxic-taker detection + flow-quality scoring | Pre-fill check scoring taker by historical PnL to protocol | New logic in `state/risk_callback.rs` |
| 4 | Inventory management for the insurance fund | Insurance fund tracks base/quote inventory; liquidation optimizer prefers rebalancing sweep directions | Accounting change in `state/vault.rs` + optimizer tiebreaker |

### What was rejected (3 features)

| # | PropAMM feature | Rejection reason |
|---|----------------|-----------------|
| 5 | Discrete tick book as resting depth | Replaces mgk's CLOB. mgk is a CLOB — the core architectural principle is that prices emerge from two-sided orderbook flow, not from an external feed. |
| 6 | Offchain pricing engine as the only source of quotes | Single point of failure. Contradicts mgk's "two-sided orderbook flow" principle (design:93). |
| 7 | The 100ms cadence as the only update rate | mgk is batch-based; oracle freshness affects mark-price quality, not order placement. |

### References

- Jump Crypto, "PropAMMs and the Next Chapter of Permissionless Market Structure," April 2026 — https://jumpcrypto.com/resources/propamms-and-the-next-chapter-of-permissionless-market-structure
- Solana.com, "Understanding Proprietary AMMs" — https://solana.com/vi/news/understanding-proprietary-amms
- Design doc § M8: `docs/ai/design/feature-onchain-perps-dex.md` (M8 section to be updated separately)

## See also

- `docs/ai/design/feature-onchain-perps-dex.md` — full architecture, data models, API contracts, design decisions, non-functional requirements, M8 PropAMM-Inspired Adoptions section (to be updated)
- `.superstack/build-context.md` — operational state, test inventory, deployment status
- `docs/ai/requirements/2026-06-16-feature-mgk-frontend.md` — frontend subsystem requirements (dependent on this doc)
- `docs/ai/deployment/2026-06-17-devnet-deploy-r4b.md` — current devnet deployment report (M7.7 + M7.7.R-R4b)

## Short-Batch Decision Log

**2026-07-03: Shrink commit-reveal batch windows from 30–60s to ~2–4s**

### Problem

The original requirements (2026-06-18) specified commit-reveal batching with 30–60s commit windows. The grant proposal (2026-06-24) contradicted this by specifying "continuous CLOB, <400ms, remove batch lifecycle." These two docs could not both be the v1 architecture. The core question: will traders use a perps exchange with 30–60s batch latency?

### Analysis

| Option | Latency | MEV | Sequencer | Eng cost | Adoption outlook |
|--------|---------|-----|-----------|----------|------------------|
| A. Keep 30–60s batching | 14–70s | Strong | None | Shipped | Poor — untenable for active traders |
| B. Continuous on-chain CLOB | ~400ms | None | None | Medium (rebuild) | Good — but abandons MEV mitigation |
| C. Drift hybrid (sequencer) | <100ms | None | Yes (SPOF) | High | Best — but abandons "no sequencer" |
| D. Bullet ZK rollup | ~100ms + proof lag | Crypto | None | Very high | Uncertain — unproven on Solana |
| **E. Short-batch commit-reveal** | **~2–4s p50** | **Partial** | **None** | **Low (params + relayer)** | **Bet — better than A, keeps MEV mitigation** |

### Decision: E (Short-batch commit-reveal)

Batch parameters shrunk: T_min=2 slots (~0.8s), T_reveal=3 slots (~1.2s), T_max=15 slots (~6s). Target ~2–3s p50, <8s p99.

### Key sub-decisions

1. **MEV posture downgraded** from "MEV-resistant" to "MEV-mitigated." The 2-slot (~0.8s) commit window hides order contents from the mempool, and the Fisher-Yates shuffle + structural priority queues remain intact. But the shorter hiding window is weaker than long batches. Honest framing.
2. **Pre-signed reveal via relayer** eliminates slash risk from the tight 1.2s reveal window. User signs commit + reveal simultaneously; a permissionless relayer submits the reveal after commit confirms. New ~100 LOC relayer bot, new keeper persona.
3. **Grant proposal amended** from "continuous CLOB, <400ms" to "short-batch commit-reveal, <8s p99." Phase 1 scope changes from "remove batch lifecycle, rebuild matching engine" to "frontend dual-sign + relayer bot + governance param tuning."
4. **On-chain programs unchanged** — batch params are governance-configurable; `RevealOrder` already accepts pre-signed submission. No structural program changes needed.

### Alternatives rejected

- **A (keep 30–60s):** "See where it goes" = likely slow failure. 30–60s is untenable for any active trader.
- **B (continuous CLOB):** Abandons the MEV-mitigation principle that differentiates mgk from Drift/Phoenix. The grant proposal's direction, but it throws away the commit-reveal value proposition.
- **C (Drift hybrid):** Off-chain sequencer = single point of failure. This is the exact trust assumption the requirements doc positions against in the Problem Statement.
- **D (Bullet ZK rollup):** ZK proof generation latency + no native Solana ZK verifier efficiency + essentially building an app-chain. Highest engineering cost, unproven on Solana.
- **"bulk.trade leveraging Solana consensus directly":** bulk.trade uses BULKBFT (a separate Byzantine-fault-tolerant consensus layer), not Solana L1 consensus. Solana's leader schedule can't provide BULKBFT guarantees (leaders can reorder within a block). The design already does the maximum feasible: uses `close_slot` (a consensus output) as the shuffle seed.

### Named assumptions

1. **Trader adoption hypothesis:** ~2–4s is acceptable for on-chain-preferring traders. Validated via 50+ DAU KPI within 30 days of mainnet. If unmet, revisit (pivot to continuous CLOB).
2. **Minimal on-chain changes:** Programs need only param updates, not structural changes. Work is frontend + relayer.
3. **Non-goal consistency:** "Continuous-time trading (no batches)" stays as a non-goal — we're still batching, just shorter.

### References

- Grant proposal: `docs/ai/planning/2026-06-24-mgk-perps-grant-proposal.md` (amended to short-batch)
- Design doc: `docs/ai/design/feature-onchain-perps-dex.md` § Batch Lifecycle (parameters to be updated)
- Implementation report: `docs/ai/implementation/2026-07-01-feature-onchain-perps-dex.md` (current shipped state)
