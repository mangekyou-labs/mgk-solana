# T9.11 DFBA Public Devnet Release — Rollout Plan

**Date:** 2026-08-24
**Feature:** DFBA (Discrete-Frequency Batch Auction) public devnet release
**Upgraded Core Program:** `C7w2mKz2KQgDroNNhACm9MutXhPiesVr9Gn2x8TDsRYx`

## Summary

Release the completed DFBA work from `feature-dfba-auction` through a
reviewed, automatically merged PR into `origin/master`, then roll out the
exact merge commit to Render and Vercel.

This is a public devnet release; it does not deploy a new program ID or
target mainnet.

## Service Configuration

### mgk-indexer (Render Web Service)
- **Type:** Read-only sync/API (no embedded keeper or oracle)
- **Runtime:** Node 22, SQLite disk at `/var/data/mgk-indexer.db`
- **Health:** `/api/healthz`
- **Key env:** `CORE_PROGRAM_ID`, `MATCHER_PROGRAM_ID`, `REGISTRY_ADDRESS`, `BATCH_ADDRESS`, `BOOK_ADDRESS`, `DB_PATH=/var/data/mgk-indexer.db`

### mgk-keeper (Render Background Worker)
- **Type:** Batch lifecycle cranker (no HTTP server)
- **Runtime:** Node 22, `node ops-keeper.js --loop --interval 5000`
- **Key env:** `KEEPER_KEYPAIR` (Render secret file), `RPC_URL`, `BOOK_ADDRESS`
- **Auto-deploy:** Disabled (manual cutover)

### mgk-oracle (Render Background Worker)
- **Type:** Price oracle publisher (multi-venue quorum)
- **Runtime:** Node 22, `node ops-oracle.js --loop`
- **Key env:** `ORACLE_AUTHORITY_KEYPAIR` (Render secret file), `PRICE_ORACLE_ADDRESS=5NSDGAaRqfxe6mkZG9fEAZdzK4r77nEBEobohZGYP6PN`, `INSTRUMENT_ADDRESS=Hz9UtmSXyKFnp1pGvrhrAmizMsvEkYRh5Eih1r7Lf1hG`
- **Venues:** binance, okx, bybit (3-venue quorum)
- **Auto-deploy:** Disabled (manual cutover)

### mgk-frontend (Vercel)
- **Build:** `cd mgk-frontend && pnpm -F @mgk/sdk build && pnpm -F web build`
- **Node:** 22.x
- **Public env:** canonical program/account IDs, Render indexer URL
- **`NEXT_PUBLIC_BATCH_ADDRESS`:** unset (dynamic from indexer)

## Key Addresses

| Component | Address |
|-----------|---------|
| Core Program | `C7w2mKz2KQgDroNNhACm9MutXhPiesVr9Gn2x8TDsRYx` |
| Matcher Program | `7WiZuunbPGciCedsVTguvjezwwzrhmXG5HkdCuHizbNC` |
| Oracle Program | `CsSqVZMoXixNYstNhTtixeT4pyRgrYnXdpfoXQBgFPqZ` |
| PriceOracle | `5NSDGAaRqfxe6mkZG9fEAZdzK4r77nEBEobohZGYP6PN` |
| Instrument | `Hz9UtmSXyKFnp1pGvrhrAmizMsvEkYRh5Eih1r7Lf1hG` |
| Registry | `CbsfrRS2rYE2qgJbi7MM6mLzARUy8cDiYmHW2o12jYJA` |
| Vault | `9qe7TkRxDXHo3dywPKiiY1jwSBnFuSPHmGTWhcP8ttXE` |
| Book | `J33Y6yo6AZM6JKLEw89tN1kPmyEADqWWjGxb1aAW915j` |

## Deployment Steps

### Pre-merge (PR gates)
1. `npx ai-devkit@latest lint --feature feature-onchain-perps-dex`
2. `cargo +stable clippy --all-targets --all-features -- -D warnings`
3. `cargo +stable test --all-features`
4. `cargo build-sbf`
5. SDK build/tests, indexer build/tests, web tests/build
6. Git diff --check
7. Preview deployment to Vercel with temporary read-only Render indexer

### Post-merge rollout
1. Deploy read-only production indexer (stops old embedded writer)
2. Rotate oracle authority to dedicated oracle key; require fresh update within 30s
3. Start keeper worker; require successful batch transition
4. Deploy/promote exact merge commit to `mgk-frontend.vercel.app`
5. Verify `mgkprotocol.vercel.app`
6. Fast-forward local main worktree to `origin/master`
7. Remove temporary preview indexer after production acceptance

## Rollback

- **Indexer:** Redeploy previous commit; SQLite data persists on disk.
- **Keeper:** Suspend the worker (preserves single-writer invariant).
- **Oracle:** If rolling back oracle, rotate authority explicitly — never run two publishers concurrently.
- **Frontend:** Revert Vercel deployment independently.
- **Order:** Suspend faulty worker first; revert frontend/indexer independently; keep healthy oracle running.

## Acceptance Criteria

- [ ] Portfolio initialization via wallet-funded disc 19 succeeds
- [ ] Opposing maker/taker orders in same collecting batch produce fills
- [ ] Close, dual clear, settlement, fees, positions, mark_valid=1 verified
- [ ] prepare-close/reduce-only decreases position without reversal
- [ ] Oracle quorum/freshness within 30s/50bps
- [ ] Structured indexer health endpoint responds
- [ ] Worker logs contain no secrets
- [ ] Solana transaction signatures recorded
- [ ] Indexer restart preserves fills on persistent disk
