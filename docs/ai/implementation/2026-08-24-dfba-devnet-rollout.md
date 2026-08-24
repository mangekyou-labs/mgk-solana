# T9.11 DFBA Devnet Rollout — Implementation Changes

**Date:** 2026-08-24

## Code Changes Summary

### 1. Indexer Read-Only Conversion
- **Removed** embedded `startKeeper()` call from `mgk-frontend/apps/indexer/src/main.ts`
- **Removed** keeper-related variables (KEEPER_POLL_MS, ORACLE_POLL_MS, ORACLE_PID)
- **Removed** portfolio queue import and `drainPortfolioQueue` references
- Indexer is now a pure read-only sync/API service
- Preserves all REST endpoints: `/api/healthz`, `/api/markets`, `/api/trades`, `/api/book`, `/api/batch`, `/api/portfolio/address`

### 2. Portfolio Creation — Wallet-Funded Discriminator 19
- **Removed** `POST /api/portfolio/request-creation` endpoint from `portfolio.ts`
- **Removed** `getPortfolioQueue` import and queue-size endpoint
- **Updated** `useAccountActions.ts` to directly send `InitPortfolioForUser` (disc 19) from the connected wallet
- Wallet signs as fee-payer and user; PDA created via `invoke_signed` in the same tx
- On-chain validation: `requested_portfolio_user == signer` (prevents creating other users' portfolios)

### 3. InitPortfolioForUser On-Chain Hardening
- Added `user == signer` validation when 2-account (wallet-funded) path
- Preserves 3-account (keeper-signed) path for backward compatibility
- Entry: `programs/perps-core/src/instructions/init_portfolio_for_user.rs`

### 4. Standalone Keeper Worker
- Created `tools/ops-keeper.js` — hardened standalone batch lifecycle cranker
- Features:
  - `KEEPER_KEYPAIR_FILE` env for Render secret file mounting
  - Dynamic settlement portfolio discovery (replaces hardcoded persona addresses)
  - Liquidation candidate discovery via filtered core-program account scans
  - `PORTFOLIO_ADDRESSES` as optional override only
  - Fail-closed after `MAX_CONSECUTIVE_ERRORS` (default: 5)
  - Deadline-gated close/clear/settle behavior

### 5. Standalone Oracle Worker
- Created `tools/ops-oracle.js` — multi-venue quorum price oracle
- Features:
  - `ORACLE_AUTHORITY_KEYPAIR_FILE` env for Render secret file mounting
  - 3-venue quorum (binance, okx, bybit) with configurable venues
  - Freshness check (default: 30s max staleness)
  - Deviation check (default: 50bps max between venues)
  - Local fallback to `~/.config/solana/mgk-oracle-keypair.json`

### 6. Render Blueprint
- Created root `render.yaml` with 3 services:
  - `mgk-indexer` (web, Node 22, SQLite disk)
  - `mgk-keeper` (worker, auto-deploy disabled)
  - `mgk-oracle` (worker, auto-deploy disabled)

### 7. Vercel Configuration
- Consolidated at repo root `vercel.json`
- Pinned Node 22.x
- Set canonical program/account IDs as public env vars
- `NEXT_PUBLIC_BATCH_ADDRESS` unset (dynamic)

### 8. Updated .gitignore
- Added exclusions for `.env.*`, `*.db`, `.playwright-mcp/`, `.playwright-cli/`, `.freebuff/`, `.agents/skills/playwright-skill/`, `*.png`, `brand.md`
- Added `render.yaml` to JSON exceptions

### 9. Runtime Defaults
- All services use canonical program/account IDs:
  - Core: `C7w2mKz2KQgDroNNhACm9MutXhPiesVr9Gn2x8TDsRYx`
  - Matcher: `7WiZuunbPGciCedsVTguvjezwwzrhmXG5HkdCuHizbNC`
  - Oracle: `CsSqVZMoXixNYstNhTtixeT4pyRgrYnXdpfoXQBgFPqZ`
  - PriceOracle: `5NSDGAaRqfxe6mkZG9fEAZdzK4r77nEBEobohZGYP6PN`
  - Instrument: `Hz9UtmSXyKFnp1pGvrhrAmizMsvEkYRh5Eih1r7Lf1hG`
- Batch address remains dynamic (derived from keeper state)
