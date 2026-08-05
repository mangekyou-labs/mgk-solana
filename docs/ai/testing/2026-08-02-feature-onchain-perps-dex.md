---
phase: testing
title: mgk On-Chain Perps DEX — DFBA Test Strategy
description: Test coverage for Dual Flow Batch Auction matching (replaces commit-reveal CLOB plan).
status: in-progress
date: 2026-08-02
requirements: docs/ai/requirements/2026-06-18-feature-onchain-perps-dex.md
design: docs/ai/design/feature-onchain-perps-dex.md
planning: docs/ai/planning/2026-08-02-feature-onchain-perps-dex.md
---

# mgk On-Chain Perps DEX — DFBA Test Strategy

## Context

v1 matching is **pure DFBA**: open posts, dual uniform-price auctions, dual mid mark, liquidation pause without dual clear. Commit-reveal, shuffle, and priority queues are **out of scope** for new tests (legacy CLOB tests may remain until removed).

Programs: `perps-core`, `perps-matcher`, `mgk-oracle`, `mgk-common`.

## Test inventory (2026-08-03)

| Crate | DFBA-focused | Notes |
|-------|--------------|--------|
| `mgk-perps-matcher` | **21+** in `state/dfba.rs` + book `is_maker` | Host `cargo test -p mgk-perps-matcher --lib` (~110 pass) |
| `mgk-perps-core` | batch/settle/liq gates, PostOrder | `cargo +stable test -p mgk-perps-core --lib --features host-hash` (~196 pass) |
| Legacy matcher CLOB/shuffle/queue | still present | Not the DFBA path |
| `lifecycle.rs` e2e | **DFBA dual + one-sided** | `SBF_OUT_DIR=target/deploy cargo +stable test -p mgk-perps-core --test lifecycle --features host-hash e2e_` |

## Commands

```sh
cargo test -p mgk-perps-matcher --lib
cargo check -p mgk-perps-core --lib
cd programs/perps-matcher && cargo build-sbf   # stack gate
```

## Scenarios (checklist)

### Matcher DFBA core

- [x] T-DFBA-LAYOUT — flat pack 56 B, region offsets
- [x] T-DFBA-CLEAR-ASK / BID — paper-style volume max
- [x] T-DFBA-NO-CROSS — empty match
- [x] T-DFBA-ALLOC / CONSERVE / DUST — pro-rata + round-down
- [x] T-DFBA-SELF-TRADE — same user no fill
- [x] T-DFBA-CAP — price priority select
- [x] T-DFBA-DUAL — both auctions + one-sided
- [x] T-BOOK-ROLE — `is_maker` on place_resting
- [x] T-LIFECYCLE-MARK — dual fill ⇒ mark_valid; one-sided ⇒ liq pause rule
- [x] T-SBF-STACK — `cargo build-sbf` no stack overflow on matcher

### Core lifecycle (unit / field simulation)

- [x] T-BATCH-DFBA-FIELDS — mark_valid, liq_paused defaults; dfba_mark_mid
- [x] T-CLOSE-TO-CLEARING — field write path Committing → Clearing
- [x] T-DFBA-DISC — matcher disc 5 / results header 34
- [ ] T-POST-ORDER-UNIT — PostOrder CPI layout (partial; needs AccountInfo harness)
- [ ] T-CLEAR-BATCH-IX — full process_clear_batch with mocks
- [ ] T-SETTLE-MARK — instrument.mark_price from dual mid

### E2E (BPF / program-test)

- [x] T-E2E-DFBA-FILL — PostOrder × dual makers+takers → close → DfbaClear → settle; mark_valid + fills + fees
- [ ] T-E2E-REST — unfilled rests next batch with role
- [x] T-E2E-LIQ-PAUSE — one-sided clear ⇒ mark_valid=0, liq_paused=1
- [ ] T-E2E-SELF — same wallet maker+taker does not self-fill (host unit covered)
- [ ] T-E2E-CANCEL — cancel resting between batches

### Superseded (do not add new coverage)

- CommitOrder / RevealOrder success paths
- Fisher-Yates fairness demos as product gates
- Pre-signed reveal relayer
- Freshness mark blend / toxic-taker scoring (deferred)

## Coverage targets

| Layer | Target |
|-------|--------|
| DFBA pure math | 100% of `dfba.rs` public API |
| Book role flag | place + persist |
| Clear/settle wire | disc + header constants pinned |
| E2E | ≥1 dual-fill path on devnet/program-test when env allows |
| SBF | matcher + core `cargo build-sbf` zero stack overflow |

## Evidence log

| Date | Command | Result |
|------|---------|--------|
| 2026-08-02 | `cargo test -p mgk-perps-matcher --lib` | **110 passed**, 1 ignored |
| 2026-08-02 | `cargo +stable test -p mgk-perps-core --lib --features host-hash` | **193+** then **196 passed** (2026-08-03) |
| 2026-08-03 | lifecycle `e2e_` with `SBF_OUT_DIR=target/deploy` | dual fill + one-sided liq pause **ok** |
| 2026-08-02 | `cargo build-sbf` matcher+core | clean (no stack errors) |

## Risks

- Core e2e needs `SBF_OUT_DIR`/`BPF_OUT_DIR` absolute path to `target/deploy` and `+stable` for host test binary.
- Batch size 160 + instrument layout — redeploy on devnet after init offset fix.
- Legacy commit-reveal e2e bodies still in file but early-return skipped; rewrite/delete later.
- Results accounts must be **matcher-owned**.

## Next testing work

1. Rewrite `programs/perps-core/tests/lifecycle.rs` for PostOrder + DfbaClear  
2. Mollusk/program-test harness if BPF_OUT_DIR available  
3. Remove or `#[ignore]` obsolete commit-reveal e2e once DFBA e2e lands  
