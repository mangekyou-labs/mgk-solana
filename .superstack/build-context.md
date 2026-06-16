# mgk — Build Context

## Project
- **Name**: mgk (formerly percolator; rebrand commit 9c92cc7)
- **Description**: On-chain perpetual futures exchange with commit-reveal CLOB (Fisher-Yates shuffle + structural priority queues), price-time matching, persistent order book, and cross-margin. Built on Solana using Pinocchio (not Anchor).
- **Status**: MVP scope per 2025-06-15 strip — perps-dex only. Router/slab/AMM/CLI/keeper/Kani-prover scaffolding removed.

## Stack
- **Language**: Rust (`no_std`, zero-allocation, BPF-compatible)
- **Framework**: Pinocchio (no Anchor macros, no IDL, single-byte discriminators)
- **Platform**: Solana BPF
- **Testing**: `cargo test --all-features`, `cargo clippy --all-targets --all-features -- -D warnings`
- **Verification**: Kani (10 proofs in `common/math.rs`; deferred: conservation, no-over-withdrawal, liquidation progress)

## Architecture

### Programs (4)

| Program | Crate | Program ID | Role |
|---|---|---|---|
| oracle | `percolator-oracle` | declared in `lib.rs` | Fallback price feed (admin-pushed, auto-activate) |
| perps-core | `mgk-perps-core` | `DBrCzAMAJhxnPRQnBzEZGMhSALGfvQDDe6xEn2nU1uar` | Custody, batch lifecycle, CLOB state, liquidation |
| perps-matcher | `mgk-perps-matcher` | `AU4EKQAQupEbMWPK9fuJA7CZqfcjM5Bpgf6Ew9Y7o2FF` | CLOB matching (CPI target from core) |
| common | `percolator-common` | (library) | Account validation, errors, math, types |

### Patterns
- **Instruction dispatch**: single-byte u8 discriminator (`instruction_data[0]`)
- **Layers**: `entrypoint.rs` (raw byte deserialization + account validation) → `instructions/*.rs` (pure business logic)
- **PDAs**: seed-prefixed (`b"portfolio"`, `b"batch"`, `b"book"`, etc.)
- **CPI**: Core → Matcher (one-way; Matching Engine never calls Core)
- **Custody**: Core program is the only program authorized to move user funds
- **Testing**: inline `#[cfg(test)] mod tests` per source file; one integration test in `programs/perps-core/tests/lifecycle.rs`

### Error Ranges
- 0–99: common
- 100–199: router (legacy, from pre-strip code)
- 200–299: slab (legacy, from pre-strip code)
- 300–399: matching
- 400–499: risk
- 500–599: anti-toxicity (legacy, unused)
- 600–699: perps-core (reserved; current code uses 0-99 + design choices)
- 700–799: perps-matcher (reserved)

## Design

- **Design doc**: `docs/ai/design/feature-onchain-perps-dex.md`
- **Key mechanic**: Commit-reveal CLOB with Fisher-Yates shuffle seeded by `close_slot`, structural priority queues (cancels → ALO → regular), price-time priority matching, persistent order book
- **Collateral**: SOL-only
- **Oracle**: admin fallback (current); Pyth primary is post-MVP

## Build Status

- **Current milestone**: M7 (Pre-Testnet Criticals) in progress. 7.1 (Batch Creation), 7.2 (Commitment Deposit Return), 7.3 (Reveal Deadline Enforcement), 7.5 (Mark Price) done.
- **Milestones completed**: M1, M3, M4, M5, M6 (6a-6k), M7.1, M7.2, M7.3, M7.5
- **MVP complete**: Yes (commit-reveal + CLOB + liquidation + next-batch creation + deposit return + reveal deadline + mark price end-to-end on host; BPF interop sanity-checked via `lifecycle.rs`)
- **Tests passing**: 181 (1 ignored BPF-only test)
- **Clippy**: clean
- **Devnet deployed**: No
- **Program IDs**: placeholders registered in `programs/common/src/program_ids.rs`

### Test Inventory
| Crate | Tests |
|---|---|
| `percolator-common` | 42 |
| `percolator-oracle` | 5 |
| `mgk-perps-matcher` | 68 (+ 1 ignored) |
| `mgk-perps-core` (lib) | 62 |
| `mgk-perps-core/tests/lifecycle.rs` | 4 e2e (gated on `BPF_OUT_DIR`) |
| **Total** | **181 passing, 1 ignored** |

### Testing doc
- `docs/ai/testing/feature-mgk-onchain-perps-dex.md` — recreated 2026-06-16 after 2025-06-15 strip deleted it

### Key files
- Design: `docs/ai/design/feature-onchain-perps-dex.md`
- Plan: `docs/ai/planning/README.md`
- M7 design decisions: `docs/ai/planning/2026-06-16-m7-design-decisions.md`
- Testing: `docs/ai/testing/feature-mgk-onchain-perps-dex.md`
- AGENTS: `AGENTS.md`

## Devnet deployment status (2026-06-16)

| Program | ID | Size | SHA-256 |
|---|---|---|---|
| `mgk-perps-core` | `DBrCzAMAJhxnPRQnBzEZGMhSALGfvQDDe6xEn2nU1uar` | 99,768 B | `d642df415af46e16efce82146f9d2feceea161181f512b1d9b12ce46bb692eff` |
| `mgk-perps-matcher` | `AU4EKQAQupEbMWPK9fuJA7CZqfcjM5Bpgf6Ew9Y7o2FF` | 111,320 B | `1b26e8f9a2e8ca981392433124939b19b04f06897a63ad629532a918903a669e` |
| `percolator-oracle` | `6M9eEiDKy8imbDi44ZqquyfknNbveRjD4j9VnvYaHtmA` | 14,200 B | `cf0d07fa103027650bb0c8c20054d330d5803d1fbd6325f6dd45a4f19512efb0` |

- **Cluster:** devnet (`https://api.devnet.solana.com`)
- **Deployer:** `ECmGsGAAPJimTwLk3SzkQ39pUQbaBj7U5qgSRRgYSFy` (upgrade authority for all 3)
- **Build:** `cargo build-sbf` (platform-tools v1.43, Rust <1.87)
- **Pre-flight gates:** 247 Rust tests pass, 226 frontend tests pass, clippy clean
- **M7 status:** 7.1, 7.4, 7.5, 7.6 shipped; 7.7, 7.8 deferred to testnet

### Matcher canonical ID change
The original canonical keypair (`target/deploy/mgk_perps_matcher-keypair.json`, pubkey `9o2vTBBhEp6CYxNsDPsX79Euhzh8TtoLTSHR5R3jXebZ`) was broken on devnet: 3 deploy txs finalized with `Status: Ok` but the program account never appeared on-chain. A fresh keypair deployed cleanly. The old keypair is backed up at `/tmp/matcher-keypair-BROKEN-ID.json`.

### Oracle status
The Rust oracle (`percolator-oracle`) is now deployed. It supports admin-pushed prices via `UpdatePrice` (disc 1) and `SetAuthority` (disc 2). No keeper bot running yet — initial price push required before the chart can render real prices. See `programs/oracle/src/entrypoint.rs` for the instruction set.
