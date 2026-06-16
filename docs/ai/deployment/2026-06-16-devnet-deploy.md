# Devnet Deployment Report — 2026-06-16

## Overview

Three programs deployed to Solana devnet for the mgk perps DEX MVP:

| Program | ID | Size (B) | SHA-256 |
|---|---|---|---|
| `mgk-perps-core` | `DBrCzAMAJhxnPRQnBzEZGMhSALGfvQDDe6xEn2nU1uar` | 99,768 | `d642df415af46e16efce82146f9d2feceea161181f512b1d9b12ce46bb692eff` |
| `mgk-perps-matcher` | `AU4EKQAQupEbMWPK9fuJA7CZqfcjM5Bpgf6Ew9Y7o2FF` | 111,320 | `1b26e8f9a2e8ca981392433124939b19b04f06897a63ad629532a918903a669e` |
| `percolator-oracle` | `6M9eEiDKy8imbDi44ZqquyfknNbveRjD4j9VnvYaHtmA` | 14,200 | `cf0d07fa103027650bb0c8c20054d330d5803d1fbd6325f6dd45a4f19512efb0` |

## M7 Status

Shipped in this build:
- **7.1** Batch creation in `SettleBatch` (next-batch PDA created in place)
- **7.4** Funding rate accrual (depth-weighted premium from book mid vs oracle)
- **7.5** Mark price computation (stored on `Instrument`, not `Batch`)
- **7.6** Risk callback (per-user notional cap + post-hoc margin check)

Deferred to testnet:
- **7.7** Liquidation safety stack (staged approach, ADL)
- **7.8** PauseFlags

## Pre-Flight Gates

| Check | Result |
|---|---|
| `cargo test --all-features` | 247 tests pass |
| `cargo clippy --all-targets --all-features -- -D warnings` | clean |
| `cargo build-sbf` | exit 0, all 3 .so files produced |
| `pnpm --filter @mgk/sdk test` | 72/72 pass |
| `pnpm --filter web test` | 154/154 pass |

## Workarounds Applied (not in design)

1. **`is_multiple_of` → `x % n == 0`**: Rust 1.87+ stabilized `is_multiple_of`, but Solana platform-tools v1.43 ships an older Rust. Patched 4 sites in `programs/common/src/{math,account}.rs` with `#[allow(clippy::manual_is_multiple_of)]`.

2. **Move shared book types to `percolator-common`**: `perps-core`'s path dep on `perps-matcher` caused a duplicate `#[panic_handler]` lang item at link time. Moved `OrderBook`, `BookLevel`, `NULL_OFFSET`, `book_pda` to `programs/common/src/book.rs`. The matcher re-exports for backward compat.

3. **Matcher canonical ID change**: Original keypair `9o2vTBBhEp6CYxNsDPsX79Euhzh8TtoLTSHR5R3jJebZ` (the one in `lifecycle.rs:37` and `config.ts`) is broken on devnet — 3 deploy txs finalized with `Status: Ok` but the account never appeared on-chain. A fresh keypair deployed cleanly. The old keypair is backed up at `/tmp/matcher-keypair-BROKEN-ID.json`.

## Remaining Work Before Public Use

- [ ] **Keeper bot** for oracle price pushes (admin must call `UpdatePrice` until Pyth is wired)
- [ ] **Pyth primary** — current oracle is admin-pushed fallback only
- [ ] **M7.7** liquidation safety stack + ADL
- [ ] **M7.8** PauseFlags for emergency halt
- [ ] **CU profiling** for new instructions (capped_risk_check, sweep_book_side, apply_funding_to_instrument)
- [ ] **E2E test** running against real BPF (currently gated on `BPF_OUT_DIR`; has known equity-offset bug)
- [ ] **Audit** before any real capital

## RPC

- Default: `https://api.devnet.solana.com` (public, rate-limited)
- Recommended: Helius free tier for production devnet use

## Wallet

- Deployer: `ECmGsGAAPJimTwLk3SzkQ39pUQbaBj7U5qgSRRgYSFy`
- Balance at deploy: 74.25 SOL
- Balance after: 72.68 SOL
- All 3 programs have this wallet as upgrade authority
