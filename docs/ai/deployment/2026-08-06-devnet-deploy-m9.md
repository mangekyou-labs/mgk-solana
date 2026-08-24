---
phase: deployment
title: Devnet Deploy M9 — 2026-08-06
description: DFBA migration deployment — all M9 programs on devnet with new program IDs
---

# Devnet Deploy M9 — 2026-08-06

## Programs Deployed

| Program | ID | Size (B) | SHA-256 (first 16) |
|---------|-----|----------|---------------------|
| `mgk_perps_core` | `C7w2mKz2KQgDroNNhACm9MutXhPiesVr9Gn2x8TDsRYx` | 119,976 | `e887f30f4725976a...` |
| `mgk_perps_matcher` | `7WiZuunbPGciCedsVTguvjezwwzrhmXG5HkdCuHizbNC` | 111,536 | `f44b63863ee902d1...` |
| `mgk_oracle` | `CsSqVZMoXixNYstNhTtixeT4pyRgrYnXdpfoXQBgFPqZ` | 13,192 | `d663f580567c0934...` |

**Deployer:** `ECmGsGAAPJimTwLk3SzkQ39pUQbaBj7U5qgSRRgYSFy`
**Network:** devnet (`https://api.devnet.solana.com`)
**Solana CLI:** 3.1.13
**Deploy cost:** ~1 SOL (52.67 → 51.66 SOL)

## Deploy Signatures

| Program | Signature |
|---------|-----------|
| Oracle | `2XAF3LXKzJRs2aCJC6qEcgUhcrJ6m5Jrmeq4Ston7GbdyrQZJB37iwuZv7HXM1raFbre7fTxWfQjTVERF4CfyLCa` |
| Matcher | `5w9M7om8jm4GznX8tvbmdrF1uPNH54QXV4GoFx3XeiEyAtDbshmPGmGPyZtpvHtWCAeskY9xczceEs7P4pZRmPdd` |
| Core | `4tY8NCdGHSYNCbH2NajCFqn6HP7JyQrwADr6UntEfPFcb6z4HXXtZ2H3dFSS8qxhqwHhU4ch6CBK79tf2eD7p1Th` |

## Pre-Flight Gates

| Check | Result |
|---|---|
| `cargo build-sbf` | ✅ clean (0 stack overflow warnings) |
| `cargo +stable clippy --all-targets --all-features -- -D warnings` | ✅ clean |
| `cargo +stable test -p mgk-perps-core --lib --features host-hash` | ✅ 200 passed |
| `cargo test -p mgk-perps-matcher --lib` | ✅ 114 passed |
| `cargo test -p mgk-common` | ✅ 45 passed |
| `cargo +stable check -p mgk-perps-core --test lifecycle` | ✅ compiles |

## M9 Features in This Deploy

All M9 DFBA features are included:

- **DFBA dual auction** — dual uniform-price clears (bid: maker-buy × taker-sell; ask: maker-sell × taker-buy)
- **PostOrder** (disc 20) — single-tx open post with `is_maker` flag
- **Batch lifecycle** — Collecting → CloseCollecting → Clearing → ClearBatch (DfbaClear) → SettleBatch
- **SetBatchParams** (disc 21) — governance: `max_orders_per_batch`, `marginal_size_cap`, `t_min/t_max_slots`, `n_min`
- **Pause matrix** — 6 bits: TRADING, WITHDRAWALS, LIQUIDATIONS, FUNDING, POST, CLEAR
- **Pure DFBA mark** — dual mid when both auctions clear; no oracle blend
- **Oracle freshness** — funding skips when oracle stale (>600s) or inactive
- **Liquidation gates** — requires Settled batch with `mark_valid` / `!liq_paused`
- **DFBA error codes** — `DfbaCapExceeded=603`, `MarkInvalidForLiquidation=604`, `BatchNotSettled=605`
- **Self-trade prevention** — same-user orders excluded from fills
- **Resting orders** — unfilled orders persist across batches with role preserved

## Code Changes

- `program_ids.rs` — updated from placeholder to real devnet addresses
- `lifecycle.rs` — CORE_ID and MATCHER_ID constants updated

## Post-Deploy Setup ✅ Complete

Protocol initialized on devnet via `tools/init-protocol.js`:

| Step | TX | Status |
|------|-----|--------|
| Initialize (disc 0) | `55GmuoJY...` | ✅ Registry + Instrument PDAs created via `invoke_signed` |
| SetBatchParams (disc 21) | `mDXCmBQ9...` | ✅ max_orders=64, marginal_cap=64, t_min=2, t_max=150, n_min=1 |
| CreateBatch 0 (disc 16) | `4SVbtVgJ...` | ✅ Batch 0 PDA created, collecting window open |

**Protocol State:**
- Registry: `CbsfrRS2rYE2qgJbi7MM6mLzARUy8cDiYmHW2o12jYJA`
- Instrument (SOL-PERP): `Hz9UtmSXyKFnp1pGvrhrAmizMsvEkYRh5Eih1r7Lf1hG`
- Vault: `9qe7TkRxDXHo3dywPKiiY1jwSBnFuSPHmGTWhcP8ttXE`
- Batch 0: `D6khMvcetfD9WKGob3WBNycvfKQoNEz2dp3LpnNLRxrt` (Collecting)

**Traders can now PostOrder (disc 20).** Keeper should crank CloseCollecting → ClearBatch → SettleBatch.

## Keypair Files

```
target/deploy/mgk_perps_core-keypair.json
target/deploy/mgk_perps_matcher-keypair.json
target/deploy/percolator_oracle-keypair.json
```

**⚠️ Keep these keypairs secure.** They control program upgrades.

## Post-Deploy Fix (2026-08-06 evening)

### Root causes of first keeper failure

| Error | Cause | Fix |
|-------|-------|-----|
| `IllegalOwner` on DfbaClear | Book account never created; CPI `CreateAccount` capped at 10KB, book is 27 704 B | Client-side keypair book via top-level `SystemProgram.createAccount`; path `~/.config/solana/mgk-book-keypair.json` |
| Vault missing | Init skipped vault when registry already existed; `VAULT_SPACE` was 58 (actual 80) | Fixed `VAULT_SPACE=80`; re-run Initialize creates vault |
| Settle `InvalidAccountOwner` (0x2) | Next batch PDA not pre-allocated; settle required core-owned empty account | SettleBatch creates next batch PDA via `invoke_signed` when empty |
| Registry counter stuck | SBF field assignment bug on `batch_id_counter` | Raw pointer write at offset 36 in `settle_batch.rs` |

### Redeploy signatures (fix)

| Program | Signature |
|---------|-----------|
| Core (settle PDA + counter fix) | `5XtkugdJXREDFiVFuCHNTGhDg26WdepWLv6r5hZovbyDd8CSfje649KactFd1H32NWH33bEpzQ4dZZGjUZ7rW9ce` |
| Matcher (InitializeBook disc 7) | `5bYDS5uuEbY7Qxs2zgGMDJPsZYcS2fWATvox3y1YtyzzgKy1f4cgXCkqy79YwNRRe3ykrB3V8VRusduHgvSgZwtK` |

### Verified on-chain state (after 2 full cranks)

| Account | Address | Status |
|---------|---------|--------|
| Registry | `CbsfrRS2rYE2qgJbi7MM6mLzARUy8cDiYmHW2o12jYJA` | `batch_id_counter=2` |
| Vault | `9qe7TkRxDXHo3dywPKiiY1jwSBnFuSPHmGTWhcP8ttXE` | 80 B, core-owned |
| Book (keypair) | `J33Y6yo6AZM6JKLEw89tN1kPmyEADqWWjGxb1aAW915j` | 27 704 B, matcher-owned |
| Batch 0 | `D6khMvcetfD9WKGob3WBNycvfKQoNEz2dp3LpnNLRxrt` | Settled (status=3) |
| Batch 1 | `J7TBZMTCBbjEuBS9ASzgk9BVzLgx3LMoaEPycrFZiStp` | Settled (status=3) |
| Batch 2 | `5mm4r6WyvTL3NzLnNKSBxhcN16XYxS4CQaS6XNLAthyy` | Collecting (status=0) |

### CU note (devnet empty book)

ClearBatch + DfbaClear on empty book consumed **~2.6k CU** (well under 200k). The BPF e2e CU exhaustion in `program-test 2.1` is a **test harness** issue (`ComputeBudgetInstruction` not applied to the meter), not a production blocker for empty/thin books.

### Ops commands

```bash
cd tools
node init-protocol.js          # idempotent: vault + book + params + batch0
node keeper-crank.js           # Close → Clear → Settle (creates next batch PDA)
node keeper-crank.js --loop    # continuous
node trade-e2e.js              # dual PostOrder fill + mark_valid settle
```

Book address is loaded from `~/.config/solana/mgk-book-keypair.json` (or `BOOK_ADDRESS` / `BOOK_KEYPAIR` env).

### Dual-fill e2e (2026-08-06) ✅

`tools/trade-e2e.js` ran successfully on batch 2:

| Step | Result |
|------|--------|
| InitPortfolioForUser ×2 | maker + taker PDAs |
| Deposit 0.1 SOL each | vault credited |
| 4× PostOrder | maker-buy, taker-sell, maker-sell, taker-buy @ 100000 qty 10 |
| ClearBatch | `markValid=1` bid=ask=100000 mBid=mAsk=10 mid=100000 |
| SettleBatch | status=Settled, portfolios updated, batch 3 Collecting |

**Note:** `InitPortfolioForUser` CPI requires System Program in the account metas (program resolves `1111…` only when listed).

## Next Steps

1. ~~Initialize registry on devnet~~ ✅
2. ~~Run first batch lifecycle end-to-end~~ ✅
3. ~~PostOrder dual-side fill + mark_valid~~ ✅ (`trade-e2e.js`)
4. Monitor CU at cap 64 with deeper books
5. Security review before mainnet
6. Optional: multi-step PDA book init (disc 7) to replace keypair book
7. ~~Frontend: wire `BOOK_ADDRESS` + M9 program IDs~~ ✅ (config + PostOrder path; portfolio deposit UX polish remains)
8. Frontend: end-to-end wallet PostOrder in browser against batch 3