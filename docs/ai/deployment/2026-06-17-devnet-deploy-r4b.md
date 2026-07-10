# Devnet Deployment Report — 2026-06-17

## Overview

Second devnet deploy of the mgk perps DEX. **Includes M7 7.7 (liquidation safety stack) and M7 7.8 (PauseFlags)** for the first time; the 2026-06-16 deploy carried only 7.1/7.4/7.5/7.6. Also closes **M7.7.R-R4b** (BPF stack overflow), which had previously produced `.so` files that compiled with stack overflow warnings and could not be safely deployed.

| Program | ID | Size (B) | SHA-256 |
|---|---|---|---|
| `mgk-perps-core` | `DBrCzAMAJhxnPRQnBzEZGMhSALGfvQDDe6xEn2nU1uar` | 96,536 | `47af7abe51282d07bb12951deccfa7e0555f1da3eaa6a2d5497e28bcd095457b` |
| `mgk-perps-matcher` | `AU4EKQAQupEbMWPK9fuJA7CZqfcjM5Bpgf6Ew9Y7o2FF` | 75,104 | `732de82846ad419f44482ec01a8fcb5c3b50c2f6e8805e62d561cfaa09dae9a1` |
| `percolator-oracle` | `6M9eEiDKy8imbDi44ZqquyfknNbveRjD4j9VnvYaHtmA` | 14,200 | `cf0d07fa103027650bb0c8c20054d330d5803d1fbd6325f6dd45a4f19512efb0` |

## M7 Status

Shipped in this build (all of M7, plus M7.7.R-R4b):

- **7.1** Batch creation in `SettleBatch` (next-batch PDA created in place)
- **7.2** Deposit return (commitment deposit unlocked at settle)
- **7.3** Reveal deadline enforcement in `RevealOrder`
- **7.4** Funding rate accrual (depth-weighted premium from book mid vs oracle)
- **7.5** Mark price computation (stored on `Instrument`, not `Batch`)
- **7.6** Risk callback (per-user notional cap + post-hoc margin check)
- **7.7** Liquidation safety stack (iterative reduction, ADL stub, `Vault.adl_pending`)
- **7.8** PauseFlags (`SetPauseFlags` disc 14, four bits + reserved-mask, gate `CommitOrder`/`RevealOrder`/`Withdraw`/`LiquidateUser`/funding step)
- **M7.7.R-R4b** BPF stack overflow fix (BSS scratch; all 12 errors → 0)

## Pre-Flight Gates

| Check | Result |
|---|---|
| `cargo test --all-features` | 316 tests pass (1 ignored BPF-only) |
| `cargo clippy --all-targets --all-features -- -D warnings` | clean |
| `cargo build-sbf` | exit 0, all 3 .so files produced, **zero "exceeded max offset" errors** |
| New `.so` SHAs | differ from 2026-06-16 deploy — fresh build |

## M7.7.R-R4b: BPF stack overflow fix

**Symptom (pre-fix):** `cargo build-sbf` printed 12 "Function ... Stack offset of N exceeded max offset of 4096 by M bytes" warnings. The `.so` files were still produced (the linker doesn't exit non-zero on stack overflow), but they were unsafe to deploy: stack overflow at runtime is undefined behavior.

**Affected functions (12):**

| Function | Pre-fix frame | Post-fix frame |
|---|---|---|
| `perps-core::clear_batch::process_clear_batch` | 64,776 B | < 4 KB |
| `perps-matcher::instructions::process_compute_clearing` | 7,752 B | < 4 KB |
| `perps-matcher::instructions::process_cancel_resting` | 55,496 B | < 4 KB |
| `perps-matcher::instructions::process_cancel_all` | 55,448 B | < 4 KB |
| `perps-matcher::instructions::process_modify_resting` | 55,504 B | < 4 KB |
| `perps-matcher::instructions::process_clear_and_match` | 66,840 B | < 4 KB |
| `perps-matcher::state::book::BookState::new`/`Default` | 26,112 B | n/a (cfg-gated to non-sbf) |
| `perps-matcher::state::book::deserialize_book_state` | 28,280 B | n/a (cfg-gated to non-sbf) |
| `perps-matcher::state::clearing::compute_clearing_into` | 7,872 B | < 4 KB |
| `perps-matcher::state::clob::clob_match_with_risk` | 14,416 B | n/a (now `*_into` variant) |
| `perps-matcher::state::clob::clob_match_with_caps` | 14,432 B | n/a (now `*_into` variant) |
| `perps-matcher::state::clob::MatchResult::new`/`Default` | 7,168 B | n/a (cfg-gated to non-sbf) |

**Root cause:** `BookState` (~16 KB) and `MatchResult` (~7 KB) and `PartitionedOrders` (~4.6 KB) passed by value into instruction entry points. SBF v1 has a 4096-byte hard stack limit per function; the LLVM linker enforces this at `cargo build-sbf` time.

**Fix (minimal, 3 prongs):**

1. **Borrow instead of copy.** Added `book_state_from_bytes_mut(buf: &mut [u8]) -> &mut BookState` in `programs/perps-matcher/src/state/book.rs`. Entry points now borrow the `BookState` from the book account data buffer — no 16 KB copy to the stack.

2. **In-place result sinks.** Refactored `clob_match_with_risk`/`clob_match_with_caps`/`compute_clearing` to take `&mut MatchResult` / `&mut [FillReceipt; MAX_ORDERS]` as a parameter (new `*_into` variants). Old returning-by-value variants kept for host tests, cfg-gated to `#[cfg(not(target_os = "solana"))]`.

3. **BSS scratch for remaining large buffers.** Several buffers can't be borrowed (e.g. `cpi_data` in `process_clear_batch`, `orders`/`caps`/`queues`/`match_result` in `process_clear_and_match`) — for these we add a process-wide `static mut` BSS buffer (22 KB in matcher, 16 KB in core) and place the typed slices at 8-byte aligned offsets. Solana processes at most one instruction per program at a time, so concurrent access to the BSS is impossible. We `scratch_reset` (zero the whole thing) on each entry-point call so residual bytes from a prior failed call can't be observed as ghost input.

`BookState::new`/`Default` and `MatchResult::new`/`Default` are cfg-gated to `#[cfg(not(target_os = "solana"))]` so the BPF binary doesn't reference the stack-allocating constructors. `BookState::zeroed_in_place` and `MatchResult::zeroed_in_place` are the BPF-safe alternatives.

The `compute_clearing_into` `buys`/`sells`/`prices`/`eligible_buys`/`eligible_sells`/`per_order` scratch arrays are now passed in as `&mut` parameters from the caller's BSS scratch (not stack-allocated in the function). This eliminated the 7.8 KB frame on `compute_clearing_into`.

**Verification:**
- `cargo test --all-features`: 316 pass (1 ignored BPF-only).
- `cargo clippy --all-targets --all-features -- -D warnings`: clean.
- `cargo build-sbf`: exit 0; **0 "exceeded max offset" lines** (grep the full output to confirm — `Finished` does not mean success).
- New `.so` files produced; SHAs differ from prior deploys.

**Binary size delta:** perps-core went from 99,768 B → 96,536 B; perps-matcher went from 111,320 B → 75,104 B. The drop is the eliminated inlined stack copies.

## Remaining Work Before Public Use

- [ ] **Keeper bot** for oracle price pushes (admin must call `UpdatePrice` until Pyth is wired)
- [ ] **Pyth primary** — current oracle is admin-pushed fallback only
- [ ] **M7.7.R R2** matcher `process_cancel_all` entry-point tests (~1h, 5 cases, independent of BPF)
- [ ] **CU profiling** for new instructions (capped_risk_check, sweep_book_side, apply_funding_to_instrument, BSS-scratch zeroing)
- [ ] **E2E test** running against real BPF (currently gated on `BPF_OUT_DIR`)
- [ ] **Audit** before any real capital

## RPC

- Default: `https://api.devnet.solana.com` (public, rate-limited)
- Recommended: Helius free tier for production devnet use

## Wallet

- Deployer: `ECmGsGAAPJimTwLk3SzkQ39pUQbaBj7U5qgSRRgYSFy`
- Balance at deploy: (re-check at deploy time)
- All 3 programs have this wallet as upgrade authority
