# MGK Perps

**A fully on-chain perpetual futures exchange on Solana — fair, fast, and transparent.**

MGK Perps is a permissionless perpetual futures DEX that runs entirely on Solana's runtime. Orders are matched through a **Dual Flow Batch Auction (DFBA)** — the same mechanism used by leading MEV-resistant protocols — ensuring fair price discovery without submission-time advantage. No centralized sequencer, no off-chain matching. Every trade, every liquidation, every funding payment happens on-chain.

> **⚠️ EDUCATIONAL USE ONLY**
>
> This code is provided for educational and research purposes only. It has not been audited for production use and should not be deployed to handle real funds. Use at your own risk.

---

## Why We Built This

Existing on-chain perps suffer from three problems:

1. **Unfair ordering** — first-to-submit wins, creating a latency race that favors insiders and HFT bots
2. **Centralized matching** — most "DEXes" match orders off-chain, inheriting the trust assumptions of a CEX
3. **MEV extraction** — sandwich attacks and frontrunning extract value from regular traders

MGK Perps solves all three. The DFBA mechanism batches orders within a time window, shuffles them deterministically, and clears at a uniform price. The result: **no one can profit from being faster**, and **no one can frontrun your trade**.

---

## Quick Start

```bash
# Clone the repo
git clone https://github.com/mangekyou-labs/mgk-solana.git
cd mgk-solana

# Run all tests
cargo test --all-features

# Run per-crate tests
cargo test -p mgk-common        # 42 tests — shared types, math, validation
cargo test -p mgk-oracle         # 5 tests  — fallback price oracle
cargo test -p mgk-perps-core     # 19 tests — custody, batch lifecycle, positions
cargo test -p mgk-perps-matcher  # 59 tests — DFBA matching engine

# Lint (warnings are hard errors in CI)
cargo clippy --all-targets --all-features -- -D warnings

# Build for Solana BPF (deployable)
cargo build-sbf
```

---

## Usage

### SDK (TypeScript)

```typescript
import { encodePostOrder, encodeDfbaClear } from "@mgk/sdk";

// Place an order (disc 20)
const ix = encodePostOrder({
  side: Side.Bid,
  isMaker: false,     // taker by default
  price: 150_000,     // $150.00 (6 decimals)
  qty: 1_000_000,     // 1 SOL
  instrumentId: 0,
  reduceOnly: false,
});
```

### Frontend

The `mgk-frontend/` directory contains a Next.js trading UI. See [`mgk-frontend/README.md`](mgk-frontend/README.md) for setup.

### Keeper / Indexer

The indexer and keeper bot live in `mgk-frontend/apps/indexer/`. The keeper cranks the batch lifecycle: `CloseCollecting → ClearBatch → SettleBatch`.

---

## Architecture

Three on-chain programs + one shared library, all built with [Pinocchio](https://github.com/anza-xyz/pinocchio) (no Anchor, no IDL):

| Program | Crate | Role |
|---|---|---|
| **Perps Core** | `mgk-perps-core` | Portfolio custody, batch lifecycle, mark price, liquidation |
| **Matcher** | `mgk-perps-matcher` | DFBA dual auction, order book, self-trade prevention |
| **Oracle** | `mgk-oracle` | Fallback price feed (admin-pushed, auto-activates on Pyth staleness) |
| **Common** | `mgk-common` | Shared types, math, account validation, error codes |

### Batch Lifecycle

```
 Collecting  →  Clearing  →  Settled
  PostOrder     DFBA dual     positions
  +deposit      auction       updated
                +alloc        fees/funding
```

Orders are posted during **Collecting**, matched at a uniform price during **Clearing** (DFBA bid/ask auctions), and settled with PnL/funding during **Settle**. Unfilled orders rest on the book across batches.

### Key Design Decisions

- **DFBA over commit-reveal** — eliminates submission-time advantage; Jump Crypto's dual auction paper
- **Deterministic clearing** — Fisher-Yates shuffle seeded by slot; no randomness bias
- **Structural priority** — cancels → post-only → regular; self-trade prevention
- **Persistent order book** — GTC orders survive across batches; no re-submission needed
- **Cross-margin** — single portfolio per user; positions offset across instruments

---

## Build

```bash
# BPF targets (deployable to Solana)
cargo build-sbf

# Native (for development and tests)
cargo build --lib --all

# Lint
cargo clippy --all-targets --all-features -- -D warnings
```

---

## Testing

```bash
# All tests
cargo test --all-features

# Per-crate
cargo test -p mgk-perps-matcher   # 59 tests
cargo test -p mgk-perps-core      # 19 tests
cargo test -p mgk-oracle           # 5 tests
cargo test -p mgk-common           # 42 tests
```

**Coverage:** 125 tests across 4 crates. BPF e2e tests for dual fill and one-sided liquidation pause.

---

## Contributing

1. **Fork** the repo and create a feature branch
2. **Write tests first** — we follow TDD; every PR needs tests
3. **Run the full suite** before submitting:
   ```bash
   cargo clippy --all-targets --all-features -- -D warnings
   cargo test --all-features
   ```
4. **Keep it `no_std`** — all on-chain code must compile for Solana BPF (zero allocations, no heap)
5. **Single-byte discriminators** — new instructions append to the match in `entrypoint.rs`
6. **Submit a PR** with a clear description of what changed and why

### Code Style

- Rust `no_std` for all on-chain programs
- Pinocchio entrypoints (no Anchor macros)
- Inline `#[cfg(test)] mod tests` in source files
- Error codes from `mgk-common/src/error.rs` (`MgkError` enum)

---

## Technology Stack

- **Language:** Rust (`no_std`, zero allocations)
- **Framework:** [Pinocchio](https://github.com/anza-xyz/pinocchio) v0.9.2
- **Platform:** Solana BPF
- **Frontend:** Next.js + TypeScript (`mgk-frontend/`)
- **SDK:** `@mgk/sdk` — TypeScript client for on-chain instructions

---

## License

Apache-2.0

---

**Status:** 125 tests passing ✅ | DFBA matching engine complete ✅ | M9 hardening in progress
