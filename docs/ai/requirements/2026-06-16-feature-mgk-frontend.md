---
phase: requirements
title: mgk Frontend — Requirements & Problem Understanding
description: Subsystem of mgk protocol. Browser frontend for the on-chain mgk perpetual-futures DEX (commit-reveal CLOB, SOL-PERP, devnet)
---

# mgk Frontend — Requirements & Problem Understanding

> **Subsystem of mgk protocol.** This document describes a feature (`mgk-frontend`) that consumes the on-chain mgk protocol (`programs/*`). The on-chain mgk protocol is the primary system; this frontend is a dependent subsystem. When `/check-implementation` runs in this repo, it targets the on-chain mgk protocol source — not this frontend.

## Problem Statement

The mgk perps DEX (`mgk-perps-core` + `mgk-perps-matcher` + `percolator-oracle`) ships as four on-chain Solana programs (Pinocchio, `no_std`, no IDL). The programs are complete and tested (154 tests passing, MVP complete per `.superstack/build-context.md`), but there is no way for a human to actually use the protocol: no UI to connect a wallet, deposit SOL, place an order, or read positions.

This feature (`mgk-frontend`) is the user-facing surface for mgk. It must:

- Translate the protocol's commit-reveal batch model into a familiar perps-trader UX without hiding the on-chain truth (so traders understand what is happening and when).
- Work on devnet with a single market (SOL-PERP) and a clear path to add more later.
- Render a high-quality TradingView chart so SOL/USD price action feels real from first load, not just "empty until someone trades."

## Goals & Objectives

### Primary goals

1. **Trader can connect a wallet and see their portfolio**: deposits, balances, open positions, PnL, margin ratio.
2. **Trader can place, cancel, and modify limit orders** through the commit-reveal flow (CommitOrder + RevealOrder as a guided two-tx flow).
3. **Trader can read market state**: order book, recent trades, mark price, current batch phase and ETA, recent funding rate.
4. **Trader sees a real chart**: TradingView Lightweight Charts with a Pyth-candle backdrop and an mgk-trade marker overlay.
5. **Permissionless crank UX**: traders (or anyone) can advance the batch from `Committing` → `Revealing` → `Clearing` → `Settled` with a single button.
6. **Devnet-ready end to end**: the full deposit → commit → reveal → clear → settle cycle is exercised on devnet from the UI.

### Secondary goals

- **Show batch state timeline** with a clear visual: who is in the current batch, how many commitments, time remaining in commit phase, etc.
- **Friendly error mapping**: per-program error codes (0–99 common, 200–299 matching, etc.) become human messages.
- **My History panel**: trader can see their own past fills (price, qty, fee, time) so they can review activity and PnL. Backed by the indexer (filter fills where `taker_pubkey` or `maker_pubkey` equals the user).

### Non-goals (explicitly out of scope for v1)

- **Multi-market support**: SOL-PERP only. Adding BTC/ETH is a post-v1 task.
- **Market orders**: the on-chain protocol exposes only limit orders (commit-reveal); market orders would require a taker-side VAMM which is not in the current programs.
- **Mobile-native app**: responsive web only. No React Native / native shells.
- **Mainnet deployment**: devnet only. No production hardening, no audit, no real funds.
- **User accounts / KYC**: anonymous wallets only.
- **Subaccounts / multi-account**: one portfolio per wallet.
- **Push notifications / email**: in-app and browser-tab focus only.
- **I18n**: English-only copy.
- **Stop-loss / TP server-side logic**: client-side conditional orders only; the on-chain protocol does not run a server.

## User Stories & Use Cases

### Primary user: Solana trader (degen, prop, market-maker)

- As a **new visitor**, I want to land on the page and see a real-looking SOL/USD chart with mgk's recent trades so I understand what this DEX is within 5 seconds.
- As a **new visitor**, I want to click "Connect Wallet" and have Phantom / Solflare / Backpack work without configuration so I can start in one click.
- As a **first-time user**, I want a clear "Get Started" flow (connect → deposit → first order) so I do not have to read docs to trade.
- As a **trader**, I want to **deposit SOL** with a single transaction and see my available balance update immediately so I can size positions correctly.
- As a **trader**, I want to **place a limit order** by typing price and quantity, see a preview (margin required, est. fee, est. liquidation price), and submit it as a commit-tx followed by a reveal-tx so the order lands in the current batch.
- As a **trader**, I want a **visible "Batch: Committing (closes in ~12s)" indicator** so I know whether I can still commit, must wait, or whether the batch is being cleared.
- As a **trader**, I want to **cancel a resting order** by clicking an "X" in my open-orders list and have it removed in one transaction.
- As a **trader**, I want to **modify a resting order's quantity** in place without losing queue priority (modify, not cancel+replace).
- As a **trader**, I want to see my **unrealized PnL and margin ratio** update live (or near-live, polling) so I can manage risk.
- As a **trader**, I want to **withdraw** free collateral back to my wallet in one transaction.
- As a **trader**, I want to see my **past fills (price, qty, fee, time)** in a "My History" panel so I can review my activity and PnL.
- As a **first-time user**, I want a clear link to the **devnet faucet** so I can get SOL for rent and deposits without hunting for it.
- As a **user**, when I **switch wallets** in Phantom/Solflare/Backpack, I want the UI to **refetch my portfolio, batch state, and open orders** automatically and drop any in-flight commit-reveal state for the old wallet, so the new wallet is shown consistently within a couple of seconds.

### Secondary user: Keeper

- As a **keeper**, I want a single "Crank Batch" button when the batch is past `t_max_slots` so the protocol does not stall.

### Liquidator (deferred to post-v1)

Liquidations from the UI are **out of scope for v1**. The on-chain `LiquidateUser` instruction takes a single portfolio at a time, and there is no PDA listing underwater portfolios. A liquidator UX would require the indexer to subscribe to every Portfolio PDA and continuously check margin — feasible but heavy, and the keeper/trader flows already cover the primary value. Liquidators can use a CLI or script in v1; a paste-pubkey liquidator page is a candidate post-v1 feature.

### Edge cases to consider

- **Commit phase expired**: user tried to reveal too late. UI must show this clearly and refund the locked deposit.
- **Reveal mismatch**: hash does not match committed data. UI must surface "order slashed" and not retry.
- **Insufficient margin at reveal time**: the protocol rejects the reveal; the locked deposit is slashed. UI must explain what happened.
- **Wallet disconnects mid-flow**: any in-flight UI must clear and reconnect on wallet-change.
- **Wallet switches to a different account**: the UI must refetch portfolio, batch, open orders, and clear localStorage entries keyed to the old wallet — the new wallet's state must be consistent within one poll cycle (~5s).
- **Devnet airdrop is rate-limited**: if `requestAirdrop` fails, the user sees a "faucet busy" message and a link to https://faucet.solana.com.
- **Account already initialized**: connecting a wallet that has a portfolio PDA already should not error.
- **No SOL for rent**: portfolio init costs rent. UI must show estimated rent and warn if balance is too low.
- **Indexer lag**: when the indexer is behind chain head, fills may appear late on the chart. Show "synced as of slot N" so users know.
- **RPC rate limit**: devnet public RPCs throttle. The UI must batch reads (getMultipleAccounts) and surface a friendly "RPC busy" message.
- **Order book is empty**: an instrument with no resting orders should still render the chart and "place first order" CTA, not a blank state.
- **No mark price yet**: brand-new market — fall back to last trade, then oracle, then "awaiting first trade."

## Success Criteria

A v1 is successful when:

1. **End-to-end works on devnet**: a user can land → connect Phantom → deposit 0.1 SOL → place a limit order → wait for batch → see the order on the book or filled → close position → withdraw.
2. **Chart renders within 2s of page load** with at least 200 historical candles from Pyth and a near-live price line (the last trade price, polled at 2–5s). If Pyth is slow, a skeleton is visible within 100ms.
3. **No silent failures**: every program error from the 0–99 / 200–299 / 400–499 / 600–699 ranges maps to a human-readable message.
4. **All 11 user-callable instructions are exposed in the UI**: `InitPortfolio`, `Deposit`, `Withdraw`, `CommitOrder`, `RevealOrder`, `CloseCommitting`, `ClearBatch`, `SettleBatch`, `LiquidateUser` (deferred — see User Stories), `CancelRestingOrder`, `ModifyRestingOrder`. The two governance-only instructions (`Initialize`, `AddInstrument`) are exposed only behind a `?devtools=1` flag plus a wallet allowlist.
5. **Live, no-console-error Playwright run** of the full trade flow passes against devnet (see testing doc).
6. **Lighthouse Performance ≥ 80** on a desktop run of the home/trade page.
7. **No real funds at risk**: devnet only; mainnet is post-audit and not in scope.

## Constraints & Assumptions

### Technical constraints

- **No IDL** — mgk programs are Pinocchio, single-byte discriminator, raw-byte encoding. We must hand-write the TS instruction encoders (or generate them from a Rust-side `bs58`-style schema). No `@coral-xyz/anchor` IDL auto-loading.
- **Single-byte discriminators** — every instruction is `data[0]` = u8 (0–12). Mapping table is the source of truth in the design doc.
- **Commit-reveal is two transactions** — the UI must guide the user through this and persist the in-flight state (salt, batch_id, hash) across a refresh.
- **Program IDs are real on devnet**: per `.superstack/build-context.md`, `mgk-perps-core` is `DBrCzAMAJhxnPRQnBzEZGMhSALGfvQDDe6xEn2nU1uar` and `mgk-perps-matcher` is `9o2vTBBhEp6CYxNsDPsX79Euhzh8TtoLTSHR5R3jXebZ`. The matcher-oracle placeholders in `programs/common/src/program_ids.rs` are still zeros and need to be updated to match the on-chain deployment before the UI can submit.
- **SOL-only collateral** — no USDC, no other SPL mints in v1.
- **Per-program data sizes matter** — Portfolio, Batch, Book, Registry PDAs all have non-host-equal BPF layouts (per memory: i128 alignment differs 16 vs 8). Decoders must read by BPF layout, not TS struct layout.

### Business / operational constraints

- **Devnet only** for v1. No mainnet, no real SOL.
- **Public RPC OK for devnet** but Helius free tier is preferred for stability; if Helius unavailable, fall back to `https://api.devnet.solana.com`.
- **Indexer runs as a sibling Node service** (separate `mgk-frontend/apps/indexer` or `services/indexer` in a monorepo) and writes to SQLite. It must be runnable locally with `pnpm dev:indexer`.

### Assumptions

- The on-chain programs are stable in their current form (M6 6a–6k complete). If the program changes mid-build, the TS encoders and PDA derivation must change in lockstep.
- The on-chain batch cadence (`t_min_slots` / `t_max_slots` / `t_reveal_slots`) is set in devnet deployment to give a usable UX (e.g., 30–60s commit window) — not a 5s commit window that nobody can use.
- Pyth has a working SOL/USD price feed on devnet. The mainnet SOL/USD feed ID is `H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG` (the historic `7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE` may also be referenced — confirm which is current). The devnet feed ID must be verified during M5 — devnet Pyth typically uses a different pubkey than mainnet. If Pyth is unavailable on devnet, fall back to the on-chain admin-pushed fallback oracle (`percolator-oracle`) for the live price line; the chart can still render with a "no backdrop" message.
- One user = one wallet = one portfolio PDA. No multi-account.

## Questions & Open Items

### Preconditions (must be resolved before M1 starts)

- **Q1 — batch timing config**: What is the actual devnet `t_min_slots` / `t_max_slots` / `t_reveal_slots` configuration? This drives the batch timer UX. *Owner: deployment phase. Blocks M2 (batch timeline).*
- **Q2 — oracle program ID**: Do we have a deployed devnet program ID for `percolator-oracle`? Currently `programs/common/src/program_ids.rs` returns all-zeros. Need to update with the devnet-deployed key before the UI can compute oracle PDAs. *Owner: deployment phase. Blocks M5 (chart backdrop fallback).*
- **Q3 — Pyth devnet feed ID**: Which Pyth SOL/USD feed ID is live on devnet? Verify with `https://hermes.pyth.network/v2/price_feeds?query=sol` or the on-chain Pyth mapping. *Owner: M5 (chart). Blocks M5 if not resolved.*
- **Q7 — indexer PG/SQLite decision**: SQLite for v1 (per design). Confirm acceptable; reconsider if devnet traffic patterns differ from the estimate. *Owner: M4. Not blocking.*

### Resolved (default decided; revisit if the context changes)

- **Q3 (RPC) → Default: Helius free with public RPC fallback.** *(Resolved in brainstorming 2026-06-16.)*
- **Q4 (monorepo) → Default: same monorepo (`mgk-frontend/apps/web` + `mgk-frontend/apps/indexer` + `mgk-frontend/packages/sdk`).** *(Resolved in brainstorming 2026-06-16. Restructured 2026-06-16: frontend moved into `mgk-frontend/` subfolder of the Rust repo to enable future `git subtree split` into its own repo.)*
- **Q5 (brand) → Default: no — neutral dark theme; treat brand polish as a polish pass at the end.** *(Resolved in brainstorming 2026-06-16.)*
- **Q6 (landing) → Default: minimal landing → click "Launch App" → trade page.** *(Resolved in brainstorming 2026-06-16.)*
- **Liquidator UX → Out of scope for v1.** Drop the liquidator user story. *(Resolved in review 2026-06-16.)*
- **Devnet SOL → External faucet link only.** No in-app airdrop button; show a "Get devnet SOL" link to https://faucet.solana.com. *(Resolved in review 2026-06-16.)*
- **13-instruction contradiction → Reworded to 11 user-callable instructions.** *(Resolved in review 2026-06-16.)*
- **Wallet switching → Refetch on `useWallet().publicKey` change.** Drop in-flight localStorage entries keyed to the old wallet. *(Resolved in review 2026-06-16.)*
- **Trade history → Add a "My History" panel** as a secondary goal + user story. *(Resolved in review 2026-06-16.)*
- **Live vs near-live → Standardize on "near-live, polled at 2–5s"** in the spec. *(Resolved in review 2026-06-16.)*
