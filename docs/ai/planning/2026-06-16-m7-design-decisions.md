---
phase: planning
title: M7 Pre-Testnet — Design Decisions
description: Four architectural decisions resolved before M7 implementation begins. Each decision affects multiple P0 tasks.
---

# M7 Pre-Testnet — Design Decisions

> These decisions resolve ambiguities surfaced during the design-vs-impl audit (§6l) that affect multiple P0 tasks. They must be locked before 7.1–7.8 implementation begins.

## Decision 1: Batch Creation — Embed in SettleBatch

**Context:** P0 gap #1 — no batch creation flow. After batch settles, system stops. Design L122-138 implies sequential lifecycle; `SettleBatch` increments `batch_id_counter` but never creates the next Batch PDA.

**Options considered:**

| Option | Pros | Cons |
|--------|------|------|
| **A. Separate `CreateBatch` instruction** (disc 13) | Clean separation; keeper calls it independently | Gap between Settled and Committing where no orders land; extra keeper call; races if multiple keepers call it |
| **B. Embed in `SettleBatch`** | Atomic transition — settle + create in one TX; no idle gap; keeper already calls SettleBatch | SettleBatch gets slightly larger; must pass next-batch PDA as account |
| **C. Embed in `CloseCommitting`** | Earlier batch creation; more time for commitments | Premature — batch shouldn't exist until current one is settled |

**Decision: B — Embed in `SettleBatch`.**

Rationale:
- The keeper already calls `SettleBatch`; creating the next batch in the same TX is zero additional friction.
- Atomic transition eliminates the idle gap where no batch is in Committing.
- The compute cost of creating a ~108-byte Batch PDA (derive + zero-init) is negligible (~5K CU) compared to the O(C*F) settle loop.
- `SettleBatch` needs one additional account in its account list: the next Batch PDA. This is straightforward.
- Disc 13 stays available for future use if we ever need out-of-band batch creation.

**Implementation notes:**
- `SettleBatch` appends account: `[next_batch]` (writable, PDA derived from `["batch", current_batch_id + 1]`)
- After settling current batch, write `Batch { batch_id: current + 1, status: Committing, commit_deadline_slot: current_slot + registry.t_max_slots, ... }`
- If `current_batch_id + 1` PDA already exists (shouldn't), treat as error
- `CommitOrder` and `RevealOrder` already use the batch PDA; they don't change

---

## Decision 2: Risk Callback — Post-Hoc Margin Validation

**Context:** P0 gap #3 — risk callback defaults to always-continue. No over-leverage protection during matching. Design L89/L458-459 says "risk callback after each fill — if fill would breach margin, cancel remainder."

**The architectural problem:** The matcher runs inside a CPI called by Core. The matcher's `RiskCheckFn` is a compile-time function pointer (`fn(&RiskContext) -> RiskDecision`), not a runtime callback. Core cannot CPI back into itself from within the CPI (Solana forbids re-entrant CPI). Therefore, a truly margin-aware risk callback that reads Portfolio state during matching is architecturally infeasible on Solana's CPI model.

**Options considered:**

| Option | Pros | Cons |
|--------|------|------|
| **A. Real-time CPI per fill** (Core CPIs to Core per fill) | Matches design intent exactly | Re-entrant CPI is forbidden on Solana. Cannot CPI into Core from within Core's CPI to matcher. |
| **B. Pass margin caps to matcher** | Simple notional cap per user; no portfolio awareness needed | Caps are approximations — user can be under cap but over IMR with correlated positions. Requires Core to pre-compute caps and pass in CPI data. |
| **C. Post-hoc validation in Core** | Architecturally clean; fills are final; over-levered users go to liquidation | Fills that breach margin are permanent — cannot undo. But this is how perps DEXes typically work (Drift, Zeta, etc.). |
| **D. Hybrid: cap-based soft guard + post-hoc validation** | Two layers of defense; cap catches obvious over-leverage | More complex; two mechanisms to maintain. |

**Decision: D — Hybrid: per-user notional cap in risk callback + post-hoc margin validation.**

Rationale:
- Option A is architecturally infeasible (re-entrant CPI).
- Option B alone is insufficient for cross-margin portfolios where positions offset.
- Option C alone accepts fills that breach IMR, relying exclusively on liquidation. This is a safety concern for rapid leverage accumulation.
- Option D provides defense-in-depth:
  1. **Soft guard (in matcher):** Core pre-computes `max_notional_cap` per user from `portfolio.free_collateral * instrument.max_leverage`. Passes this as part of the CPI data (one u128 per user). Matcher's risk callback checks `cumulative_filled_notional > cap` and cancels remainder.
  2. **Hard check (in Core):** After applying all fills in `SettleBatch`, Core validates each portfolio's margin. If `portfolio.im > portfolio.free_collateral + portfolio.equity`, flag the portfolio for liquidation (but do not revert fills — fills are final).

**Implementation notes:**
- Extend CPI data format: add `user_caps: [(Pubkey, u128)]` array (one per unique user in batch). Struct: `user(32) + max_notional(16) = 48 bytes per user`.
- Matcher risk callback: `fn capped_risk_check(ctx: &RiskContext) -> RiskDecision` — checks `ctx.cumulative_notional > user_cap[user]`. This is a rough approximation but catches egregious over-leverage.
- Core post-hoc: after position/equity updates, if `health < 0`, mark portfolio for liquidation. Do not revert — fills are final.
- `RiskContext.cumulative_notional` already exists (u128 field).
- Per-user cap lookup in matcher: simple linear scan over the caps array. For 64 orders, this is at most 64 users. Acceptable compute.

**Design deviation:** This deviates from the design's per-fill margin check. The tradeoff is that fills may exceed IMR briefly (between batch settlement and liquidation). This is acceptable for pre-testnet — rapid liquidation keepers close the gap to seconds. Post-MVP, we can explore passing full portfolio state or using a more sophisticated cap model.

---

## Decision 3: Mark Price Storage — On Instrument, Not Batch

**Context:** P0 gap #5 — no mark price computation. Design L269 specifies `mark_price[i64; MAX_INSTRUMENTS]` on Batch. Current `clearing_price: i64` is a single VWAP value, not per-instrument.

**Options considered:**

| Option | Pros | Cons |
|--------|------|------|
| **A. `mark_prices: [i64; MAX_INSTRUMENTS]` on Batch** | Matches design L269; historical mark prices queryable per batch | Bloats every Batch PDA by 256 bytes (32 * 8); mark price only relevant for current batch; past batches are historical |
| **B. `mark_price: i64` on Instrument** | No Batch bloat; mark price always available on the account you're reading anyway (Instrument is read during SettleBatch for fees, funding, margin) | Can't query historical mark prices per batch (acceptable for MVP) |
| **C. Separate `MarkPriceAccount` PDA** | Clean separation of concerns; no account bloat | Extra PDA + account per instrument; more complex TX account passing |

**Decision: B — `mark_price: i64` on Instrument.**

Rationale:
- Mark price is per-instrument and used for: (1) funding rate calculation during SettleBatch, (2) liquidation marking, (3) equity computation. All of these read the Instrument account already.
- Storing on Batch means every Batch PDA carries 32 * 8 = 256 bytes of mark prices even for instruments with no fills. This wastes account space for no benefit — once a batch settles, its mark prices are only useful for historical queries (which we don't need for MVP).
- The funding rate formula uses `mark_price` from the current or most recent batch. Writing to Instrument means the latest mark price is always available without looking up a historical Batch.
- This also simplifies the SettleBatch account list — no need to pass `Instrument[]` accounts just to write mark prices (they're already writable for fee application).

**Implementation notes:**
- Add `mark_price: i64` field to `Instrument` struct (8 bytes, after `cum_funding`). Update `size_of` tests.
- During `SettleBatch`, for each instrument that had fills:
  1. Compute depth-weighted book mid or oracle fallback (per design L468-501)
  2. Write `mark_price` to the corresponding Instrument account
  3. Use this mark price for funding rate computation
- For instruments with no fills in the batch, carry forward the previous mark price (from `Instrument.mark_price`, which was set in the last batch that had fills).
- First batch ever: if no mark price exists, use oracle index price (per design L512).

**Design deviation:** Design L269 puts mark_price on Batch; we put it on Instrument. This is a practical optimization that preserves all functionality. Post-MVP, if historical mark prices are needed for an explorer/indexer, they can be reconstructed from on-chain events or stored separately.

---

## Decision 4: Liquidation Optimizer — Staged for MVP

**Context:** P0 gap #7 — liquidation is full-flat only. Design L559-644 requires hedge-preserving optimizer + market sweep + ADL. Full implementation is ~500 lines of complex logic.

**Options considered:**

| Option | Pros | Cons |
|--------|------|------|
| **A. Full Bulk.Trade optimizer** (design spec) | Hedge-preserving; impact-ratio ranked; iterative; market sweep via CPI | Very complex (~500+ LOC); requires CPI to matcher during liquidation; compute budget risk with 10 iteration loops |
| **B. Minimal: cancel orders + full-flat + insurance** (current + cancel) | Simplest; only adds order cancellation to existing code | Not capital efficient; zeroes healthy positions; no hedge preservation |
| **C. Staged: cancel orders + largest-position-reduction + insurance + ADL stub** | 70% of design value at 20% complexity; iterative reduction prevents full-flat overkill; ADL stub prevents bad debt black hole | No hedge detection; no market sweep (mark at oracle); no true ADL yet |

**Decision: C — Staged approach for MVP.**

Implementation phases:

### MVP (7.7):
1. **Cancel all open orders + commitments** — before marking positions, cancel every resting order and un-revealed commitment for the liquidated user. This is low-hanging fruit (CancelRestingOrder instruction exists; CancelCommitment is straightforward).
2. **Iterative position reduction** — instead of full-flat, reduce positions iteratively:
   - Sort positions by `abs(qty * mark_price)` descending (largest notional first)
   - Per round: reduce top position by 25% of notional (or 100% if only position left)
   - Up to 5 rounds (not 10 — we don't have market sweep, so more rounds don't help)
   - After each round, recompute `health`. If `health >= 0`, stop.
   - If still underwater after 5 rounds: full-flat remaining positions.
3. **Insurance fund** — already implemented (`vault.insurance_fund` claimed when `equity < 0`).
4. **ADL stub** — when `uncovered_bad_debt > 0` after insurance, set an `adl_pending: bool` flag on the Vault. Do not implement ADL counterparty deleveraging yet. A keeper can monitor this flag and trigger manual resolution (or we implement ADL as a follow-up).

### Post-MVP (not in 7.7):
- Hedge-preserving detection (skip positions where closing increases margin requirement)
- Impact-ratio ranking (estimate market impact from book depth)
- Market sweep via CPI to matcher (liquidation sells against the book instead of marking at oracle)
- True ADL with counterparty ranking and pro-rata distribution

**Why this works for pre-testnet:**
- Iterative reduction prevents the worst case of full-flatting a hedged portfolio.
- Oracle marking is already implemented and correct — it's just not capital-efficient.
- The ADL stub ensures bad debt doesn't silently accumulate — the `adl_pending` flag makes it observable.
- Market sweep via CPI during liquidation is architecturally tricky (the liquidation instruction would need to CPI to the matcher, which means liquidation needs to hold the book account writable). This is doable but adds CPI complexity that's not required for testnet.

**Implementation notes:**
- New instruction addition: `CancelCommitment` or batch-cancel all commitments for a user (or we handle this in liquidation by zeroing commitments in-place).
- `LiquidateUser` currently takes: portfolio, registry, vault, liquidator, oracle_accounts. It will now also need the book account (writable) for CancelRestingOrder, or we skip book cleanup and just zero positions at oracle price.
- For MVP, skip the book account in liquidation. Mark at oracle, reduce positions, claim insurance. Cancel resting orders via a separate `CancelAllRestingOrders` instruction called by the keeper before liquidation (or as step 0 of the liquidation flow).
- ADL stub: add `adl_pending: bool` and `adl_debt: u128` to Vault.

---

## Summary

| # | Decision | Choice | Design deviation? |
|---|----------|-------|-------------------|
| 1 | Batch creation | Embed in `SettleBatch` | No — design implies sequential lifecycle; this makes it atomic |
| 2 | Risk callback | Per-user notional cap + post-hoc margin validation | Yes — design says per-fill margin check; we use cap + post-hoc due to CPI re-entrancy |
| 3 | Mark price | Store on `Instrument.mark_price`, not `Batch.mark_prices[]` | Minor — same data, different location; no functional impact |
| 4 | Liquidation | Staged: cancel orders + iterative reduction + ADL stub | Yes — design calls for full optimizer + market sweep + ADL; MVP implements iterative reduction at oracle price, defers hedge detection and market sweep |

**All deviations should be revisited post-MVP.** The goal of M7 is a functional, safe pre-testnet system. Capital efficiency and fairness can be improved iteratively.

## Updated M7 Task Impact

| Task | Impact | Changes from decisions |
|------|--------|----------------------|
| 7.1 | Batch creation | Add next-batch account to `SettleBatch` account list; write new Batch PDA at end of settle |
| 7.2 | Deposit return | Unchanged |
| 7.3 | Reveal deadline | Unchanged |
| 7.4 | Funding rate | Read `Instrument.mark_price` instead of `Batch.mark_prices[]` |
| 7.5 | Mark price | Write to `Instrument.mark_price`, not `Batch`. Compute depth-weighted mid + oracle blend per design, but store on Instrument |
| 7.6 | Risk callback | Add per-user notional cap to CPI data. Matcher risk callback checks cap. Core validates margin post-hoc. Update CPI wire format |
| 7.7 | Liquidation | Iterative reduction (5 rounds, 25% per round) at oracle price, not market sweep. Cancel orders before liquidation. ADL stub on Vault, not full ADL. |
| 7.8 | PauseFlags | Unchanged |