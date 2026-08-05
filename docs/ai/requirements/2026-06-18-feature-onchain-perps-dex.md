---
phase: requirements
title: mgk On-Chain Perps DEX — Requirements & Problem Understanding
description: Solana on-chain perpetual futures DEX. Dual Flow Batch Auction (DFBA) matching with user-designated maker/taker, dual uniform-price clears, persistent resting book, cross-margin, multi-venue index oracle (funding only), pure DFBA mark with liquidation pause when no dual clear, and insurance-fund inventory. The PRIMARY system; the mgk-frontend is a dependent subsystem.
---

# mgk On-Chain Perps DEX — Requirements & Problem Understanding

> **PRIMARY system.** This is the on-chain mgk protocol (`programs/*`): `mgk-perps-core`, `mgk-perps-matcher`, `mgk-oracle`, `mgk-common`. The mgk-frontend is a dependent subsystem and has its own requirements doc at `docs/ai/requirements/2026-06-16-feature-mgk-frontend.md` (must be amended in a follow-on pass for DFBA UX; currently describes commit-reveal).
>
> **M8 Decision (2026-06-19):** The wholesale PropAMM architecture is **rejected**. Selected PropAMM-inspired features remain as surgical improvements; several are **superseded or deferred** by the DFBA pivot (see § M8 Adoptions and § DFBA Decision Log).
>
> **Short-Batch Commit-Reveal Decision (2026-07-03):** **SUPERSEDED** by the DFBA Decision Log (2026-08-02). Commit-reveal, Fisher-Yates shuffle, structural priority queues, and the pre-signed reveal relayer are **out of v1 scope**. Historical rationale retained in § Short-Batch Decision Log (historical).
>
> **DFBA Decision (2026-08-02):** v1 matching is **pure Dual Flow Batch Auction (DFBA)** per the [Dual Flow Batch Auction paper](https://jumpcrypto.com/resources/dual-flow-batch-auction): open order posts during a governance-parameterized batch window; dual uniform-price auctions at clear; makers compete on price/size, not latency. Implementation constraints also reflect hands-on review of a third-party on-chain DFBA clear path (CU, stack, allocation, settlement footguns) — **lessons only; mgk does not copy that market model**. See § DFBA Decision Log and § On-chain DFBA engineering lessons.

## Problem Statement

Perpetual futures on Solana today are dominated by market structures with known failure modes:

1. **Central limit order books run by off-chain sequencers.** Fast, but a sequencer outage or compromise is a single point of failure. Trust: “the sequencer is honest and online.”
2. **Virtual AMMs with capped leverage.** Permissionless and always-on, but fixed curves: no resting depth, no dual-sided price expression. Trust: “the curve is correct.”
3. **Continuous on-chain CLOBs and proprietary AMM-style venues.** Continuous matching + time (or leader) priority reintroduces latency arbitrage and adverse selection; closed pricing logic further fragments liquidity and resists scrutiny.

mgk takes a third path: a **fully on-chain Dual Flow Batch Auction (DFBA) perps exchange**. Every order, fill, and settlement runs on-chain. Orders are posted openly during a short batch window; at window end a permissionless crank runs **two independent uniform-price auctions** (bid auction: maker-buy × taker-sell; ask auction: maker-sell × taker-buy). Clearing maximizes matched volume; fills in each auction share one price; makers never match makers and takers never match takers. There is no sequencer, no AMM curve, and no commit-reveal ceremony.

**Why DFBA (vs prior commit-reveal CLOB):** Continuous and time-priority books structurally reward speed and toxic flow (Budish et al.; DFBA paper). Commit-reveal hid intents but still cleared like a CLOB after shuffle. DFBA changes the **market structure**: competition shifts to price and size; both makers and takers can receive price improvement; within-batch arrival order has no priority.

**Affected users:**
- **Traders (natural flow)** who want on-chain perps with fair uniform batch pricing and no sequencer trust assumption.
- **Market makers** who want to quote two-sided liquidity without maker–maker adverse selection and without a latency arms race.
- **Keepers** who want permissionless roles (batch clear crank, liquidator, oracle publisher) with fee-based incentives.
- **Oracle keepers** who publish multi-venue fair value used as **index for funding only** (not mark).
- **Indexer / SDK consumers** who want a verifiable on-chain event stream.

## Goals & Objectives

### Primary goals

1. **Fully on-chain DFBA matching** — every order, dual-auction clear, fill, and settlement is verifiable on-chain. No off-chain solver, no off-chain order book.
2. **MEV / latency-arbitrage mitigation via market structure** — batching + uniform dual clears eliminate within-batch time priority and continuous crossing. Claim is structural mitigation (not “hidden mempool intents”): order contents are visible when posted; fairness comes from DFBA rules, not commit-reveal.
3. **User-designated maker/taker (default taker)** — each order carries an explicit role flag independent of arrival time. Natural-flow default is taker; makers opt in to provide liquidity.
4. **Persistent resting book (full DFBA rest)** — unfilled makers **and** unfilled takers rest across batches with role preserved until filled, cancelled, or modified.
5. **Dual uniform clearing prices** — each batch produces a bid-auction fill price/qty and an ask-auction fill price/qty (when each side crosses).
6. **Pure DFBA mark price** — when both auctions produce a usable clear, `mark = (bid_clear + ask_clear) / 2`. If either side lacks a usable clear, **liquidations pause**; trading continues. Multi-venue oracle is **not** on the mark path.
7. **Multi-venue oracle as index only** — 4-venue CEX aggregation for **funding index** (`funding = f(mark − index)`). Oracle staleness does not set mark; funding may pause or hold last accrual policy per design if index is stale.
8. **Cross-margin portfolio** — single SOL-collateralized account per wallet; positions across instruments share margin.
9. **3-layer safety stack** — liquidation optimizer → insurance fund → ADL. No global haircut. Liquidations require a valid DFBA mark (dual clear).
10. **Permissionless keepers** — anyone can crank batch clear/settle, liquidate (when mark valid), or update the multi-venue index oracle.
11. **Hard per-batch order cap, single-instruction clear** — on-chain DFBA fits Solana CU; excess lowest price-priority orders defer to the next batch.
12. **Self-trade prevention** — same portfolio cannot fill against itself in either auction.
13. **Taker-pays fee model** — takers pay flat bps; makers free in v1 (optional maker rebate later).
14. **Immediate cancel and modify** outside the auction (with margin re-check on modify).
15. **Insurance-fund inventory management (M8)** — fund tracks base/quote inventory; liquidation optimizer prefers rebalancing sweep directions when liquidations are allowed.
16. **Emergency pause** — independent pause for trading, withdrawals, liquidations, funding, and batch clear.

### Secondary goals

- **Kani formal verification** of safety-critical invariants: conservation of fills, no over-withdrawal, liquidation progress (when mark valid), funding conservation, batch atomicity, self-trade prevention, book integrity, makers-only-match-takers, uniform-price bound, dust non-extractable.
- **PDA authority isolation** — `mgk-perps-core` is the only program authorized to move user SOL.
- **Checked arithmetic throughout** — no `unwrap()` on arithmetic; rounding direction is protocol-favorable (round-down-to-protocol on pro-rata dust).
- **Graceful degradation** — no dual clear → liquidations pause, trading continues; stale index → funding policy per design, mark still DFBA-only when dual clear exists.
- **Friendly error mapping** — every program error code in the documented ranges maps to a human-readable message.
- **Public architecture document** — `docs/ARCHITECTURE.md` updated for DFBA (follow-on with design/grant).
- **CU-aware matching** — design and tests include a per-batch order-cap gate derived from an **mgk** DFBA clearing CU spike (third-party spike numbers are directional shape only).

### Non-goals (explicitly out of scope for v1)

- **Commit-reveal order flow** — no `CommitOrder` / `RevealOrder`, no commitment deposits, no slash-for-no-reveal, no pre-signed reveal relayer.
- **Fisher-Yates shuffle / structural priority queues / price-time CLOB matching** as the v1 matching engine (superseded by DFBA).
- **Off-chain DFBA solver + on-chain verification** — rejected (trust/MEV surface).
- **Multi-ix sub-batching** for deep books — v2+; v1 uses hard per-batch cap.
- **Designated market-maker whitelist** — permissionless user-designated roles only.
- **Toxic-taker PnL scoring** — deferred post-v1; DFBA structure + fees + cancel are the v1 defense.
- **Freshness-based mark blend (CLOB/oracle)** — superseded by pure DFBA mid + liquidation pause.
- **Continuous-time trading** — DFBA batches are the only execution model; continuous CLOB is v2+ research if ever.
- **Hybrid continuous CLOB + DFBA** — pure DFBA only.
- **Copying any third-party venue’s product model** — account layout, seat/vault schemes, continuous-CLOB UX, assembly cores, or fee/header schemas from other repos. External code is **risk reference only**.
- **Multi-collateral.** SOL-only.
- **Mainnet launch pre-audit.** Devnet only.
- **Mobile-native client.** Responsive web only.
- **Governance token / DAO.**
- **Wholesale PropAMM architecture.**
- **TEE-based / zkSNARK oracle.**
- **KYC / regulatory gating.**
- **Tokenized securities, prediction markets.**

## User Stories & Use Cases

### Persona 1: Trader (natural flow / taker-default)

- As a **trader**, I want to **post a limit order** in a single transaction with an explicit maker/taker flag (default **taker**) and a worst-case limit price, so that I get filled at the batch’s uniform clearing price with possible price improvement, without a two-step commit-reveal.
- As a **trader**, I want **unfilled quantity to rest** with the same maker/taker role into the next batch, so that I do not have to re-post every window (full DFBA rest).
- As a **trader**, I want to **cancel or modify** a resting order immediately in one transaction, so that I can leave or resize without waiting for the next clear.
- As a **trader**, I want to **see bid-auction and ask-auction clearing prices** (and the DFBA mid mark when both exist), so that I understand execution and margin mark.

### Persona 2: Market maker

- As a **market maker**, I want to **post maker buy and sell quotes** that compete on price and size (pro-rata at the margin), not on latency, so that I can quote tighter without continuous pick-off.
- As a **market maker**, I want **makers never to match other makers**, so that my resting liquidity only interacts with natural/taker flow.
- As a **market maker**, I want **immediate cancel/modify** between auctions so I can reprice between batch windows.

### Persona 3: Keeper (batch crank + liquidator)

- As a **batch crank keeper**, I want to **close the collection window and run dual DFBA clear + settle** when governance timing criteria are met, so that the protocol does not stall and I earn a share of taker fees.
- As a **liquidator keeper**, I want to **flatten an underwater portfolio only when a valid DFBA mark exists** (both auctions cleared), so that liquidations use an auction-native mark; when mark is unavailable, liquidations are paused.

### Persona 4: Oracle Keeper (index only)

- As an **oracle keeper**, I want to **publish multi-venue fair value** used as the **funding index**, so that the perp tracks external markets even though mark is DFBA-native.
- As an **oracle keeper**, I want my **keeper key registered** via governance so updates are accepted on-chain.

### Persona 5: Indexer / SDK consumer

- As an **indexer operator**, I want **events for posts, cancels, dual clears (bid/ask prices and matched qty), settles, funding, and liquidation pauses**, so that UIs can render DFBA state in real time.
- As a **third-party SDK consumer**, I want **encoders for post/cancel/modify/clear/settle** (single-byte discriminators, BPF layout) without commit-reveal helpers.

### Persona 6: Grant Evaluator / SCF Reviewer

- As a **grant evaluator**, I want a **public Architecture doc** that describes DFBA dual auctions, mark/index split, and no-sequencer settlement, with measurable latency and clear crank criteria (grant narrative to be updated in planning).

### Edge cases (product-level)

- Batch with **no cross** on one or both auctions → no fills on that side; **no DFBA mid** → liquidations paused.
- **Partial fill** at marginal price → price priority then pro-rata by size; dust round-down-to-protocol.
- **Per-batch order cap exceeded** → lowest price-priority orders skip this clear, remain resting for next batch.
- **Self-trade** (same portfolio on both sides of an auction) → excluded from match.
- **Paused market** → reject post/clear (and other pause flags as configured).
- **Taker limit not met** by clearing price → that order does not fill; rests (full rest) for next batch.

## Success Criteria

**v1 is done when (Devnet E2E):**

1. **All Rust tests pass** — `cargo test --all-features` exits 0; test suite includes DFBA clearing, allocation, self-trade prevention, rest-across-batch, and cap behavior.
2. **Clippy is clean** — `cargo clippy --all-targets --all-features -- -D warnings` exits 0.
3. **SBF builds with no stack overflow** — `cargo build-sbf` exits 0; zero stack-offset overflow lines (4096-byte limit).
4. **Programs deployed on devnet** — core, matcher, oracle with documented program IDs and fresh builds.
5. **End-to-end DFBA batch lifecycle on devnet** — at least one full cycle: open window → post maker + taker orders (single-tx posts) → crank dual clear → settle, with observed bid and/or ask uniform fills and resting unfilled orders carried to the next batch.
6. **Uniform-price + makers-only-match-takers verified** — tests (and at least one devnet batch) show all fills in an auction at one price; no maker–maker or taker–taker fills.
7. **Mark and liquidation policy** — after a dual clear, mark equals mid of the two clears; with only one or zero clears, liquidations are rejected/paused while posts still succeed (when trading not paused).
8. **Immediate cancel/modify** — resting order removed or resized in one tx outside clear.
9. **Self-trade prevention** — same-portfolio opposing maker/taker legs do not fill each other.
10. **Fee model** — taker fees accrue at configured bps; makers free on fills.
11. **Index/funding path** — multi-venue oracle updates accepted; funding uses mark vs index (not oracle-as-mark).
12. **Per-batch order cap** — configured cap enforced; overflow orders remain for next batch; clear instruction stays within CU budget at the configured cap (documented spike or bench).
13. **Pause flags** — trading, withdrawals, liquidations, funding, and clear can be gated independently.
14. **Insurance-fund inventory** — vault tracks base/quote inventory; visible via indexer or account read post-liquidation when liquidations run.
15. **Batch latency** — governance window defaults targeting ~1–2 slots (~0.4–0.8s) collection where chain conditions allow; p50/p99 clear latency measured over ≥10 batches and documented (exact SLOs finalized in design against crank + CU).

These criteria are devnet-only. Mainnet success criteria remain deferred.

**Superseded success criteria (no longer v1 gates):** commit-reveal lifecycle, reveal relayer, dual-sign commit+reveal, Fisher-Yates fairness demos, freshness-based mark blend, toxic-taker scoring observability.

## Constraints & Assumptions

### Technical constraints

- **Rust + Pinocchio**, `no_std`, zero-allocation, BPF-compatible. No Anchor macros, no IDL, no `anchor-spl`.
- **Single-byte discriminators** for instruction dispatch.
- **SBF v1 4096-byte stack limit** — DFBA clear must use scratch/in-place patterns; no large stack arrays (see § On-chain DFBA engineering lessons).
- **Solana per-instruction CU budget** (~1.4M hard; comfort target lower) — full DFBA batch = **two** auctions + allocation + settlement; **hard per-batch order cap** required. Expect roughly linear CU/order; measure on mgk — do not trust external absolute CU numbers.
- **Checked arithmetic** throughout; pro-rata dust is protocol-retained / unmatched per design.
- **PDA authority isolation** — core vault only moves SOL; matcher holds no funds.
- **CPI direction one-way** — core → matcher; matcher never calls core.
- **Open posts** — order side, price, size, and maker/taker flag are visible in the mempool when submitted (no commit-reveal hiding).

### Business / operational constraints

- **Devnet only** for v1.
- **Indexer** sibling service remains required for product UX.
- **Single admin governance** → Squads pre-mainnet.
- **Frontend** requirements (`feature-mgk-frontend`) are a **follow-on amendment** (commit-reveal UX → DFBA post/cancel UX).

### Assumptions (named)

- **Trader adoption hypothesis:** Sub-second to ~1s batch windows with open posts are acceptable for natural-flow perps users who prioritize no-sequencer, fair dual-auction pricing over continuous CLOB speed. Validated post-mainnet via DAU KPIs; if adoption fails, revisit (continuous CLOB or hybrid).
- **CU feasibility:** A governance-set per-batch order cap exists such that dual clear + allocate + settle fits one instruction at realistic v1 depth; exact cap from **mgk** CU spike in design.
- **Keeper reliability:** Permissionless clear crank is submitted each eligible window (fee share incentive); exact incentive math in design.
- **Index still needed:** Multi-venue oracle remains operational for funding even though it does not set mark.
- **Quiet book risk accepted:** Pure DFBA mark means liquidations may pause for extended periods if dual clears are rare — accepted product risk of Decision 7.
- **External DFBA code is lesson-only:** Do not copy third-party market layout, seats, continuous-book UX, or settlement models. Apply only CU, stack, conservation, clear-crank, and buffer-layout risk patterns to mgk’s perps architecture.
- One user = one wallet = one portfolio PDA.
- Design/testing/planning/ARCHITECTURE/grant docs that still describe commit-reveal are **stale** until their phases run.

## Questions & Open Items

### Design parameters (not product open questions — set in `dev-design`)

| # | Item | Notes |
|---|------|-------|
| D1 | Exact `T_batch` min/max/default slots | Decision 3: parameterized; default ~1–2 slots |
| D2 | `per_batch_order_cap` | From mgk CU spike + comfort budget |
| D3 | Taker fee bps | Flat; makers free |
| D4 | Pro-rata dust / rounding policy | Round-down-to-protocol; conservation invariants |
| D5 | Batch account / instruction shape | Replace commit-reveal state machine with collect → clear → settle |
| D6 | Mark validity window / last dual-clear freshness for liq | Pure mid only when dual clear exists this batch vs allow last dual mid for N slots — **default product intent: only current dual clear**; confirm in design |
| D7 | Funding formula and index staleness behavior | Index from multi-venue; mark from DFBA |
| D8 | Overflow selection rule detail | Lowest price-priority skip; tie-break |
| D9 | Events / indexer schema for dual clears | Bid/ask price, qty, mark, liq-paused flag |
| D10 | Migration from existing commit-reveal code | Rewrite matcher clear path; retire commit/reveal instructions |

### Preconditions / follow-ons

| # | Item | Owner | Blocks |
|---|------|-------|--------|
| 1 | ~~**Design phase** — rewrite matching architecture for DFBA~~ ✅ **DONE (2026-08-02)** — `docs/ai/design/feature-onchain-perps-dex.md` rewritten + reviewed for DFBA; D1–D10 settled | Design | Implementation |
| 2 | **Frontend requirements amendment** — remove commit-reveal dual-sign/relayer; single-tx post + DFBA status UX | Requirements (frontend feature) | Frontend success |
| 3 | **Grant proposal + ARCHITECTURE.md** — replace short-batch commit-reveal narrative with DFBA | Planning / docs | Grant evaluators |
| 4 | **mgk DFBA CU spike** — measure clear+alloc on matcher stack at candidate caps | Design / implementation | Cap choice (D2) |
| 5 | **M8 multi-venue oracle as index** — still required; retarget docs from mark-blend to index-only | Implementation | Funding |
| 6 | **Insurance inventory fields** — still in scope (M8 #4) | Implementation | Success #14 |
| 7 | **PauseFlags** — include clear/post gates; drop reveal-specific gates | Implementation | Success #13 |

### Resolved / deferred (not v1)

- **Toxic-taker scoring** — deferred post-v1 (Decision 11).
- **Freshness-based mark blend** — superseded by pure DFBA mid (Decisions 6–7).
- **Commit-reveal + relayer** — removed (Decision A).
- **DMM whitelist** — rejected (Decision 2).
- **Off-chain solver / multi-ix sub-batch** — rejected / v2 (Decision 5).
- **Wholesale PropAMM, multi-collateral, continuous CLOB, TEE/zk oracle, KYC** — unchanged non-goals.

## M8 Adoptions: Decision Log (updated for DFBA)

**2026-06-19: Surgical PropAMM adoptions** (original).  
**2026-08-02: Status under DFBA pivot.**

| # | Feature | v1 status under DFBA |
|---|---------|----------------------|
| 1 | Continuous multi-venue fair-value oracle | **Retained as funding index only** (not mark, not liquidation trigger price) |
| 2 | Freshness-based mark-price blend | **Superseded** — pure DFBA mid; liq pause without dual clear |
| 3 | Toxic-taker detection | **Deferred post-v1** |
| 4 | Insurance-fund inventory management | **Retained** |

Wholesale PropAMM architecture remains rejected.

### References

- Dual Flow Batch Auction (mechanism paper) — https://jumpcrypto.com/resources/dual-flow-batch-auction
- PropAMM market-structure context (M8 background only) — https://jumpcrypto.com/resources/propamms-and-the-next-chapter-of-permissionless-market-structure

## On-chain DFBA engineering lessons

> Derived from reviewing an external Solana DFBA clear implementation and CU de-risking spike. **mgk does not adopt that product’s model** (spot book, seats, continuous-CLOB heritage, account packing). Lessons below are engineering risks for **our** Pinocchio perps programs.

### Compute and structure

1. **Full-book clear is O(orders) per batch**, roughly **linear CU/order** when the algorithm is a two-pointer merge over sorted sides — not a constant per-fill cost like continuous match-by-match.
2. **A full DFBA batch ≈ 2× one auction** (bid + ask), then add allocation, settlement, events, and account I/O. Spikes that measure one auction only understate production cost.
3. **Hard per-batch order cap + single-instruction clear** is the viable trustless path; deep books without a cap blow the ~1.4M CU hard limit. Multi-ix sub-batching is a later upgrade path, not v1.
4. **Spike numbers are lower bounds**: pre-sorted input, no portfolio/margin updates, no oracle, no event emission. mgk must run its **own** CU gate on the real matcher path.

### Stack and scratch

5. **4096-byte stack frames fail fast** when clear scratch coexists with event buffers and large locals. Mitigations that work in practice: `#[inline(never)]` on heavy handlers, avoid allocating large side buffers on nested CPI frames, fixed-size scratch (`MaybeUninit` region split into sides), and in-place account traversal where possible.
6. **Flat order packing for clear** (price + size + identity) keeps the merge simple; document **byte width and slice offsets once** and test them. Comment/code drift (e.g. “16 bytes” vs actual wider records) causes silent wrong settlement.
7. **Buffer layout unit tests are mandatory.** A production clear path was observed re-slicing four side buffers (`maker-buy | maker-sell | taker-buy | taker-sell`) with **off-by-region indices** when applying settlement after clear — classic stack-pressure bug. mgk must assert layout invariants in tests before any fill is written to portfolios.

### Collection, allocation, settlement

8. **Cap semantics must be explicit.** Walking a combined bid/ask list with `total >= cap` is not the same as “top N makers and top N takers by price.” Under-specified caps bias which orders enter the auction. Spec: price-priority overflow to next batch (Decision 5) with a defined tie-break.
9. **Assume pre-sorted sides for the merge** (or sort then pay CU). Spikes that skip sort understate cost if mgk’s resting structure is not already price-ordered for each of the four DFBA legs.
10. **Marginal size cap (anti size-inflation)** is easy to design and then **accidentally disable** (e.g. pass `u64::MAX`). If design keeps a size cap, enforce it in the live clear path and test it.
11. **Do not recompute allocation twice inconsistently** (once for “result,” once inside settlement with different parameters). Single allocation → single apply.
12. **Spot seat base/quote netting ≠ perps settlement.** External DFBA settlement credits seat balances; mgk must map fills to **positions, margin, fees, and vault** under cross-margin — never copy seat/ATA transfer logic as the product model.
13. **Taker fee from quote notional at clearing price** (makers free) is a simple, testable fee path; round conservatively (protocol-favorable).
14. **Replay + pause on clear** (`batch_seq` / monotonic batch id, reject when paused, reject cap=0) are required for permissionless cranks.
15. **Self-trade prevention** is not free in dual-auction code — filter same-portfolio pairs at allocate/apply (Decision 13); do not assume external paths do it.
16. **Conservation and dust** — sum of maker fills == sum of taker fills == matched_qty − protocol dust; round-down-to-protocol; dust non-extractable. Formal-verification targets for the matcher.

### What mgk deliberately does not take from external venues

- Continuous price-time CLOB as the primary story (we are pure DFBA).
- Single “market PDA + seat” product shape as our architecture (we keep core + matcher + portfolio model).
- Assembly-first continuous matching optimizations as a v1 requirement.
- Open continuous-book aggregator fill semantics (DFBA clear is batch, not atomic continuous fill).

## DFBA Decision Log

**2026-08-02: Replace commit-reveal batch CLOB with pure Dual Flow Batch Auction**

### Problem

The v1 matching model was short-batch commit-reveal CLOB (Fisher-Yates + structural queues + price-time match). That is less novel than pure DFBA, still inherits CLOB-style match economics after reveal, and carries commit-reveal UX cost (two-phase flow, relayer, slash risk). We want a market structure that is fair for natural flow, attractive to makers, fully on-chain, and differentiated.

### Alternatives considered

| Option | Trade-off | Outcome |
|--------|-----------|---------|
| Keep short-batch commit-reveal CLOB | Shipped path; less structural novelty | Rejected |
| Commit-reveal collection + DFBA clear | Max intent hiding + DFBA; heavy UX/ops | Rejected (user: pure DFBA) |
| Continuous CLOB + RFQ (`feature-onchain-perps-dex-rfq`) | Low latency; abandons batch fairness | Not active v1 |
| Off-chain DFBA solver | Scales depth; reintroduces trust | Rejected |
| **Pure on-chain DFBA** | Novel; open posts; CU cap required | **Accepted** |

### Locked decisions

| # | Decision | Choice |
|---|----------|--------|
| A | Collection model | **DFBA-only** — open posts; no commit-reveal |
| 2 | Maker/taker designation | **User-designated; default taker** |
| 3 | Batch cadence | **Governance-parameterized window** (default ~1–2 slots; e.g. 1–4 slot knobs) |
| 4 | Resting behavior | **Full DFBA rest** (makers and takers rest with role preserved) |
| 5 | Depth / CU | **Hard per-batch order cap; single-ix clear**; multi-ix v2+ |
| 6 | Mark when dual clear | **mid(bid_clear, ask_clear)** |
| 7 | Mark when no dual clear | **Pause liquidations; trading continues; oracle not on mark path** |
| 8 | Oracle role | **Index / funding only** |
| 9 | Fees | **Takers pay flat bps; makers free** |
| 10 | Cancel/modify | **Immediate** outside auction |
| 11 | Toxic-taker scoring | **Deferred post-v1** |
| 12 | Documentation | **Amend `onchain-perps-dex` in place** |
| 13 | Self-trade | **Prevent** same portfolio matching itself |

### DFBA mechanics (normative for v1)

1. Collect buy/sell limit orders during the batch window (plus resting book from prior batches).
2. Separate **maker** vs **taker** by user flag (not arrival time).
3. Run two auctions:
   - **Bid auction:** maker-buy × taker-sell  
   - **Ask auction:** maker-sell × taker-buy  
4. Each auction: volume-maximizing uniform clearing price; no unmatched orders left at better prices than clear.
5. All fills in an auction at that auction’s single price (price improvement possible for both sides).
6. Allocation: price priority, then pro-rata by size at the marginal price; self-trades excluded.
7. Unfilled qty rests with same role; immediate cancel/modify allowed between auctions.
8. Repeat next window.

### Engineering lessons applied

See § On-chain DFBA engineering lessons (stack, CU, buffer layout, cap semantics, perps settlement mapping). Those constraints feed design; they do **not** change the locked product decisions above.

### Supersedes

- § Short-Batch Decision Log (2026-07-03) as **active** architecture (kept below as historical).
- Requirements/goals/stories that mandated commit-reveal, reveal relayer, shuffle fairness, freshness mark blend, and v1 toxic-taker scoring.
- Active status of continuous CLOB+RFQ design as v1 path (`docs/ai/design/feature-onchain-perps-dex-rfq.md` remains historical alternative).
- Memory entry “FIFO Batch Auction Design for Percolator Perps DEX” as active matching design (FIFO discriminatory pricing is not DFBA).

### Named assumptions

1. Sub-second–class batch windows are good enough for natural flow (DFBA paper ~100ms–1s UX band; Solana ~slot floor).
2. Hard order cap is acceptable for v1 depth; deep-book multi-ix is v2.
3. Accepting liquidation pauses without dual clear is better than oracle-as-mark for this product bet.
4. Frontend and grant docs update in follow-on phases.

## Short-Batch Decision Log (historical — superseded 2026-08-02)

**2026-07-03: Shrink commit-reveal batch windows from 30–60s to ~2–4s**

> **Status:** Superseded by § DFBA Decision Log. Retained for audit trail only. Do not implement reveal relayer or short-batch commit-reveal params as v1 direction.

### Problem (historical)

Original requirements specified 30–60s commit windows; grant proposal argued continuous CLOB. Short-batch commit-reveal was chosen as a compromise.

### Decision then: E (Short-batch commit-reveal)

T_min=2, T_reveal=3, T_max=15 slots; pre-signed reveal relayer; MEV “mitigated.”

### Why superseded

Pure DFBA is more novel, removes commit-reveal UX, and addresses latency/MEV at the matching-structure layer rather than as a sealed CLOB batch.

## See also

- `docs/ai/design/feature-onchain-perps-dex.md` — **UPDATED 2026-08-02** for DFBA (design review aligned)
- `docs/ai/design/feature-onchain-perps-dex-rfq.md` — historical continuous CLOB+RFQ alternative (not active v1)
- `docs/ai/testing/feature-mgk-onchain-perps-dex.md` — **STALE** until testing phase updates for DFBA
- `docs/ai/planning/README.md` / grant proposal — **STALE** short-batch narrative until planning update
- `docs/ARCHITECTURE.md` — **STALE** commit-reveal public arch until updated
- `docs/ai/requirements/2026-06-16-feature-mgk-frontend.md` — frontend subsystem; amend for DFBA UX in follow-on
- DFBA mechanism paper: https://jumpcrypto.com/resources/dual-flow-batch-auction
