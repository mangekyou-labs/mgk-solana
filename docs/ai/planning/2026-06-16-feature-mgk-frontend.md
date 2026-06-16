---
phase: planning
title: mgk Frontend — Project Planning & Task Breakdown
description: Subsystem of mgk protocol. 6-milestone build of Next.js 15 SPA + standalone indexer; each milestone is 1–2 days and shippable
---

# mgk Frontend — Project Planning & Task Breakdown

> **Subsystem of mgk protocol.** This plan covers a frontend subsystem that depends on the on-chain mgk protocol (`programs/*`). The protocol must be deployed to devnet before any milestone exit criteria can be exercised. When `/check-implementation` runs in this repo, the reference is the on-chain mgk protocol — see `docs/ai/design/feature-onchain-perps-dex.md` and the matching requirements / planning / testing docs.
>
> **Visual reference:** the UI mirrors Bulk.Trade's dense dark perps layout (chart / order book / order form 3-column + bottom tabbed panel + status bar), with a "Sharingan red on black" brand palette in place of Bulk's gold. See `docs/ai/design/2026-06-16-feature-mgk-frontend.md` → **Reference UI & Visual Identity** for the full token table, layout grid, and component breakdown.

## Milestones

- [ ] **M1 — Foundation**: pnpm monorepo at `mgk-frontend/`, `mgk-frontend/apps/web` (Next.js 15), `mgk-frontend/apps/indexer` (Fastify + SQLite), `mgk-frontend/packages/sdk` skeleton, wallet adapter wired, "Hello wallet" trade page on devnet.
- [ ] **M2 — Read state**: portfolio PDA fetch + display, batch timeline with phase indicator, order book from matcher Book PDA, recent-trades panel (UI only). Encoders for all 13 core instructions + Cancel/Modify.
- [ ] **M3 — Order placement (commit-reveal)**: order panel, salt + hash generation client-side, CommitOrder tx → localStorage persistence → auto RevealOrder tx. Friendly error mapping.
- [ ] **M4 — Indexer**: Node 22 + Fastify + better-sqlite3, program-logs subscriber, FillReceipt decoder, candle bucketing (1m/5m/1h), REST API, WebSocket fan-out.
- [ ] **M5 — Chart**: Lightweight Charts integration, Pyth Hermes backfill (200 candles), mgk trade markers from indexer WS, timeframe switcher.
- [ ] **M6 — Polish & E2E**: Playwright happy-path test on devnet, Lighthouse pass, landing page, error-toast polish, dev-only Crank/Liquidate buttons, docs.

**Total estimate: 8–12 working days** (single engineer, devnet pace, no audit).

## Task Breakdown

### M1 — Foundation

- [x] **T1.1** (M) Init pnpm workspace at `mgk-frontend/`: `pnpm-workspace.yaml` with `apps/*` and `packages/*`, root `package.json` with shared scripts (`dev`, `build`, `lint`, `test`). _Done 2026-06-16. Pinned `packageManager: pnpm@9.15.0` per plan; PATH has pnpm 8.15.9 — works for the no-op `pnpm install` verification. Add `corepack enable && corepack prepare pnpm@9.15.0 --activate` as a docs step before T2 work for the team. `.gitignore` patched at repo root: added `!package.json`, `!**/package.json`, `!**/tsconfig*.json`, `!pnpm-workspace.yaml` so the existing `*.json` rule (Solana key protection) doesn't swallow the new manifests. **Structural decision:** placed the frontend under `mgk-frontend/` (sibling of `programs/`, `docs/`) instead of at the Rust repo root, so it can be `git subtree split` into its own repo later. Planning + design + requirements docs updated to use the `mgk-frontend/` path prefix._
- [x] **T1.2** (M) Scaffold `mgk-frontend/apps/web` with `create-next-app@latest` (TS strict, App Router, Tailwind, ESLint, no `src/`). Pin Next 15, React 19, Tailwind v4. _Done 2026-06-16. **Version drift:** `create-next-app@latest` shipped Next **16.2.9** (the plan targeted Next 15; Next 16 is the new stable). React 19.2.4 ✓, Tailwind 4 ✓, TS 5 ✓, ESLint 9 ✓. `--turbopack` flag no longer needed (default). Pre-creating the `apps/` parent was required — create-next-app refuses relative paths whose parent doesn't exist ("application path is not writable"). Build: `pnpm -F web build` clean in 1.4s. Removed a stale 4-line `pnpm-lock.yaml` at the Rust repo root (left over from the pre-move install) — Next 16 was warning about it as a second workspace root._
- [x] **T1.3** (M) Scaffold `mgk-frontend/apps/indexer` with `pnpm init`, install `fastify`, `better-sqlite3`, `ws`, `pino`, `@solana/web3.js`, `@mgk/sdk` (workspace). _Done 2026-06-16. ESM (`type: "module"`), `tsx watch` for dev, `tsc` for build, `vitest` for tests. Deps installed: fastify ^5.0, better-sqlite3 ^11.5 (native build OK after `python3 -m pip install --user --break-system-packages setuptools` — Python 3.14 ships without `distutils` and PEP 668 blocks the system install; document for the team), pino ^9.5, ws ^8.18, @solana/web3.js ^1.95. tsconfig is strict + `noUncheckedIndexedAccess` + `noImplicitOverride`. `main.ts` boots Fastify, registers `healthRoutes`, listens on :4000, graceful shutdown on SIGINT/SIGTERM. `GET /api/healthz → { ok: true, ts }` returns 200 in ~5ms. **`@mgk/sdk` workspace dep intentionally deferred to T1.4** (package doesn't exist yet; T1.4 will create it and add the dep to `apps/indexer/package.json` in the same change)._
- [x] **T1.4** (M) Init `mgk-frontend/packages/sdk`: `package.json`, `tsconfig.json`, Vitest. Implement `instruction.ts` (mirroring `programs/common/src/instruction.rs` `read_u8`, `read_u16`, `read_u32`, `read_u64`, `read_i64`, `read_u128`, `read_bytes`, `read_side`). _Done 2026-06-16. Workspace package `@mgk/sdk` v0.0.1 (ESM, strict TS, NodeNext, declarations emitted). 21/21 Vitest tests pass in 3ms covering all 8 read functions + `InstructionReader` cursor + bounds checking + bigint i64/u64/u128. **Drift from plan:** (a) u64/u128/i64 return `bigint`, not `number` (only lossless option for 64-bit+); (b) `readBytes` takes a runtime `length: number` arg instead of a TS const generic, because TS const generics are type-only and can't be used as runtime values (Rust's `const N: usize` can; the TS version sacrifices compile-time length guarantees for runtime simplicity). `DataView.getBigUint64(0, true)` + manual `(hi << 64n) + lo` shift is the only way to read 16 bytes as u128 in JS — no `getBigUint128` exists. `@mgk/sdk` workspace dep added to `apps/indexer/package.json`; smoke-tested: importing from indexer resolves and `readU8` returns the expected value. `dist/` emits `index.js` + `index.d.ts` + sourcemaps._
- [x] **T1.5** (S) Implement SDK `pda.ts`: `derivePortfolioPda`, `deriveBatchPda`, `deriveCommitmentPda`, `deriveBookPda`, `deriveInstrumentPda`, `deriveRegistryPda`, `deriveVaultPda`. Unit-test against a known seed → pubkey vector. _Done 2026-06-16. 7 derive functions + `SEEDS` const + 17 Vitest tests (seed constants, 7 known vectors, determinism, sensitivity). Vectors generated by `scripts/gen-pda-vectors.mjs` using the devnet program IDs (`DBrCzAMAJhxnPRQnBzEZGMhSALGfvQDDe6xEn2nU1uar` core / `9o2vTBBhEp6CYxNsDPsX79Euhzh8TtoLTSHR5R3jXebZ` matcher) and a fixed test user. **Drift from plan + design doc:** commitment seed is `b"commitment"`, not `b"commit"` as the design doc showed. Confirmed against `programs/perps-core/src/pda.rs:8`. SDK parameter is named `salt: bigint` (frontend commit-reveal terminology) which maps to the Rust's `nonce: u64` in PDA seeds — functionally identical. Used `Buffer.from(s, 'utf-8')` instead of `TextEncoder` because `lib: ["ES2022"]` doesn't include DOM types; added `@types/node` as a SDK devDep. SDK total: **38/38 tests pass, 19 exports, build clean**._
- [x] **T1.6** (M) Implement SDK `state.ts` decoders for Portfolio, Batch, Commitment (BPF layout table from design). Unit-test with a Buffer fixture per type. _Done 2026-06-16. Three decoders + nested `decodeRevealedOrder` + `decodePosition` helpers. **Massive drift from plan + design doc:** actual BPF structs are Portfolio 1456 bytes (not the doc's 50-ish), Batch 120 bytes (not 53), Commitment 164 bytes (not 81). Design doc's "discriminator at offset 0" is wrong — Pinocchio programs enforce discriminator at the instruction level, not the account level. Real Portfolio has 13 fields: user, equity, principal, pnl, im, mm, free_collateral, health, positions_len, positions[32], last_funding_checkpoint[32], last_batch_id, last_slot, bump. 13/13 round-trip tests pass via test-only encoder helpers (`__test-helpers.ts`). i128 reads use `view.getBigUint64(lo) + (view.getBigInt64(hi) << 64n)` because there's no `getBigUint128`. SDK now exports `state` namespace with 15 symbols. Typecheck + build clean. **Memory note `43238482-…` saved with the full Portfolio BPF layout for future reference.**_
- [x] **T1.7** (M) Implement SDK `programs/core.ts` encoder for the 5 most-used instructions: InitPortfolio, Deposit, Withdraw, CommitOrder, RevealOrder. Discriminator table lives here. _Done 2026-06-16. `CORE_INSTRUCTION` const (13 entries, mirrors Rust `CoreInstruction` enum in `programs/perps-core/src/instructions/mod.rs:29-44`) + 5 encoders. Buffer sizes verified against Rust: InitPortfolio=1B, Deposit=9B (disc + u64 LE), Withdraw=9B, CommitOrder=39B (disc + 9 fields incl. commitment_bump), RevealOrder=38B (disc + 8 fields, no commitment_bump). 16 tests cover discriminator byte at offset 0, field byte placement, reduceOnly bool→u8 encoding, negative i64 prices, full-u64 qty/salt (no precision loss), and round-trip through the T1.4 `InstructionReader`. SDK now exports `programs` namespace with 6 symbols. Typecheck + build clean. **Drift to flag in T3.4:** the plan's `commitment_hash = sha256([1+2+1+1+8+8+8+8].concat())` (37 bytes) is wrong; the Rust's `compute_commitment_hash` actually hashes 69 bytes — order fields (37B) + user pubkey (32B) + batch_id (8B). Will fix in T3.4._
- [x] **T1.8** (M) Add `@solana/wallet-adapter-react` + `@solana/wallet-adapter-wallets` (Phantom, Solflare, Backpack). Wrap `mgk-frontend/apps/web` in `<ConnectionProvider endpoint={devnet}>` + `<WalletProvider>` + `<WalletModalProvider>`. _Done 2026-06-16. Installed `@solana/wallet-adapter-react@0.15.39` (latest, has `react: '*'` peer dep so React 19 works), `@solana/wallet-adapter-phantom`, `@solana/wallet-adapter-solflare`, `@solana/wallet-adapter-react-ui`, plus `@solana/web3.js@^1.98.0` (required peer; web app didn't have it). **Drift from plan:** did NOT use the umbrella `@solana/wallet-adapter-wallets` (it pulls in WalletConnect → viem → abitype → zod@^3 conflict, plus bs58 version conflict). Used individual wallet adapter packages instead. **Drift from plan:** Backpack is **deprecated on npm** (`Package no longer supported` warning). Skipped Backpack for now; only Phantom + Solflare wired. Will revisit when Backpack's new package is identified. **Workspace-level pnpm overrides** added to handle transitive conflicts: `bs58: ^5.0.0` and `zod: ^3.23.0`. `SolanaProvider` is a Client Component (`'use client'`) with `ConnectionProvider` (env `NEXT_PUBLIC_RPC_URL` or `clusterApiUrl('devnet')`) + `WalletProvider` (autoConnect) + `WalletModalProvider` (imports its CSS). Wrapped into the root layout. `pnpm -F web build` clean; dev server boots in 241ms; `GET /` returns 200._
- [ ] **T1.9** (S) Build `WalletButton` and `useAutoConnect` hook.
- [ ] **T1.10** (S) Build minimal `app/trade/page.tsx`: header + wallet button + "Hello {shortPubkey}" placeholder. Verify it loads on devnet.
- [ ] **T1.11** (M) Set up the visual system from the design doc: Tailwind v4 config + CSS variables for the full token table (Surfaces / Text / Semaphores / Status), Inter + JetBrains Mono via `next/font`, `ThemeProvider` with the dark-only v1 mode but token-API-ready for a future light mode.
- [ ] **T1.12** (S) Build the `Logo` component (mangekyo SVG + 'mgk' wordmark, inline SVG, monochrome red) and the `Pill` / `StatusDot` / `NumberDisplay` / `PnlDisplay` common primitives that the rest of the app composes from.
- [ ] **T1.13** (S) Build `Header` (logo + Trade/Portfolio nav + `Get devnet SOL` CTA pill + WalletButton) and `PageFrame` (max-width container, dark surface, scroll containment). Header height 44px per design.

**M1 exit criteria:** `pnpm dev` boots web on :3000 and indexer on :4000; connecting Phantom on devnet shows the pubkey; the trade page renders the dark Sharingan palette with the mgk logo, header, and the four common primitives. `pnpm -F @mgk/sdk test` is green.

### M2 — Read state

- [ ] **T2.1** (S) Add env vars: `NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_CORE_PROGRAM_ID`, `NEXT_PUBLIC_MATCHER_PROGRAM_ID`, `NEXT_PUBLIC_ORACLE_PROGRAM_ID`, `NEXT_PUBLIC_INDEXER_URL`. Hardcode devnet defaults in `.env.local.example`.
- [ ] **T2.2** (M) Implement `usePortfolioStore` (Zustand) with a 3s polling loop calling `getMultipleAccountsInfo([portfolioPda])` and decoding via SDK.
- [ ] **T2.3** (M) Build `Balances` + `Positions` components: free collateral, locked collateral, per-position size / entry / unrealized PnL / liq price (computed from MMR).
- [ ] **T2.4** (M) Implement `useBatchStore` polling the latest Batch PDA. Derive current batch id from Registry, then fetch that Batch PDA.
- [ ] **T2.5** (M) Build `BatchTimeline` component: phase pill (Committing / Revealing / Clearing / Settled), countdown to `commit_deadline_slot`, "Crank" button when past deadline (gated behind `?devtools=1`).
- [ ] **T2.6** (M) Implement `useBookTopN(instrumentId, depth=20)` polling matcher Book PDA. Build `OrderBook` component (bids descending, asks ascending, depth bars, size totals).
- [ ] **T2.7** (M) Build `RecentTrades` panel (UI shell only — wired in M4).
- [ ] **T2.8** (S) Finish SDK `programs/core.ts`: add CancelRestingOrder, ModifyRestingOrder, CloseCommitting, ClearBatch, SettleBatch, LiquidateUser, AddInstrument encoders. Discriminator table complete.
- [ ] **T2.9** (S) SDK `error.ts`: `PercolatorError` enum mirror + `humanizeError(code: number | bigint): string` map for ranges 0–99 / 200–299 / 400–499 / 600–699.
- [ ] **T2.10** (M) Build `MarketHeader` (market selector, last price + change, stats row: Last Price / Oracle / 24h Volume / Open Interest / **Batch phase + countdown**) and `TickerBar` (BTC/ETH/SOL price strip — Pyth-sourced, non-clickable in v1, used for context). The "Funding/Countdown" slot from the Bulk reference is repurposed for the batch phase + countdown in mgk (per design decision: mgk has batch auctions, not continuous funding).
- [ ] **T2.11** (M) Build `OrderBook` with the Bulk-style depth bars and the `B%/S%` imbalance bar at the bottom. `DepthRow` is a presentational component (price / size / sum / depth-bar background). The imbalance bar is a separate `OrderBookImbalance` component fed by aggregate bid/ask size.
- [ ] **T2.12** (M) Build `BottomTabs` (8-tab strip: Positions, OpenOrders, Balances, Order History, Trade History, Funding History, Position History, Account History) and the `Current Market` filter checkbox on the right of the strip. Empty states per tab (e.g., "You have no positions yet.").
- [ ] **T2.13** (S) Build `StatusBar` (24px, sticky bottom): connection dot (●/○), `[Devnet]` pill (orange), `Batch: Committing ▰▰▰▰▱▱▱ 00:24:40`, and wallet state (Connected `0xAbc…` / Not Connected).

**M2 exit criteria:** With a wallet that has a portfolio on devnet, the trade page shows the full Bulk-style layout: header + ticker + market header + 3-column (chart placeholder / order book with depth bars + imbalance / order-form placeholder) + bottom tabs + status bar. SDK unit tests cover all 13 encoders.

### M3 — Order placement (commit-reveal)

- [ ] **T3.1** (M) Build `OrderForm` component per design doc: locked `Cross` / `Limit` tab row, side-aware price input (USD, scaled 1e6 internally), qty input (lot multiples) with USD unit dropdown, 5-tick size slider, Reduce Only + TP/SL checkboxes, big two-button `Buy / Long` (green) + `Sell / Short` (Sharingan red) primary action, and the right-rail summary (Current Position, Liq. Price, Order Value, Margin Required, Fees) + `AccountActions` footer (Claim SOL + Transfer).
- [ ] **T3.2** (M) Implement `useOrderFormStore` (Zustand) with persisted-to-localStorage fields `{ instrumentId, side, price, qty, reduceOnly, batchId, salt, hash, status }`. Status: `idle | committing | awaiting_reveal | revealing | done | failed | slashed`.
- [ ] **T3.3** (M) Implement `useCommitOrder()` hook: on submit, derive `salt = randomBigInt()`, `hash = sha256(orderType || instrumentId || reduceOnly || side || price || qty || salt || batchId)`, derive `commitmentPda`, build & send CommitOrder tx, persist state, then auto-fire RevealOrder.
- [ ] **T3.4** (S) Compute `commitment_hash` exactly as Rust does: `sha256([u8; 1+2+1+1+8+8+8+8].concat())` with little-endian ints. Cross-check with a unit test using a known vector.
- [ ] **T3.5** (M) `useRevealOrder()` hook: read persisted state, build RevealOrder tx, on confirm clear localStorage entry, on program error mark `failed`/`slashed` and surface via toast.
- [ ] **T3.6** (M) Build `TxToast` component: shows program errors decoded, signature, explorer link, retry button for retryable errors.
- [ ] **T3.7** (M) Build `OpenOrders` panel: list of user's resting orders (from `useOpenOrdersStore`, populated by scanning book entries with `owner == user`). Per-row Cancel + Modify-qty buttons.
- [ ] **T3.8** (S) E2E happy path test (Vitest + mock wallet): salt → hash matches; commit → reveal sequence; persistence across simulated refresh.

**M3 exit criteria:** From the trade page, a connected devnet wallet can place a limit order, see it in OpenOrders, cancel it, and modify its qty. No raw program errors in the UI.

### M4 — Indexer

- [ ] **T4.1** (M) Init `mgk-frontend/apps/indexer`: TypeScript, tsx, Fastify 5, pino, better-sqlite3, ws. Boot script `pnpm -F indexer dev` → :4000.
- [ ] **T4.2** (M) Implement `store.ts`: `better-sqlite3` schema from design doc, prepared statements for fills, candles, batch_events, market_state.
- [ ] **T4.3** (L) Implement `subscriber.ts`: `connection.onLogs(coreProgramId, ...)` and `onProgramAccountChange(matcherProgramId, ...)`. On each log, fetch the tx, decode instructions, pull FillReceipts and Batch transitions, write to SQLite.
- [ ] **T4.4** (M) Implement `decoder.ts`: FillReceipt + Batch + Commitment decoders (reuse SDK `state.ts`).
- [ ] **T4.5** (M) Implement `aggregator.ts`: on each new fill, recompute the current 1m/5m/1h candle for that instrument; update `market_state` (last_price, mark, OI, funding).
- [ ] **T4.6** (M) REST routes: `GET /api/markets`, `GET /api/markets/:id/candles`, `GET /api/markets/:id/trades`, `GET /api/markets/:id/book`, `GET /api/batch/current`, `GET /api/healthz`. Use Fastify schema validation.
- [ ] **T4.7** (M) WebSocket route at `/ws`: client sends `{ type: 'subscribe', instrumentId }`; server responds with snapshot then streams `fill` / `batch` / `mark` messages.
- [ ] **T4.8** (S) Backfill on boot: `getBlocks` last 1000 slots, replay any txs touching mgk programs, populate SQLite.
- [ ] **T4.9** (S) Add Vitest integration test: simulate a fill, verify candle aggregation, verify REST round-trip.

**M4 exit criteria:** Indexer runs on devnet, captures real mgk trades, REST and WS work end-to-end, `curl localhost:4000/api/healthz` returns `{ ok: true, lastSlot, lag: <2 }`.

### M5 — Chart

- [ ] **T5.1** (M) Install `lightweight-charts` v5, wrap in `<PriceChart instrumentId={...}/>`. Use `next/dynamic({ ssr: false })` to avoid SSR hydration issues.
- [ ] **T5.2** (M) `usePythCandles(instrumentId, resolution)`: on mount, GET `https://hermes.pyth.network/v2/price-feed-history?ids=...&resolution=...` (Pyth SOL/USD feed ID). Push into chart series.
- [ ] **T5.3** (M) Subscribe to indexer WS for live price line updates and trade markers.
- [ ] **T5.4** (M) Render mgk trade markers as up/down triangles on the candle series using the `setMarkers` API.
- [ ] **T5.5** (M) Timeframe switcher: 1m / 5m / 15m / 1h / 4h. Re-fetch candles on switch, re-bucket mgk trades locally.
- [ ] **T5.6** (S) Crosshair tooltip, OHLCV legend, volume histogram at the bottom of the chart.
- [ ] **T5.7** (S) Fallback: if Hermes is unreachable, show last cached candles + an orange "live price unavailable" badge.
- [ ] **T5.8** (M) Build `ChartToolbar`: timeframe tabs (1m / 5m / 15m / 1H / 4H / 1D, with 5m default), Indicators button (Lightweight Charts built-in series only in v1), Mark/Oracle toggle, and `Chart | Market Info` view-mode tabs (Depth tab deferred to post-v1 per design).
- [ ] **T5.9** (S) Apply the Sharingan palette to the chart: dark canvas (`--color-bg`), green/red candles (`--color-bull`/`--color-bear`), red crosshair, no grid by default (or `var(--color-border)` for the grid). Crosshair tooltip matches the Bulk style (price row + OHLCV + mgk trade marker count).

**M5 exit criteria:** Trade page loads with 200 historical SOL/USD candles, shows a near-live price line that updates every 2–5s, renders mgk trade markers as the indexer feeds them, and the chart matches the Bulk visual style (no drawing tools in v1 — deferred).

### M6 — Polish & E2E

- [ ] **T6.1** (M) Install Playwright; write `e2e/trade.spec.ts`: connect wallet (using `@solana/wallet-adapter-mock` or a saved test wallet), deposit 0.1 SOL via devnet airdrop, place a limit order, advance batch, see fill on chart, withdraw. Assert no console errors.
- [ ] **T6.2** (S) Run Playwright in CI on every PR; record a video per run.
- [ ] **T6.3** (M) Add minimal landing page: hero, "Launch App" CTA, small "how it works" section. Pure static, no auth.
- [ ] **T6.4** (M) Loading skeletons for every async panel; empty states for empty book / no positions / no open orders.
- [ ] **T6.5** (S) Friendly error mapping pass: walk the 60+ PercolatorError codes, write a one-liner for each.
- [ ] **T6.6** (S) Lighthouse pass: target ≥ 80 perf, ≥ 90 a11y on the trade page. Fix flagged issues (image dims, color contrast, CLS).
- [ ] **T6.7** (S) Dev-only Crank and Liquidate buttons (gated by `?devtools=1` + env allowlist). Hidden in production builds.
- [ ] **T6.8** (S) `README.md` at repo root: how to run, env vars, devnet deployment links, architecture diagram.
- [ ] **T6.9** (S) Tag `v0.1.0-devnet` and push a tagged preview deploy to Vercel.
- [ ] **T6.10** (M) Visual polish pass per the Bulk reference: tab/hover/focus states on every interactive element, subtle red-tomoe decorations on the empty states, the orange `Get devnet SOL` CTA is the only warm-color element on the page. Compare side-by-side to the reference screenshot.

**M6 exit criteria:** Playwright E2E green; Lighthouse ≥ 80; landing page live; tagged preview deployed; side-by-side visual diff with the Bulk reference is "close enough that a trader would not feel a downgrade."

## Dependencies

### Task → task (within the build)

- T1.4 → T1.5 → T1.6 (must build SDK types before PDA + state)
- T1.6 → T2.2, T2.4, T2.6 (decoders needed for read stores)
- T1.7 → T3.3, T3.5 (encoders needed for commit/reveal)
- T2.4 → T2.5 (batch timeline needs batch store)
- M2 read paths → M3 forms (UI must show state before forms are useful)
- M4 indexer → M5 chart (chart consumes indexer WS)
- M5 chart is a hard dependency of T6.1 (E2E test asserts chart shows fills)

### External (blockers)

- **Devnet program deployment** of mgk-perps-core, mgk-perps-matcher, percolator-oracle with their canonical IDs (`DBrCzAMAJhxnPRQnBzEZGMhSALGfvQDDe6xEn2nU1uar`, `9o2vTBBhEp6CYxNsDPsX79Euhzh8TtoLTSHR5R3jXebZ`) and the program_ids.rs placeholders updated to match. **Blocks M1 exit** (no Txs land without deployed programs).
- **Pyth SOL/USD devnet feed availability**. If devnet lacks the feed, the chart falls back to on-chain `percolator-oracle` (acceptable, but the demo is less pretty). **Blocks M5 partial**.
- **Helius free RPC key** (or fallback to public devnet RPC). **Blocks M2 polling** if rate-limited.

### People / knowledge

- The on-chain programs are stable (M6 6a–6k complete). If a program change is needed mid-build, SDK + indexer + UI must all update in the same PR.
- We need the devnet Registry's `governance` pubkey to test `AddInstrument` and the devnet `admin` pubkey for the fallback oracle.

## Timeline & Estimates

| Milestone | Estimate | Notes |
|---|---|---|
| M1 — Foundation | 1.5 days | Scaffolding + SDK skeleton + wallet adapter |
| M2 — Read state | 1.5 days | Polling + decoders + order book |
| M3 — Order placement | 2 days | Commit-reveal orchestration + localStorage + E2E happy path |
| M4 — Indexer | 2 days | Subscriber is the most code; WebSocket fan-out is fiddly |
| M5 — Chart | 1 day | Lightweight Charts is well-documented; most of the work is wiring |
| M6 — Polish & E2E | 1.5 days | Playwright + Lighthouse + landing + error mapping |
| **Total** | **~9.5 working days** | Single engineer, devnet, no audit |

Buffer: +20% (1.5 days) for unknown unknowns (RPC rate limits, Hermes downtime, browser quirks).

## Risks & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **BPF layout mismatch** (host vs on-chain struct alignment — i128 = 8 vs 16) corrupts all decoders | M | Critical | Write decoders by hand from the design-doc offset table; add a fixture test that decodes a known Buffer and asserts every field. If it fails, do not ship. |
| **Pyth Hermes devnet unavailable** | M | M | Fall back to on-chain `percolator-oracle` admin-pushed price for live line; candles still come from the indexer once mgk trades exist. |
| **Devnet RPC rate-limit** | M | M | Use `getMultipleAccountsInfo` for all polls; cache market list 30s; consider Helius free tier key. |
| **Indexer lag** causes chart to miss recent fills | M | M | Show "synced as of slot N" badge; user can re-sync. Indexer also has a "backfill last 50 slots" button. |
| **Wallet adapter React 19 incompat** | L | M | Pin to known-good versions; fall back to manually wiring `wallet-adapter-react` if `wallet-adapter-wallets` lags. |
| **Commit-reveal race**: user closes tab between commit and reveal | M | M | LocalStorage persistence; on app load, check for `awaiting_reveal` entries and prompt user. |
| **Single-byte discriminator drift** (Rust renumbers, TS doesn't follow) | L | Critical | CI test: round-trip a known instruction Buffer → discriminator byte. Mirror the discriminator table in tests, not just code. |
| **Slot clock skew** for the batch countdown | M | L | Use `connection.getSlot()` server-side, not `Date.now()`. UI shows slot-based countdown. |
| **Public devnet RPC slowness** spikes p95 submit time | H | M | Add a "fast" toggle that points to Helius free; default to public. |
| **Indexer's `logsSubscribe` drops on transient disconnects** | M | M | Reconnect with exponential backoff; backfill last 50 slots on reconnect. |
| **Visual parity drift** — the Bulk.Trade reference is the de facto style; we ship a v1 that looks "close enough" but loses detail (no drawing tools, no depth chart, two locked tabs instead of six) | H | M | Document every visual parity gap in the design doc (Drawing tools, Depth view, Market/Limit/Pro tabs all explicitly deferred). T6.10 visual polish pass closes the remaining gap. Post-v1.1 milestone absorbs the deferred items. |
| **Brand red doubles as sell red** — could confuse color-blind traders who rely on the color signal | M | M | Every red is paired with `▼` / `−`; every green with `▲` / `+`. Status uses `●`/`○` shape on top of color. Lighthouse a11y audit verifies color is not the only signal. |
| **Red on black contrast** may fail WCAG AA on small text in some sub-tokens | M | M | Use `#e5e5e5` text on `#0a0a0a` (16:1 contrast) for body; reserve brand red for large/interactive elements only. Lighthouse a11y + a hand-rolled contrast check in CI gates the palette. |

## Resources Needed

### Roles

- 1× engineer (full-stack, comfortable with TypeScript + Solana). Can be split into 2 if there's a Rust-leaning person to do the SDK encoders and a TS-leaning person to do the UI, but the small size makes solo faster.

### Tooling

- pnpm 9, Node 22, TypeScript 5.6
- `next@15`, `react@19`, `tailwindcss@4`
- `@solana/web3.js@1.95`, `@solana/wallet-adapter-react@0.15`, `@solana/wallet-adapter-wallets@0.19`
- `lightweight-charts@5`
- `fastify@5`, `better-sqlite3@11`, `ws@8`, `pino@9`
- `vitest@2`, `playwright@1.48`
- `eslint`, `prettier`, `tsc --noEmit` in CI

### Infrastructure

- Vercel Hobby (or free Vercel for the frontend) — single region
- A small VM or Fly.io free tier for the indexer (24/7 to keep WS subscribers alive)
- Helius free RPC key (or fall back to public devnet RPC)
- Domain (optional — Vercel subdomain is fine for devnet MVP)

### Knowledge / docs

- This file (`docs/ai/planning/2026-06-16-feature-mgk-frontend.md`) and the linked requirements + design docs
- `.superstack/build-context.md` for program IDs and crate names
- Memory note `Percolator reference codebase patterns` for the two-layer pattern (we mirror it in TS)
- Memory note `Percolator 6j.9: solana-program-test e2e wiring for pinocchio programs` for the BPF layout caveat
- Memory note `Percolator: shuffle seed must equal close_slot, not commit_deadline` (relevant for batch timeline correctness, not for frontend code directly, but the frontend surfaces the close slot)
