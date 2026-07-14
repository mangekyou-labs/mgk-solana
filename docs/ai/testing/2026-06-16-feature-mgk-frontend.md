---
phase: testing
title: mgk Frontend - Testing Strategy
description: Test coverage, verification commands, manual devnet evidence, and remaining E2E gaps for the mgk frontend subsystem
---

# mgk Frontend - Testing Strategy

## Coverage Goals

- Unit tests cover all new helper logic, state stores, SDK encoders/decoders, error mapping, and UI state branches.
- Integration tests cover indexer REST/WS routes, SQLite persistence, backfill behavior, and live route fallbacks.
- Playwright covers trade-page layout, key UI states, chart load, status bar, history tabs, and browser-console cleanliness.
- Devnet manual smoke covers wallet connection, portfolio/deposit flows, live batch state, and order lifecycle until a full wallet E2E is stable.

## Current Verified Commands

Run from `mgk-frontend/` unless noted.

```sh
pnpm -F web test -- --run lib/trade/batchDisplay.test.ts lib/config.test.ts lib/stores/useBatchStore.test.ts lib/hooks/useOrderSubmission.test.ts
pnpm -F web typecheck
pnpm -F indexer typecheck
pnpm -F indexer test -- --run src/integration.test.ts
```

AI-doc lint from repo root:

```sh
npx ai-devkit@latest lint
npx ai-devkit@latest lint --feature mgk-frontend
```

Status on 2026-07-03:

- Base AI docs lint: pass.
- `mgk-frontend` feature lint: pass.
- Focused OpenOrders/BottomTabs tests: pass.
- Web typecheck: pass.
- Browser-wallet commit/reveal: manually verified through Playwright + Phantom.
- Matched settlement/Positions: blocked by matcher `ClearAndMatch` access violation.
- `onchain-perps-dex` feature lint: fails because per-feature planning/testing/deployment/monitoring files are missing; `docs/ai/planning/README.md` and `docs/ai/testing/feature-mgk-onchain-perps-dex.md` remain the de-facto docs until v1.1 cleanup.

## Unit Test Scenarios

| Module | Scenario | Status |
|---|---|---|
| `lib/config.test.ts` | Devnet defaults plus env/config overrides for core, matcher, registry, vault, book, batch, indexer, and RPC | Passing |
| `lib/stores/useBatchStore.test.ts` | Registry read, active batch id = `batchIdCounter - 1`, configured/indexer batch resolution, missing account behavior, polling lifecycle | Passing |
| `lib/hooks/useOrderSubmission.test.ts` | Error-code decoding and severity routing for commit/reveal failures | Passing |
| `lib/trade/batchDisplay.test.ts` | Phase labels/tones, countdown formatting, and `accepting orders` display for Committing past deadline but below `n_min` | Passing |
| `components/trade/OpenOrders.test.tsx` | OpenOrders reads configured keypair book before PDA fallback and reports count changes | Passing |
| `components/trade/BottomTabs.test.tsx` | Positions/Open Orders tab counts render dynamically without hardcoded `Open Orders(0)` | Passing |

## Indexer Integration Scenarios

| Scenario | Status |
|---|---|
| Health, markets, candles, trades, book, batch, fills, portfolio routes register and return expected shapes | Passing in `src/integration.test.ts` |
| `/api/batch/current` supports store fallback when live RPC config is absent | Passing |
| Live devnet run returns RPC-backed batch JSON with `batchAddress`, `batchId`, `phase`, counters, and registry metadata | Manually verified |
| `/api/batch/current` caches live RPC response for 5 seconds to reduce QuickNode/devnet rate-limit pressure | Typechecked; manual route behavior verified after restart |

## Manual Devnet Verification - 2026-07-02

Environment:

- RPC: `https://dark-misty-wildflower.solana-devnet.quiknode.pro/...`
- Web: `http://localhost:3000/trade?rpc=quicknode`
- Indexer/keeper: `http://127.0.0.1:4000`
- Registry: `F7zWN2XrVqNDBBYqsYpgxHa6AuPK1aQE33kHwM4f8ayV`
- Vault: `3FZS8JUn8FGz1CUroGYwrBVHqotaUquJMNnSuBCQxheT`
- Book: `5nfbjqTYpsnHnmCifdFpwLwajhyb8n6orVvbMbSrGT6w`
- Current recovered batch: `BQgRjj7fuuuBkmn6RCgAFf3MVDEuLYpMRF5uYznHXUk4`

Manual checks:

- Playwright loaded `/trade?rpc=quicknode` with 0 console errors after final server restart.
- Page displayed `Batch: Committing` and `accepting orders`.
- Browser wallet deposit path confirmed earlier with tx `4tg1nqy9shhBcvvgHxhVTtmr7i2a2Df3ek1eAfyFCCZ2yu5uE99o8ZnPHpuzPXCGYpRZVbRWFEy2VdFrVG6PRHbE`.
- Keeper recovered stranded batch #2 by opening batch #3 after reveal deadline expired with zero revealed orders.
- `/api/batch/current` returned the keypair batch address rather than a stale PDA.

## Manual Devnet Verification - 2026-07-03

Environment:

- RPC: QuickNode devnet endpoint supplied by the user.
- Web: `http://localhost:3000/trade`
- Indexer/keeper: local Fastify/keeper process.
- Registry: `F7zWN2XrVqNDBBYqsYpgxHa6AuPK1aQE33kHwM4f8ayV`
- Book: `5nfbjqTYpsnHnmCifdFpwLwajhyb8n6orVvbMbSrGT6w`
- Batch #14: `H6TYpwVtVy4JMjFLFpVAyifHf2RfpcnvopvUii1mzAsM`

Manual checks:

- Playwright submitted a Phantom sell order and confirmed both wallet popups: CommitOrder then RevealOrder.
- No duplicate reveal popup appeared after the frontend transaction-flow patch.
- After reveal, the UI showed `BATCH: REVEALING`; free collateral changed from `0.3300` to `0.3200`.
- A headless counterparty wallet (`ECmGsGAAPJimTwLk3SzkQ39pUQbaBj7U5qgSRRgYSFy`) submitted and revealed the opposite buy side in the same batch.
- Batch #14 reached `totalCommitments=2` and `totalRevealed=2`.
- Open Orders live UI showed `Open Orders(2)` with one long row and one short row after the configured-book fix.
- Positions stayed at `0` because keeper `ClearBatch` failed inside matcher `ClearAndMatch` with the scratch access violation.

Counterparty txs:

- Deposit: `3hwFNYyZDvCAYw29zAStqwptDJpkJ9Y6umK9cb1VPE9Pj2f49AANGngxtkbZrNu4s1CrMHoKTTPTdjvEB749PtoU`
- CommitOrder: `2JacWtBascQCfsPLdeMgW5G8rcBXDJ9PnGuL3eGqQKaSTLoKigiWfYbi7he1YqrWg8NJp6qqyEvoc86Yc3Xmx3Rz`
- RevealOrder: `5yV7LoqW5nJURcqqk5kfQrj5nk9MFVNrdqnm8V1A84ND3UFdQ8Vpaxn2jeTMB91fJeAYvfLFjYcYgsfHdD17n1ez`

Focused verification:

```sh
pnpm -F web test -- --run components/trade/OpenOrders.test.tsx components/trade/BottomTabs.test.tsx
pnpm -F web typecheck
```

Diagnostic protocol checks:

```sh
cargo test -p mgk-perps-matcher
cargo build-sbf
```

The protocol checks passed during the `.data.S` scratch experiment, but the experiment did not ship: `solana program deploy` rejected the ELF because read-write data sections are unsupported.

## End-to-End Status

| Flow | Status | Notes |
|---|---|---|
| Trade page layout smoke | Passing | Existing Playwright suite covers layout/chart/status/order-form surfaces. |
| Wallet connect + deposit | Partially verified | Browser path confirmed deposit tx on devnet. |
| Browser-wallet full tx flow: deposit -> commit -> reveal -> keeper -> verify order/fill | In progress / blocked at matched settlement | Phantom CommitOrder and RevealOrder are verified. Open Orders displays. Fills/Positions remain blocked by matcher `ClearAndMatch` access violation. |
| CLI/keeper first resting order | Verified | First devnet resting order and settlement were proven 2026-07-01/02 through CLI/keeper path. |

## Regression Risks To Test Next

1. Re-run Phantom commit/reveal after matcher multi-order clearing is redeployed, then verify Positions/Fills.
2. Keeper settles a two-order matched batch exactly once and does not double-clear or overwrite `resultsAddress`.
3. Zero-reveal recovery creates exactly one fresh committing batch and does not loop-create batches.
4. Multiple mounted batch-polling consumers do not create multiple polling intervals.
5. QuickNode/Helius RPC fallback behavior when one endpoint returns 429.
6. Book route uses configured keypair book and still falls back to PDA on a canonical deployment.
7. OpenOrders remains correct after migration from keypair book to canonical book PDA.

## Manual Test Checklist Before v0.1.0-devnet

- Start indexer with registry/vault/book env overrides and QuickNode RPC.
- Start web app with matching `NEXT_PUBLIC_*` config.
- Connect Phantom and Solflare if available.
- Confirm status bar shows `Online`, `Devnet`, and a usable batch state.
- Set up account if portfolio is missing; wait for keeper-created portfolio.
- Deposit 0.1 SOL; confirm wallet, toast, portfolio free collateral, and vault balance.
- Submit a small limit order; confirm Phantom/Solflare simulation succeeds and tx lands.
- Wait for keeper close/reveal phase, reveal order, then wait for clear/settle.
- Verify order book/open orders/trade history reflect the result.
- Reload page and confirm no stale localStorage state from the prior wallet/batch.

## Manual Devnet Verification - 2026-07-14 Production Stability

Environment:

- Frontend: https://mgk-frontend-ri46evt8s-gadillacers-projects.vercel.app (preview)
- Indexer: https://mgk-indexer.onrender.com
- RPC: Helius devnet (`https://devnet.helius-rpc.com/?api-key=...`)
- Registry: `F7zWN2XrVqNDBBYqsYpgxHa6AuPK1aQE33kHwM4f8ayV`

Manual checks:

- `/api/batch/current` returns RPC-backed batch JSON with `batchAddress`, `batchId`, `phase` (confirmed `source: "rpc"`)
- `/api/healthz` returns `{ ok: true }`
- Build output contains `indexerUrl:"https://mgk-indexer.onrender.com"` (Turbopack env var inlining confirmed)
- `.vercelignore` scoped `programs/` to repo root (SDK `src/programs/` no longer excluded)
- Batch #107 stuck in Committing (deadline passed 1.6M slots ago) — keeper needs `KEEPER_KEYPAIR` env var on Render to sign `CloseCommitting`

Verified commands:

```sh
pnpm -F web test -- --run  # 436/436 pass
pnpm -F web typecheck       # clean
pnpm -F @mgk/sdk build      # clean
pnpm -F indexer build        # clean
```

## Known Testing Gaps

- No automated wallet-extension E2E yet. Playwright can load the app and inspect console/UI, but approving Phantom/Solflare still requires either extension automation or manual signing.
- No local-validator fixture that reproduces keypair-owned registry/batch/book accounts.
- No protocol-level test for zero-reveal batch recovery; current fix is keeper-side operational recovery.
- `onchain-perps-dex` testing inventory is stale relative to the current 322 Rust test count.
- Indexer `/api/markets/0/state` returns 404 when no fills are indexed (market_state table empty).
- Vercel production deploy via `vercel promote` broken (repo root has no `next`); workaround is `vercel deploy --prod` from `mgk-frontend/`.
