---
phase: implementation
title: DFBA matcher core (M9.0–M9.1 partial)
description: Host-side Dual Flow Batch Auction clearing library in mgk-perps-matcher
date: 2026-08-02
---

# DFBA matcher core — implementation notes

## Completed tasks

| Task | Status | Evidence |
|------|--------|----------|
| T9.0.1 Flat pack layout | Done | `FLAT_ORDER_BYTES=56`, region offsets, pack/unpack tests |
| T9.1.1 `compute_clearing` | Done | Bid/ask volume-max; paper-style vectors |
| T9.1.2 `compute_allocation` | Done | Pro-rata, dust round-down, conservation |
| T9.1.3 Self-trade | Done | Same-user cancel without fills |
| T9.1.4 Cap select | Done | `select_by_price_priority` |
| T9.1.5 DfbaClear disc 5 | Done | `process_dfba_clear`, wire format, dual results |
| T9.1.6 SBF stack | Done | `*_into` + heap scratch; `cargo build-sbf` clean |

## Files

- **Added:** `programs/perps-matcher/src/state/dfba.rs`
- **Updated:** `programs/perps-matcher/src/state/mod.rs`, `entrypoint.rs` (disc 5), `instructions.rs` (`process_dfba_clear`)

## Design decisions in code

1. **Flat record 56 bytes:** price i64 + size u64 + order_id u64 + full Pubkey.
2. **Clearing / allocation:** volume-max + pro-rata; paper tie-breaks; self-trade cancel.
3. **Ix wire:** disc 5; `marginal_size_cap(8) + num_orders(2) + orders×58` (`side, is_maker, price, qty, order_id, user`).
4. **Results:** bid/ask prices + matched qtys + fills (`user, order_id, qty, price, is_maker, auction`).
5. **BPF:** all large state via heap/`run_dual_dfba_into`; host wrappers use stack; `Default` for large structs host-only.
6. **Book apply** not in this ix yet (orders from instruction data; T9.2/T9.3 will wire book + core CPI).

## Verification

```text
cargo test -p mgk-perps-matcher
# 106 passed, 1 ignored

cd programs/perps-matcher && cargo build-sbf
# Finished release — no stack offset errors
```

## T9.2 (also shipped)

| Task | Status |
|------|--------|
| T9.2.1 `is_maker` on LimitOrder/RestingOrder | Done |
| T9.2.2 Core `PostOrder` disc 20 + matcher `PlaceResting` disc 6 | Done |
| T9.2.3 Commit/Reveal retired (return InvalidInstruction) | Done |

### PostOrder wire
- Core disc **20**: `side(1) is_maker(1) price(8) qty(8) instrument_id(2) reduce_only(1)`
- Accounts: portfolio, user, batch (must `Committing`), registry, book, matcher
- CPI matcher disc **6** PlaceResting

## T9.3 (shipped)

| Piece | Behavior |
|-------|----------|
| CloseCommitting | Committing → **Clearing** (no reveal) |
| ClearBatch | CPI matcher disc **5** with `num_orders=0` (collect book); write bid/ask/mid/`mark_valid`/`liq_paused` |
| SettleBatch | DFBA results format + dual mid → `instrument.mark_price`; carry-forward if !mark_valid |
| LiquidateUser | Requires Settled batch with `mark_valid` / !`liq_paused` (+ instrument marks) |
| Batch layout | + bid/ask clear, matched qtys, mark_valid, liq_paused |

## T9.6 (shipped)

| Package | Changes |
|---------|---------|
| `@mgk/sdk` | `PostOrder` disc 20, `MATCHER_INSTRUCTION`, `encodeDfbaClear`, `encodePlaceResting`, `BATCH_SIZE=160`, DFBA batch fields, `decodeDfbaResultsHeader` |
| indexer keeper | Close → Clearing; ClearBatch DFBA book-collect; settle with 0 commitments |

```text
cd mgk-frontend/packages/sdk && pnpm test   # 158 passed
cargo +stable test -p mgk-perps-core --lib test_batch_size_matches_sdk  # size 160
```

### Done (2026-08-03 follow-on)
- **T9.4** funding soft-skip when `!mark_valid` (and existing `funding_paused`)
- **T9.4.1** LiquidateUser: batch account + `mark_valid` / `liq_paused` gate
- **Instrument init** fee offsets fixed to `#[repr(C)]` (taker@52, maker@54, … mark@136)
- **Frontend** trade UI → `usePostOrder` / `encodePostOrder` (maker toggle; commit-reveal retired)
- **BPF e2e** dual fill + fees; one-sided liq pause  
- **PostOrder** increments `batch.total_commitments` (n_min close)

```text
SBF_OUT_DIR=target/deploy cargo +stable test -p mgk-perps-core --test lifecycle \
  --features host-hash e2e_
# test_e2e_full_lifecycle_with_fill … ok
# test_e2e_dfba_one_sided_liq_paused … ok
```
