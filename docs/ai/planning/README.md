---
phase: planning
title: On-Chain Perps DEX — Task Breakdown
description: Milestones and task breakdown for building the commit-reveal batch auction perpetuals DEX
status: implementation-complete
---

# On-Chain Perps DEX — Task Breakdown

## Context

The design doc (`docs/ai/design/feature-onchain-perps-dex.md`) specifies a fully on-chain perpetual futures exchange with commit-reveal batch auctions, uniform clearing, cross-margin, and on-chain funding. The existing Percolator codebase provides reusable infrastructure: portfolio margin, liquidation, oracle, AMM/slab matching, and verified math.

**Leverage existing code:**
- `programs/common/` — account validation, errors, instruction parsing, math helpers (**extended**: program IDs, clippy fixes)
- `programs/router/` — portfolio system pattern, PDA infrastructure, liquidation, insurance
- `programs/oracle/` — existing price oracle (already enhanced)
- `programs/slab/` — orderbook matching engine pattern
- `crates/model_safety/` — Q64.64 math, crisis/haircut, Kani proofs (**extended**: clippy fixes)

## Milestones

### Milestone 1: Fallback Oracle Enhancement (0.5–1 hr) ✅ DONE
**Goal:** Extend existing oracle program to support the fallback price feed required by the perps design.

- [x] Add `confidence: u64` and `is_active: bool` fields to oracle state
- [x] Add `SetAuthority` instruction (transfer admin)
- [x] Add `Activate` / `Deactivate` instructions
- [x] Add `SetPrice` with confidence interval
- [x] Unit tests for all new instructions (5 passing)
- [x] clippy clean

### Milestone 2: Perps Matching Engine Program (1–2 hr) ✅ DONE
**Goal:** Create a new stateless `mgk-perps-matcher` program that computes uniform clearing prices.

- [x] Scaffold new program: `programs/perps-matcher/` with standard Pinocchio entrypoint
- [x] Implement `Side` enum (Buy/Sell) and `LimitOrder` struct
- [x] Implement `ComputeClearing` instruction — uniform clearing price via sort+sweep (O(n log n))
- [x] Implement fill allocation at clearing price (pro-rata with remainder distribution)
- [x] Unit tests: empty orders, single order, all-buys, all-sells, mixed, exact equilibrium, no-match case (13 passing)
- [ ] Integration test: CPI from a test driver (deferred — needs local validator)
- [x] Add to `build-sbf` script (in workspace default-members)
- [x] clippy clean, all tests passing

### Milestone 3: Core Program — Portfolio & Instruments (1–2 hr) ✅ DONE
**Goal:** Create the perps core program with portfolio accounts and instrument registry.

- [x] Scaffold new program: `programs/perps-core/` with standard entrypoint
- [x] Define state types: `Portfolio`, `Position`, `Instrument`, `Batch`, `Commitment`, `RevealedOrder`
- [x] Implement `Initialize` (create instrument registry + governance) — discriminator 0
- [x] Implement `InitPortfolio` (create per-user portfolio PDA) — discriminator 1
- [x] Implement `Deposit` / `Withdraw` (SOL collateral with margin checks) — discriminators 2,3
- [x] Implement `AddInstrument` (governance-only, create instrument account) — discriminator 4
- [ ] Implement lazy funding accrual on portfolio touch (deferred to post-MVP)
- [x] PDAs: `["portfolio", user]`, `["instrument", id]`, `["vault"]`, `["registry"]`, `["batch"]`, `["commitment"]`
- [x] Unit tests for all instructions (9 state tests + 75 from other crates)
- [x] clippy clean, all tests passing

### Milestone 4: Core Program — Batch Lifecycle (2–3 hr) ✅ DONE
**Goal:** Implement the full commit → reveal → clear → settle batch lifecycle.

- [x] Implement `CommitOrder` (5) — store `sha256(side|price|qty|salt|user|batch_id)`, lock deposit
- [x] Implement `RevealOrder` (6) — verify hash, store revealed order params in-place
- [x] Implement `CloseCommitting` (7) — permissionless crank, validate N_min + deadline, use t_reveal_slots
- [x] Implement `ClearBatch` (8) — CPI to Matching Engine's `ComputeClearing` with serialized commitment data
- [x] Implement `SettleBatch` (9) — update positions, return/slash deposits, advance batch_id, credit insurance
- [x] Batch state transitions with validation (Committing → Revealing → Clearing → Settled)
- [x] Dynamic commitment deposit (`base_deposit * volatility_multiplier / 10_000`)
- [x] Unit tests: hash computation, reveal data, state transitions, deposit calculation (7 new tests)
- [ ] Integration test: end-to-end batch with multiple users (deferred — needs local validator)
- [x] clippy clean, all tests passing

### Milestone 5: Liquidation & Production Polish (1–2 hr) ✅ DONE
**Goal:** Add liquidation, insurance fund, and hardening.

- [x] Implement `LiquidateUser` (10) — mark portfolio at oracle ± band, settle positions, claim insurance if needed
- [x] Insurance fund accrual from slashes (SettleBatch credits vault.insurance_fund)
- [ ] Integration test: underwater user → liquidation → insurance claim (deferred)
- [x] Register program IDs in common crate (`program_ids.rs`)
- [x] Add to `build-sbf` and `Makefile` (already in workspace default-members)
- [ ] E2E test with local validator (test-validator) (deferred)
- [x] clippy clean, all tests passing

## Instruction Discriminators

| Disc | Instruction | Status |
|------|------------|--------|
| 0 | Initialize | ✅ |
| 1 | InitPortfolio | ✅ |
| 2 | Deposit | ✅ |
| 3 | Withdraw | ✅ |
| 4 | CommitOrder | ✅ |
| 5 | RevealOrder | ✅ |
| 6 | CloseCommitting | ✅ |
| 7 | ClearBatch | ✅ |
| 8 | SettleBatch | ✅ |
| 9 | LiquidateUser | ✅ |
| 10 | AddInstrument | ✅ |

Discriminators now match the design spec (`docs/ai/design/feature-onchain-perps-dex.md`).

## Test Summary

| Crate | Tests |
|-------|-------|
| percolator-common | 42 |
| percolator-oracle | 5 |
| mgk-perps-matcher | 13 |
| mgk-perps-core | 19 |
| **Total** | **79** |

## State Types Implemented

| Type | Location | Fields |
|------|----------|--------|
| Portfolio | `state/portfolio.rs` | user, equity, principal, pnl, im, mm, free_collateral, health, positions[] |
| Position | `state/portfolio.rs` | instrument_id, qty, entry_vwap |
| Registry | `state/registry.rs` | governance, instrument_count, volatility_multiplier, batch_id_counter, base_deposit, n_min, t_* |
| Instrument | `state/instrument.rs` | id, symbol, contract_size, tick, lot, imr, mmr, fees, leverage, oracle, cum_funding |
| Vault | `state/vault.rs` | balance, insurance_fund, uncovered_bad_debt, bump |
| Batch | `state/batch.rs` | batch_id, status, deadlines, clearing_price, totals |
| Commitment | `state/batch.rs` | batch_id, user, order_hash, deposit_lamports, status, nonce |
| RevealedOrder | `state/batch.rs` | user, side, price, qty, commitment_idx |

## Common Crate Changes

- Added `program_ids.rs` — function-based program ID registry for all 6 programs
- Added `kani` cfg check to `Cargo.toml` lints
- Fixed 14 clippy warnings across math, account, header, quote_cache, fill_receipt modules

## Dependencies

```
M1 (Oracle) ────► M2 (Matcher) ────► M3 (Core Portfolio) ────► M4 (Batch) ────► M5 (Liquidation)
```

## Non-Goals (Out of Scope for MVP)

- Multi-token collateral (SOL-only for MVP)
- Pyth oracle integration (use existing oracle program)
- Frontend/CLI for perps trading
- Keeper bot for mainnet
- Multisig governance (single admin key for MVP)
- Kani proofs for new code (can add post-MVP)
- Gas golfing / full CU optimization
- Lazy funding accrual on portfolio touch
- Full workspace clippy (router/slab/amm have ~150 pre-existing warnings)

## Remaining Work (Post-MVP)

- Integration/E2E tests with local validator
- Lazy funding accrual implementation
- Kani proofs for new perps instructions
- Fix pre-existing clippy warnings in router/slab/amm programs
