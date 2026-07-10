---
phase: deployment
title: Devnet Deploy M8.1 — 2026-06-20
description: Fresh perps-core program ID deployment + R4b BPF stack fixes pending commit
---

# Devnet Deploy M8.1 — 2026-06-20

## Programs Deployed

| Program | ID | SHA | Notes |
|---------|----|-----|-------|
| perps-core | `CzWqtmcrm6sivjNHfNWhoMJfxP7ibm8KqXXjZpkswXy5` | `33062bb64b...` | Fresh deploy; old ID closed |
| perps-matcher | `AU4EKQAQupEbMWPK9fuJA7CZqfcjM5Bpgf6Ew9Y7o2FF` | `989e8e5f2d...` | In-place upgrade |
| percolator-oracle | `6M9eEiDKy8imbDi44ZqquyfknNbveRjD4j9VnvYaHtmA` | `cf0d07fa10...` | In-place upgrade |

Old perps-core ID `DBrCzAMAJhxnPRQnBzEZGMhSALGfvQDDe6xEn2nU1uar` permanently closed — Solana prohibits recreation at same program ID.

## Build Artifacts

`programs/common/src/program_ids.rs` updated to return real deployed IDs. Test `assert each function returns non-zero Pubkey` passes.

## Known Issues

### R4b BPF Stack Overflow Fix — NOT Included in This Deploy ⚠️

The `.so` files deployed at `63fbe8c` are the **stripped but unfixed** binaries. The R4b BPF stack overflow fixes (6 files, `+358/-18` lines in `perps-matcher/`) are **uncommitted** and not included in the deployed binaries.

**Impact**: `cargo build-sbf` produces `.so` files that trigger `ELF error: Found writable section (.bss)` on deploy. The workaround (`llvm-objcopy --remove-section .bss --remove-section .bss.S`) was applied to produce the deployed binaries, but this strips the `.bss` sections entirely — meaning **the matcher program was deployed without its scratch buffers initialized correctly**.

The deployed matcher .so has ~103.5K of loaded program data. The perps-core .so was similarly stripped.

**Fix required**:
1. Commit the 6 uncommitted files in `programs/perps-matcher/` and `programs/perps-core/`
2. Rebuild: `cargo build-sbf && llvm-objcopy --remove-section .bss --remove-section .bss.S target/deploy/*.so`
3. Redeploy both programs

### `.bss` NOBITS Section Root Cause

`#[link_section = ".bss.S"]` on `static mut` scratch buffers in `programs/perps-matcher/src/instructions.rs`. LLVM BPF backend places zero-initialized statics in NOBITS sections. Solana BPF loader rejects writable sections.

Workaround strips the sections entirely. Source-level fix still needed.

## Protocol State on Devnet

Registry initialized? **Unknown** — no keeper has run `Initialize` + `AddInstrument` + opened first batch.

To create the first batch (required for any order placement):
```bash
# Keeper must run:
# 1. Initialize registry
# 2. AddInstrument SOL-PERP with params
# 3. Open first batch (Committing phase)
```

## Next Deploy

After committing R4b fixes → rebuild → redeploy → then proceed to M8.2 (Multi-venue oracle keeper).
