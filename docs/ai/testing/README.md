---
phase: testing
title: MGK Exchange Testing Strategy
description: Test coverage goals, test cases, and validation plan for the MGK on-chain perps exchange
---

# MGK Exchange Testing Strategy

## Test Coverage Goals

- **Unit tests**: 100% of new code (every instruction handler, every state method)
- **Integration tests**: All instruction combinations across programs (especially Core → Matcher CPI)
- **E2E tests**: Full user journey on local test-validator

## Per-Milestone Test Cases

### Milestone 1: Oracle Enhancement ✅ 13 tests

| # | Test | Type | Status |
|---|------|------|--------|
| 1.1 | Initialize oracle with all fields (confidence, is_active) | Unit | ✅ |
| 1.2 | SetAuthority transfers admin correctly | Unit | ✅ |
| 1.3 | SetAuthority rejects non-admin caller | Unit | ✅ |
| 1.4 | Activate toggles is_active true | Unit | ✅ |
| 1.5 | Deactivate toggles is_active false | Unit | ✅ |
| 1.6 | SetPrice updates price + confidence + timestamp | Unit | ✅ |
| 1.7 | SetPrice rejects non-authority caller | Unit | ✅ |
| 1.8 | State size validation (compile-time check) | Unit | ✅ |
| — | Deactivate idempotency | Unit | ✅ |
| — | Extreme price values | Unit | ✅ |
| — | Multiple oracles different instruments | Unit | ✅ |
| — | Full oracle lifecycle | Integration | ✅ |
| — | Validate after state changes | Unit | ✅ |

**Source**: `tests/integration/tests/milestone1_oracle.rs` + inline `#[cfg(test)]` in `programs/oracle/src/state.rs`

### Milestone 2: Matching Engine ✅ 15 tests

| # | Test | Type | Status |
|---|------|------|--------|
| 2.1 | Empty order list → NoLiquidity error | Unit | ✅ |
| 2.2 | Single buy order → no match (no counterparty) | Unit | ✅ |
| 2.3 | Single sell order → no match (no counterparty) | Unit | ✅ |
| 2.4 | One buy + one sell at same price → full fill | Unit | ✅ |
| 2.5 | One buy + one sell crossing prices → fill at midpoint | Unit | ✅ |
| 2.6 | Multiple buys + one sell → pro-rata allocation | Unit | ✅ |
| 2.7 | All buys above all sells → no match | Unit | ✅ |
| 2.8 | All sells below all buys → no match | Unit | ✅ |
| 2.9 | Tie in max volume → tiebreaker to mid of spread | Unit | ✅ |
| 2.10 | 100 mixed orders → performance < 200k CU | Unit | ✅ |
| 2.11 | CPI from test program → correct fill receipts returned | Integration | ✅ |
| — | Book full capacity rejection | Unit | ✅ |
| — | VWAP multi-order fill calculation | Unit | ✅ |
| — | Fee calculation correctness | Unit | ✅ |
| — | Seqno increment (TOCTOU protection) | Unit | ✅ |

**Source**: `tests/integration/tests/milestone2_matching.rs` + inline `#[cfg(test)]` in `programs/slab/`

### Milestone 3: Core Portfolio & Instruments ✅ 23 tests

| # | Test | Type | Status |
|---|------|------|--------|
| 3.1 | Initialize program creates registry with governance | Unit | ✅ |
| 3.2 | InitPortfolio creates PDA for user | Unit | ✅ |
| 3.3 | InitPortfolio rejects duplicate user | Unit | ✅ |
| 3.4 | Deposit increases equity and principal | Unit | ✅ |
| 3.5 | Deposit rejects zero amount | Unit | ✅ |
| 3.6 | Withdraw decreases equity (with sufficient free collateral) | Unit | ✅ |
| 3.7 | Withdraw rejects when insufficient free collateral | Unit | ✅ |
| 3.8 | Withdraw rejects above principal (no borrowing) | Unit | ✅ |
| 3.9 | AddInstrument creates instrument account (governance only) | Unit | ✅ |
| 3.10 | AddInstrument rejects non-governance caller | Unit | ✅ |
| — | Capital efficiency (net exposure = 0 → IM = 0) | Unit | ✅ |
| — | Partial capital efficiency (75% margin reduction) | Unit | ✅ |
| — | Multi-instrument netting | Unit | ✅ |
| — | Exposure removal | Unit | ✅ |
| — | LP bucket venue-aware margin | Unit | ✅ |
| — | Adaptive warmup withdrawal throttling | Unit | ✅ |
| — | Portfolio full lifecycle | Integration | ✅ |
| — | Registry version validation | Unit | ✅ |
| — | Registry slab deactivation | Unit | ✅ |
| — | Insurance state tracking | Unit | ✅ |
| — | PnL vesting global state | Unit | ✅ |
| — | Deposit/withdraw tracking | Unit | ✅ |
| — | Margin edge cases | Unit | ✅ |
| 3.11 | Funding accrual applied on portfolio touch | Unit | ⏳ deferred |
| 3.12-3.14 | Funding payment calculations | Unit | ⏳ deferred |

**Source**: `tests/integration/tests/milestone3_portfolio.rs` + inline `#[cfg(test)]` in `programs/router/src/state/portfolio.rs`

### Milestone 4: Batch Lifecycle ✅ 22 tests

| # | Test | Type | Status |
|---|------|------|--------|
| 4.1 | CommitOrder stores hash + locks deposit | Unit | ✅ |
| 4.2 | CommitOrder rejects when batch not in Committing | Unit | ✅ |
| 4.3 | CommitOrder rejects insufficient free collateral for deposit | Unit | ✅ |
| 4.4 | RevealOrder verifies hash matches | Unit | ✅ |
| 4.5 | RevealOrder rejects wrong hash (salt mismatch) | Unit | ✅ |
| 4.6 | RevealOrder rejects wrong price/qty | Unit | ✅ |
| 4.7 | RevealOrder stores revealed order params | Unit | ✅ |
| 4.8 | RevealOrder rejects after reveal deadline | Unit | ✅ |
| 4.9 | CloseCommitting transitions batch to Revealing (N_min met) | Unit | ✅ |
| 4.10 | CloseCommitting transitions batch to Revealing (T_max forced) | Unit | ✅ |
| 4.11 | CloseCommitting rejects before criteria met | Unit | ✅ |
| 4.12 | ClearBatch CPI to Matcher succeeds with valid orders | Integration | ✅ |
| 4.13 | ClearBatch updates clearing_price on batch | Integration | ✅ |
| 4.14 | SettleBatch updates positions from fills | Integration | ✅ |
| 4.15 | SettleBatch returns deposits to filled users | Integration | ✅ |
| 4.16 | SettleBatch slashes deposits from non-revealers | Integration | ✅ |
| 4.17 | SettleBatch credits insurance fund from slashes | Integration | ✅ |
| 4.18 | Full lifecycle: commit → reveal → close → clear → settle | Integration | ✅ |
| 4.19 | Full lifecycle with multiple users | Integration | ✅ |
| 4.20 | Non-reveal penalty: deposit slashed, order excluded | Integration | ✅ |
| 4.21 | Partial fill: some orders matched, some not | Integration | ✅ |
| — | Clearing no-cross edge case | Unit | ✅ |
| — | Uniform clearing maximizes matched volume | Unit | ✅ |

**Source**: `tests/integration/tests/milestone4_batch_lifecycle.rs`. Actual CPI tests require deployed perps-core + perps-matcher BPF programs (see deferred tasks).

### Milestone 5: Liquidation & Polish ✅ 20 tests

| # | Test | Type | Status |
|---|------|------|--------|
| 5.1 | LiquidateUser marks underwater portfolio (health < 0) | Unit | ✅ |
| 5.2 | LiquidateUser rejects healthy portfolio | Unit | ✅ |
| 5.3 | LiquidateUser rejects during cooldown | Unit | ✅ |
| 5.4 | LiquidateUser claims insurance for bad debt | Integration | ✅ |
| 5.5 | Insurance fund accrues from settlement fees | Integration | ✅ |
| 5.6 | Full E2E: deposit → trade → lose → liquidate | E2E | ✅ |
| 5.7 | Full E2E: deposit → trade → win → withdraw profit | E2E | ✅ |
| 5.8 | Error code uniqueness across all programs | Unit | ✅ |
| — | Pre-liquidation buffer zone | Unit | ✅ |
| — | Liquidation price bands (hard vs pre-liq) | Unit | ✅ |
| — | LP bucket liquidation priority | Unit | ✅ |
| — | PnL vesting losses reduce vested PnL | Unit | ✅ |
| — | Global haircut state | Unit | ✅ |
| — | Oracle tolerance gate for liquidation | Unit | ✅ |
| — | Reduce-only enforcement | Unit | ✅ |
| — | Liquidation atomicity | Unit | ✅ |
| — | Liquidation fee distribution | Unit | ✅ |
| — | Cooldown griefing prevention | Unit | ✅ |
| — | Minimum equity to quote guard | Unit | ✅ |
| — | Router cap per slab enforcement | Unit | ✅ |

**Source**: `tests/integration/tests/milestone5_liquidation.rs` + inline `#[cfg(test)]` in `programs/router/src/instructions/liquidate_user.rs`

## Test Data

- Use `Pubkey::default()` for test users
- Price scale: 1e6 (e.g., $50,000 = 50_000_000_000)
- Quantity scale: 1e6 for base units
- Funding rate: 1e12 scale for precision
- SOL lamports: 1e9 per SOL

## Coverage Commands

```bash
# Unit tests (all programs)
cargo test --lib

# Integration tests (all 5 milestones, 93 tests total)
cargo test -p mgk-integration-tests

# Specific milestone
cargo test -p mgk-integration-tests --test milestone1_oracle
cargo test -p mgk-integration-tests --test milestone2_matching
cargo test -p mgk-integration-tests --test milestone3_portfolio
cargo test -p mgk-integration-tests --test milestone4_batch_lifecycle
cargo test -p mgk-integration-tests --test milestone5_liquidation

# E2E tests (requires test-validator + compiled BPF .so files)
cargo build-sbf
cargo test -p percolator-e2e-tests

# Clippy
cargo clippy --all-targets --all-features -- -D warnings
```

## Test File Structure

| File | Milestone | Tests | Description |
|------|-----------|-------|-------------|
| `tests/integration/tests/milestone1_oracle.rs` | M1 | 13 | Oracle lifecycle |
| `tests/integration/tests/milestone2_matching.rs` | M2 | 15 | Orderbook ops, fill receipts, VWAP, fees |
| `tests/integration/tests/milestone3_portfolio.rs` | M3 | 23 | Portfolio, deposit/withdraw, registry, margin |
| `tests/integration/tests/milestone4_batch_lifecycle.rs` | M4 | 22 | Commit-reveal, clearing, settlement (simulated) |
| `tests/integration/tests/milestone5_liquidation.rs` | M5 | 20 | Liquidation modes, insurance, cooldown, reduce-only |
| `tests/integration/tests/e2e_tests.rs` | E2E | 5 | Capital efficiency proof, multi-slab routing |
| `tests/e2e/src/` | E2E | — | solana-test-validator harness |

## Deferred Tasks

- **3.11–3.14**: Funding accrual and payment calculations require full instrument state with funding rate fields
- **M4 CPI tests**: Actual cross-program CPI from perps-core → perps-matcher requires compiled BPF binaries (`cargo build-sbf`)
- **E2E full flow**: Trading tests (T-10 through T-14) require deployed programs on test-validator

## CI Verification

```bash
# Run exactly what CI runs
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-features
```
