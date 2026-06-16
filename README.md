# On-Chain Perps DEX

A fully on-chain perpetual futures exchange on Solana using a **commit-reveal CLOB** with **deterministic Fisher-Yates shuffle**, **structural priority queues**, and **price-time matching with persistent order book**. Aligned with Bulk.Trade's fair-ordering design.

> **⚠️ EDUCATIONAL USE ONLY**
>
> This code is provided for educational and research purposes only. It has not been audited for production use and should not be deployed to handle real funds. Use at your own risk.

## Quick Start

```bash
# Run all tests
cargo test --lib

# Per-crate
cargo test -p percolator-common
cargo test -p percolator-oracle
cargo test -p mgk-perps-core
cargo test -p mgk-perps-matcher
```

## Architecture

Three-program separation: **Core** (custody + batch lifecycle), **Matcher** (CLOB state + matching), **Oracle** (fallback price feed). Aligned with the Bulk.Trade safety stack and fair-ordering model.

### Core Program (`mgk-perps-core`)
- Portfolio management: cross-margin accounts tracking SOL deposits, positions, and PnL per user
- Batch lifecycle coordinator: commit → reveal → clear → settle
- Commitment registry: hashed orders, deposit locks, slashing
- Collateral vault: PDA-controlled SOL
- CLOB state owner: order book accounts, resting order lifecycle
- Mark price computation: depth-weighted book mid + oracle fallback

### Matching Engine Program (`mgk-perps-matcher`)
- **CLOB matching**: price-time priority. Aggressive orders walk the book, passive orders rest. Each fill at the resting (maker) order's price.
- **Deterministic shuffle**: Fisher-Yates seeded by `close_slot` — randomizes order within a batch, eliminating submission-time advantage.
- **Structural priority queues**: cancels → post-only/ALO → regular.
- **Self-trade prevention**: cancel resting order instead of matching same user.
- **Risk callbacks**: per-fill check; cancel remainder if margin would breach.
- **Persistent book**: GTC orders survive across batches.

### Oracle Layer (Fallback)
- Minimal on-chain price oracle
- Admin push, activates on Pyth staleness or manual override
- Auto-detected at instruction time

## Batch Lifecycle

```
Committing  →  Revealing  →  Clearing  →  Settled
   hash         verify       shuffle +      positions
   +deposit     +params      priority       updated
                +slats       + match        deposits back
                                            funding accrued
```

CLOB persists across batches — resting orders survive between clearing cycles.

## Build

```bash
# BPF targets (deployable)
cargo build-sbf

# Native (for tests)
cargo build --lib --all

# Lint
cargo clippy --all-targets --all-features -- -D warnings
```

## Testing

```bash
cargo test --all-features
```

**Coverage:** 123 tests across 4 crates:
- `percolator-common`: 42
- `percolator-oracle`: 5
- `mgk-perps-matcher`: 59
- `mgk-perps-core`: 19

## Technology Stack

- **Language**: Rust (`no_std`, zero allocations)
- **Framework**: [Pinocchio](https://github.com/anza-xyz/pinocchio) v0.9.2
- **Platform**: Solana BPF

## License

Apache-2.0

---

**Status**: 123 tests passing ✅ | M6 6a–6f complete ✅ | M6 6g–6k in progress
