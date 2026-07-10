---
name: r4b-uncommitted-protocol-state
description: R4b BPF stack overflow fixes uncommitted on feature-mgk-frontend — blocks M8.2+ deploys
metadata:
  type: project
---

## R4b BPF Stack Fix — Uncommitted State (2026-06-20)

**Why**: M7.6/M7.7 BPF stack overflow fixes were re-applied 2026-06-19 but NOT included in 63fbe8c deploy commit. The 63fbe8c deploy used stripped-but-unfixed binaries.

**Files uncommitted** (6 files, `+358/-18` lines):
- `programs/perps-matcher/src/state/clearing.rs` — `#[cfg(not(target_os = "solana"))]` on `compute_clearing`; `pub(crate)` scratch types; `compute_clearing_into` BPF-safe variant
- `programs/perps-matcher/src/state/clob.rs` — BPF stack-safe `into` variants
- `programs/perps-matcher/src/state/book.rs` — `BookState::zeroed_in_place()` BPF-safe in-place zero
- `programs/perps-matcher/src/state/queue.rs` — `#[cfg(not(target_os = "solana"))]` guards
- `programs/perps-core/src/instructions/clear_batch.rs` — M7.7.6 cap-wiring + `#[cfg]` guards
- `programs/perps-matcher/src/instructions.rs` — BPF-safe entry point variants

**Why it matters**: Every future `cargo build-sbf` will produce .so files that fail `solana program deploy` without the `llvm-objcopy --remove-section .bss --remove-section .bss.S` workaround. The workaround itself is unsafe (strips scratch buffers). M8.2+ cannot proceed until these are committed and a fixed .so is built and deployed.

**Fix**: Commit the 6 files → rebuild → redeploy.

**How to apply**: After committing, rebuild with:
```bash
cargo build-sbf && llvm-objcopy --remove-section .bss --remove-section .bss.S target/deploy/*.so
```
