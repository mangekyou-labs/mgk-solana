# AGENTS.md

## Build & verify

```sh
cargo test --all-features                              # CI test command
cargo clippy --all-targets --all-features -- -D warnings   # CI lint (warnings = errors)
cargo build-sbf                                         # Build all 4 on-chain programs for BPF (also: make build-bpf)
cargo build --lib --all                                 # Native lib build (also: make build)
```

**Order:** Run `cargo clippy` then `cargo test`. Clippy warnings are hard errors in CI.

## What's where

| Directory | Role | Key fact |
|---|---|---|
| `programs/oracle/` | Fallback price oracle (M1) | BPF target, `no_std`, Pinocchio |
| `programs/common/` | Shared account validation, errors, math | `no_std`, dev-only proptest |
| `programs/perps-core/` | Perps core (M3-M5 + M6 6g-6k) | BPF target, `no_std`, Pinocchio |
| `programs/perps-matcher/` | CLOB matching engine (M6 6a-6f) | BPF target, `no_std`, Pinocchio |

## Architecture conventions

### Pinocchio, not Anchor
There is no IDL, no Anchor macros, no `anchor-spl`. Programs use raw `process_instruction` entrypoints with `pinocchio::entrypoint!()`.

### Two-layer instruction pattern (every program)
1. `entrypoint.rs` — raw byte deserialization, account validation (using `percolator-common` helpers), then delegates
2. `instructions/*.rs` — pure business logic on already-validated types

Account validation helpers live in `programs/common/src/`: `validate_owner`, `validate_writable`, `validate_signer`, `borrow_account_data`, `borrow_account_data_mut`.

### Single-byte instruction discriminators
Instruction dispatch uses `instruction_data[0]` as a u8 discriminator — **not** Anchor's 8-byte SHA256 digest. Add new instructions by appending to the match in `entrypoint.rs`.

### Hardcoded program IDs
- Matcher: `PERPMatcher111111111111111111111111111` (placeholder, see `programs/common/src/program_ids.rs`)
- Oracle: declared in `programs/oracle/src/lib.rs`
- Perps core: `PRPSCore11111111111111111111111111111111` (placeholder)

### no_std
All programs use `no_std`. Programs use `#[cfg_attr(target_os = "solana", no_std)]` so they can compile for both BPF and native test.

## Testing

Tests are inline in `#[cfg(test)] mod tests` blocks within instruction/state source files. Run per-crate:

```sh
cargo test -p mgk-perps-matcher      # 59 tests
cargo test -p mgk-perps-core         # 19 tests
cargo test -p percolator-oracle      # 5 tests
cargo test -p percolator-common      # 42 tests
```

## SBF build quirks

- `.cargo/config.toml` sets `sbpf-linker` as the BPF linker.
- `sbf-solana-solana.json` is a custom LLVM target spec for Solana BPF.
- `Cargo.lock` is checked in despite `.gitignore` — intentional for reproducible builds.

## Error codes

Shared `PercolatorError` enum in `programs/common/src/error.rs` with ranges:
- 0–99: common

Errors are cast to `u64` via `From<PercolatorError> for u64` and returned by entrypoints.
