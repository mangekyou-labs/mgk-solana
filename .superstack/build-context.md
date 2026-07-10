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
| perps-core | `mgk-perps-core` | `3jYQ4mpWBBtwrzYQ4zzKhgqVcWWsG2HpXi9oXTBpekja` | Custody, batch lifecycle, CLOB state, liquidation |
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

- **Current milestone**: M8.1 deployed (2026-06-20). M8.2–M8.5 not started.
- **Milestones completed**: M1, M3, M4, M5, M6 (6a-6k), M7.1, M7.2, M7.3, M7.4, M7.5, M7.6, M7.7, M7.8, M7.7.R (all tasks)
- **MVP complete**: Yes — R4b fix unblocks BPF build + devnet deploy.
- **Tests passing**: 322 (1 ignored BPF-only test)
- **Clippy**: clean
- **Devnet deployed**: Yes — 2026-06-29 (fresh deploy after stale registry cleanup, verified 2026-07-01)
- **Program IDs**: all 3 registered in `programs/common/src/program_ids.rs` (perps-core is `3jYQ4mpWBBtwrzYQ4zzKhgqVcWWsG2HpXi9oXTBpekja`)

## Blocking Issues

| Issue | Cause | Workaround | Fix |
|---|---|---|---|
| BPF deploy: `.bss` NOBITS sections rejected | Mangled `static mut` section name >16 chars + writable NOBITS type | After every `cargo build-sbf`: 3-step pipeline (see below) | Fixed: `BUMP_SEED` in plain `.bss` section + `addr_of_mut!` pattern |

### Test Inventory
| Crate | Tests |
|---|---|
| `percolator-common` | 43 |
| `percolator-oracle` | 5 |
| `mgk-perps-matcher` | 85 (+ 1 ignored) |
| `mgk-perps-core` (lib) | 183 |
| `mgk-perps-core/tests/lifecycle.rs` | 7 e2e (gated on `BPF_OUT_DIR`) |
| **Total** | **322 passing, 1 ignored** |

### Testing doc
- `docs/ai/testing/feature-mgk-onchain-perps-dex.md` — recreated 2026-06-16 after 2025-06-15 strip deleted it

### Key files
- Design: `docs/ai/design/feature-onchain-perps-dex.md`
- Plan: `docs/ai/planning/README.md`
- M7 design decisions: `docs/ai/planning/2026-06-16-m7-design-decisions.md`
- Testing: `docs/ai/testing/feature-mgk-onchain-perps-dex.md`
- AGENTS: `AGENTS.md`

## Debug Issues Resolved

| Error | Cause | Fix |
|---|---|---|
| `cargo build-sbf` 4 "Stack offset of N exceeded max offset of 4096" errors | Large stack arrays (BookState 27KB, orders 3.5KB, MatchResult 7KB, caps 3KB, etc.) allocated on BPF call frames exceeding 4096 limit | BSS scratch pattern: `static mut SCRATCH: [u8; N]` + `scratch_*()` accessors; `book_state_from_bytes_mut()` borrowed from account buffer; `*_into()` in-place result sinks; host-only functions gated `#[cfg(not(target_os = "solana"))]` |
| `error: unexpected closing delimiter` in `clearing.rs` | Edit remnant left orphaned field lines after adding `pub(crate)` to `SellEntry` | Removed duplicate field lines |
| `error[E0015]: cannot call non-const fn in statics` for `Pubkey::default()` | `pinocchio::pubkey::Pubkey = [u8; 32]` — `Default` not const-evaluable in static context | Changed `Pubkey::default()` to `[0u8; 32]` in all scratch static initializers |
| Matcher `process_clear_and_match` stack 4280 bytes (184 over) | `PartitionedOrders` (3656 bytes) still on stack after scratch orders + caps | Added `SCRATCH_QUEUES: static mut PartitionedOrders` BSS buffer |
| `compute_clearing` still compiled into BPF despite being "only for tests" | Function not cfg-gated; BPF compiler saw it via entry point call chain | Gated `compute_clearing`, `clob_match`, `clob_match_with_risk`, `clob_match_with_caps` with `#[cfg(not(target_os = "solana"))]` |
| `CreatePortfolio` disc 18 `InvalidLength` from `sol_invoke_signed_c` | Manual `SignerSeedsC` byte-layout passed flat `[len+seed_bytes, ...]` buffer; BPF loader reads it as `SignerSeedsC { pubkey: bytes0-31, seeds_ptr: bytes32-39 (pointing into SAME buffer, not a valid addr), num_seeds: bytes40-47 }` → memory access fails | Replaced with `pinocchio::cpi::invoke_signed` + `Seed::from(&[u8])` + `Signer::from(&signer_seeds)` |
| `CreatePortfolio` bump seed still failing | Bump seed in stack-allocated `&[bump]` — host-stack pointer invalid in BPF context | Bump written to `static mut BUMP_SEED` in plain `.bss` section, accessed via `addr_of_mut!` + BPF-translatable pointer |
| `CreatePortfolio` program_ids.rs mismatch | `program_ids.rs` hardcoded `CzWqtmcrm...` but program deployed at `CThnLgZ...` → all CPI calls within program routed to wrong address | Updated `PERPS_CORE_ID` in `program_ids.rs` to `CThnLgZvomva1HHQZVoZk4or9RDgyfCTrXXZqEMCR7JN`, rebuilt and redeployed |

## Init Scripts & Keeper Issues Resolved

| Issue | Cause | Fix |
|---|---|---|
| init-protocol.ts and keeper.ts default to old perps-core ID | Old hardcoded default | Updated default to `CThnLgZvomva1HHQZVoZk4or9RDgyfCTrXXZqEMCR7JN` in all scripts (2026-06-24) |
| init-protocol.ts creates vault as keypair, keeper derives vault as PDA | Solana 4.x createAccount limitation + mismatched addressing | Removed vault creation from init-protocol; vault created by keeper via SettleBatch CPI |
| Keeper loses batch keypair on restart (in-memory only) | `currentBatchKeypair` not persisted | Added `loadBatchKeypair()`/`saveBatchKeypair()` using `~/.config/solana/mgk-batch-keypair.json` |
| Oracle account doesn't exist on devnet, `UpdatePrice` fails | Oracle PDA never created/initialized | Keeper now auto-initializes oracle on startup: creates oracle keypair account, calls oracle Initialize (disc 0), persists to `~/.config/solana/mgk-oracle-keypair.json` |
| CreateBatch corrupts registry `batch_id_counter` + batch's own `batch_id` | BPF alignment bug in `Batch.initialize_in_place()` | Replaced with direct byte-offset ptr writes in `create_batch.rs` |
| Instrument initialization writes fields at wrong offsets on BPF | BPF alignment bug in `Instrument.initialize_in_place()` | Replaced with direct byte-offset ptr writes in `initialize.rs` |
| SDK `encodeCommitOrder` off-by-one (price@6→@5, qty@14→@13, salt@22→@21, batchId@30→@29, bump@38→@37) | Wrong byte offsets in DataView writes | Corrected to price@5, qty@13, salt@21, batchId@29, bump@37 |
| Phantom simulation reverted for frontend order/account actions on devnet (2026-07-02) | Web client derived PDA registry/batch addresses while deployed devnet registry/current batch/book/vault are keypair accounts; keeper also stranded users on batch #2 Revealing past deadline with one unrevealed commitment | Web now resolves configured registry and live `/api/batch/current` batch address; indexer serves live keypair batch/book routes with short RPC cache; keeper creates a fresh committing batch when a reveal window expires with zero reveals. Active devnet batch after recovery: #3 `BQgRjj7fuuuBkmn6RCgAFf3MVDEuLYpMRF5uYznHXUk4`, registry `F7zWN2XrVqNDBBYqsYpgxHa6AuPK1aQE33kHwM4f8ayV`, vault `3FZS8JUn8FGz1CUroGYwrBVHqotaUquJMNnSuBCQxheT`, book `5nfbjqTYpsnHnmCifdFpwLwajhyb8n6orVvbMbSrGT6w` |

**Remaining issues:**
- Keeper writes oracle price to `oracleKeypair.publicKey` (keypair address). Perps-core derives oracle PDA via `deriveOraclePda(oraclePid)` — different addresses. Perps-core won't see posted prices until addressed.
- CreatePortfolio (disc 18) now works via `invoke_signed(SystemProgram.createAccount)` with bump seed in `.rbump` BSS section. End-to-end test pending browser wallet flow.

**Usage after fix:**
```bash
# 1. Initialize protocol
CORE_PROGRAM_ID=CThnLgZvomva1HHQZVoZk4or9RDgyfCTrXXZqEMCR7JN RPC_URL=https://api.devnet.solana.com tsx apps/indexer/src/init-protocol.ts
# Save REGISTRY_ADDRESS from output

# 2. Run keeper (after setting REGISTRY_ADDRESS from step 1)
REGISTRY_ADDRESS=<addr> CORE_PROGRAM_ID=CThnLgZvomva1HHQZVoZk4or9RDgyfCTrXXZqEMCR7JN RPC_URL=https://api.devnet.solana.com tsx apps/indexer/src/keeper.ts
```

### BSS Section Fix (RESOLVED 2026-06-24)

After every `cargo build-sbf`, the mangled `.bss._ZN...` section must be converted from NOBITS to PROGBITS:
```bash
SN=$(llvm-readelf -S target/deploy/mgk_perps_core.so | grep BUMP_SEED | awk '{print $2}')
llvm-objcopy --remove-section=.bss --rename-section="$SN"=.rbump target/deploy/mgk_perps_core.so /tmp/perps-core-step1.so
llvm-objcopy --set-section-flags=.rbump=alloc,load,readonly,data /tmp/perps-core-step1.so /tmp/perps-core-final.so
solana program deploy --keypair ~/.config/solana/id.json --program-id CThnLgZvomva1HHQZVoZk4or9RDgyfCTrXXZqEMCR7JN /tmp/perps-core-final.so
```

**Root cause**: rustc 1.79 emits mangled section names for `static mut` that exceed the Solana toolchain's 16-byte ELF section-name limit. The bump seed must live in a section that is: (1) allocatable, (2) has bytes in the ELF file (PROGBITS, not NOBITS), (3) readonly. The `.rbump` section with `alloc,load,readonly,data` flags satisfies all three.

### Registry Initialize Bug (RESOLVED 2026-06-23)

**Symptom**: Fresh registry initialization produces `n_min=0` (expected 10), `t_max=4` (expected 50), `t_reveal=400` (expected 50), `base_deposit=42,949,672,960,000,000` (expected 10,000,000). Values shifted by one wire parameter.

**Root Cause**: Using struct field assignment (`registry_data.base_deposit = base_deposit`, etc.) caused incorrect BPF machine code generation. The BPF backend generated wrong memory accesses for fields at non-8-byte-aligned offsets. The `base_deposit` at offset 44 (44 % 8 = 4) was silently corrupted.

**Fix**: Write bytes directly at explicit offsets using `unsafe { *(dst.add(N) as *mut TYPE) = value; }`. Verified correct on-chain:
- `n_min=10`, `t_min=4`, `t_max=400`, `t_reveal=50`, `base_deposit=10,000,000`, `bump=0`

**Files changed**: `programs/perps-core/src/instructions/initialize.rs`

## Batch Create Bug + Instrument Init Bug (RESOLVED 2026-06-23)

Same BPF alignment pattern. Two more `initialize_in_place()` calls were corrupting data on BPF:

1. **`Batch.initialize_in_place()`** in `create_batch.rs` — corrupted registry `batch_id_counter` (became `42949672960000001` instead of 1) and batch's own `batch_id` field. Fix: direct byte-offset ptr writes.

2. **`Instrument.initialize_in_place()`** in `initialize.rs` — would have corrupted instrument fields on BPF (same root cause). Fix: direct byte-offset ptr writes matching Instrument struct layout (336 bytes).

**SDK `encodeCommitOrder` off-by-one** (RESOLVED 2026-06-23): All fields after `side` were shifted by 1 byte (price@6→@5, qty@14→@13, salt@22→@21, batchId@30→@29, bump@38→@37). Corrected to match Rust wire format.

## Devnet deployment status (2026-06-29 — fresh deploy after stale registry cleanup)

**Current deployment (2026-06-29, slot 472758111):**
| Program | ID | Size | Notes |
|---|---|---|---|
| `mgk-perps-core` | `3jYQ4mpWBBtwrzYQ4zzKhgqVcWWsG2HpXi9oXTBpekja` | ~111KB | Fresh deploy after closing CThnLgZ...; program_ids.rs updated; .bss removed via llvm-objcopy |
| `mgk-perps-matcher` | `AU4EKQAQupEbMWPK9fuJA7CZqfcjM5Bpgf6Ew9Y7o2FF` | ~128KB | |
| `percolator-oracle` | `6M9eEiDKy8imbDi44ZqquyfknNbveRjD4j9VnvYaHtmA` | ~25KB | |

- perps-core: Fresh deploy after cleanup. CThnLgZvomva1HHQZVoZk4or9RDgyfCTrXXZqEMCR7JN closed (stale registry accounts). CzWqtmcrm6sivjNHfNWhoMJfxP7ibm8KqXXjZpkswXy5 still active (176KB, pre-cleanup).
- matcher/oracle: unchanged
- **Cluster:** devnet (`https://api.devnet.solana.com`)
- **Deployer:** `ECmGsGAAPJimTwLk3SzkQ39pUQbaBj7U5qgSRRgYSFy`

### Prior deployment (2026-06-24 prior — OBSOLETE)

**Prior .so files (2026-06-16):**
| Program | ID | Size | SHA-256 |
|---|---|---|---|
| `mgk-perps-core` | `DBrCzAMAJhxnPRQnBzEZGMhSALGfvQDDe6xEn2nU1uar` | 99,768 B | `d642df415af46e16efce82146f9d2feceea161181f512b1d9b12ce46bb692eff` |
| `mgk-perps-matcher` | `AU4EKQAQupEbMWPK9fuJA7CZqfcjM5Bpgf6Ew9Y7o2FF` | 111,320 B | `1b26e8f9a2e8ca981392433124939b19b04f06897a63ad629532a918903a669e` |
| `percolator-oracle` | `6M9eEiDKy8imbDi44ZqquyfknNbveRjD4j9VnvYaHtmA` | 14,200 B | `cf0d07fa103027650bb0c8c20054d330d5803d1fbd6325f6dd45a4f19512efb0` |

**New .so files (2026-06-19, R4b re-fix):**
| Program | ID | Size | SHA-256 |
|---|---|---|---|
| `mgk-perps-core` | `DBrCzAMAJhxnPRQnBzEZGMhSALGfvQDDe6xEn2nU1uar` | 103,536 B | `3d35cd506577048ba20231bedaffefde537e34367ae48ea5800ad74686f9088d` |
| `mgk-perps-matcher` | `AU4EKQAQupEbMWPK9fuJA7CZqfcjM5Bpgf6Ew9Y7o2FF` | 80,040 B | `fafdaf8778e1bacf109f27959d098368731e6c2316efafc1cbdc839054f83559` |

- **Cluster:** devnet (`https://api.devnet.solana.com`)
- **Deployer:** `ECmGsGAAPJimTwLk3SzkQ39pUQbaBj7U5qgSRRgYSFy` (upgrade authority for all 3)
- **Build:** `cargo build-sbf` (platform-tools v1.43, Rust <1.87)
- **Pre-flight gates:** 322 Rust tests pass, clippy clean, 0 BPF stack overflow errors

### Matcher canonical ID change
The original canonical keypair (`target/deploy/mgk_perps_matcher-keypair.json`, pubkey `9o2vTBBhEp6CYxNsDPsX79Euhzh8TtoLTSHR5R3jXebZ`) was broken on devnet: 3 deploy txs finalized with `Status: Ok` but the program account never appeared on-chain. A fresh keypair deployed cleanly. The old keypair is backed up at `/tmp/matcher-keypair-BROKEN-ID.json`.

### Oracle status
The Rust oracle (`percolator-oracle`) is now deployed. It supports admin-pushed prices via `UpdatePrice` (disc 1) and `SetAuthority` (disc 2). No keeper bot running yet — initial price push required before the chart can render real prices. See `programs/oracle/src/entrypoint.rs` for the instruction set.
