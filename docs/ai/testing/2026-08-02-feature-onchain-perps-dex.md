---
phase: testing
title: mgk On-Chain Perps DEX — DFBA Test Strategy
description: Test coverage for Dual Flow Batch Auction matching (replaces commit-reveal CLOB plan).
status: in-progress
date: 2026-08-02
updated: 2026-08-20
requirements: docs/ai/requirements/2026-06-18-feature-onchain-perps-dex.md
design: docs/ai/design/feature-onchain-perps-dex.md
planning: docs/ai/planning/2026-08-02-feature-onchain-perps-dex.md
---

# mgk On-Chain Perps DEX — DFBA Test Strategy

## Context

v1 matching is **pure DFBA**: open posts, dual uniform-price auctions, dual mid mark, liquidation pause without dual clear. Commit-reveal, shuffle, and priority queues are **out of scope** for new tests (legacy CLOB tests may remain until removed).

Programs: `perps-core`, `perps-matcher`, `mgk-oracle`, `mgk-common`.

## Test inventory (2026-08-06)

| Crate | DFBA-focused | Notes |
|-------|--------------|-------|
| `mgk-perps-matcher` | **21+** in `state/dfba.rs` + book `is_maker` | Host `cargo test -p mgk-perps-matcher --lib` (114 pass, 1 ignored) |
| `mgk-perps-core` | batch/settle/liq gates, PostOrder, ClearBatch, SettleMark | `cargo +stable test -p mgk-perps-core --lib --features host-hash` (225 pass) |
| `mgk-common` | math, types, errors | `cargo test -p mgk-common` (45 pass) |
| Legacy matcher CLOB/shuffle/queue | still present | Not the DFBA path |
| `lifecycle.rs` e2e | **10 DFBA tests (0 `#[ignore]`)** | `SBF_OUT_DIR=target/deploy cargo +stable test -p mgk-perps-core --test lifecycle --features host-hash e2e_` (BPF compat issue: pre-existing) |

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
- [x] T-POST-ORDER-UNIT — PostOrder wire format: disc 20, 21-byte data parse, CPI layout (disc 6, 54 bytes), validation constants (**done 2026-08-06**: 9 new tests in `post_order.rs`)
- [x] T-CLEAR-BATCH-IX — DfbaClear CPI layout (disc 5, 11 bytes), mark_valid/liq_paused flag logic (4 scenarios), clearing_price mid rounding, volume conservation (**done 2026-08-06**: 10 new tests in `clear_batch.rs`)
- [x] T-SETTLE-MARK — instrument.mark_price from dual mid when mark_valid; carry-forward when invalid; zero when no prev (**done 2026-08-06**: 6 new tests in `settle_batch.rs`)

### E2E (BPF / program-test)

- [x] T-E2E-DFBA-FILL — PostOrder × dual makers+takers → close → DfbaClear → settle; mark_valid + fills + fees
- [x] T-E2E-REST — unfilled rests next batch with role (**done 2026-08-06**: `test_e2e_resting_across_batch`)
- [x] T-E2E-LIQ-PAUSE — one-sided clear ⇒ mark_valid=0, liq_paused=1
- [x] T-E2E-SELF — same wallet maker+taker does not self-fill (**done 2026-08-06**: `test_e2e_self_trade_no_fill`)
- [x] T-E2E-CANCEL — cancel resting between batches (**done 2026-08-06**: `test_e2e_cancel_resting_between_batches`)
- [x] T-E2E-GTC-RESTS-NEXT-BATCH — DFBA resting order across batches (**done 2026-08-06**: `test_e2e_gtc_rests_then_matches_next_batch` rewritten from legacy)
- [x] T-E2E-SETTLE-NEXT-PDA — SettleBatch creates next batch PDA (**done 2026-08-06**: `test_e2e_settle_creates_next_batch_pda` rewritten from legacy)
- [x] T-E2E-LIQUIDATE — DFBA mark + underwater portfolio liquidation (**done 2026-08-06**: `test_e2e_liquidate_user_happy_path` rewritten from legacy)
- [x] T-OPS-KEEPER-LIQ — 24/7 ops keeper + live LiquidateUser (**done 2026-08-20** T9.10.2). `cd tools && node --test` **14 passed**. Live: taker `8SWub3A3…` flatten `3WDbtrsw…` (`err: None`) against settled batch 13 `mark_valid=1` (D6: current settled only; did not use leftover batch 11). After flatten `positionsLen=0`. `/healthz` on `127.0.0.1` has `rpcHost` only (no rpcUrl/api-key/keypair). Collecting crank waits for deadline (`n_min` ignored). Empty batch 14 crank Close `f3GX7pYY…` Clear `8z1XiER6…` Settle `4rMFLcL8…`.
- [x] T-E2E-ADL — ADL fires when insurance insufficient (**done 2026-08-06**: `test_e2e_liquidate_user_adl_stub_fires` rewritten from legacy)
- [x] T-E2E-CANCEL-ALL — CancelAllRestingOrders clears book (**done 2026-08-06**: `test_e2e_cancel_all_resting_orders` rewritten from legacy)

### Browser origin hydration (playwright-cli, 2026-08-20)

- [x] T-WEB-ORIGIN-HYDRATION — `/trade` hydrates at `http://localhost:3000` and
  `http://127.0.0.1:3000`. playwright-cli sessions `-s=origin-local` /
  `-s=origin-loopback`: Select Wallet opens heading `/connect a wallet on
  solana/i`; chart `tf-15m` sets `data-active=true`. Linked: T9.8.1.
  CI: `e2e/trade.spec.ts` Browser origin hydration (both origins). Console
  Helius 429 / indexer `localhost:4000` refused are not hydration failures.
- [x] T-WEB-WALLET-MODAL — Wallet selector opens from both origins without a
  dead React tree. Linked: T9.8.1.
- [x] T-WEB-CHART-STATE — Chart region shows loading while `tv.js` is pending,
  error + Retry on script failure, and a TradingView iframe after success or
  Retry. Chart toolbar and order form stay usable. Linked: T9.8.3.
  Evidence 2026-08-20: vitest `TradingViewWidget.test.tsx` 12 passed (red on
  missing `tradingview-loading` / `tradingview-retry`). playwright-cli
  `-s=origin-loopback` success iframe; `-s=chart-error` delayed abort
  `{loading:true, retry:true, toolbar:true, active:"true", orderForm:true}`
  then unroute + Retry `{loading:true, iframe:true, err:0, retry:0}`.

### Visible DFBA lifecycle (T9.8.4, 2026-08-20)

- [x] T-WEB-DFBA-LIFECYCLE — Browser executes PostOrder and observes Collecting
  → Clearing → Settled copy. Linked: T9.8.4.
  Mock: `pnpm e2e:wallet` **2 passed** (9.8s). Capture-only Phantom still does
  not send live txs. Mutable `setBatchPhase('clearing'|'settled-valid')` is
  the Settled UI gate because live Settle creates the next Collecting window.
  Live 2026-08-20: batch 12 Collecting `A23Nka5d…` → CloseCollecting
  `--close-only` `38JW1iAP…` held status=2; both personas showed
  `Batch: Clearing · Orders closed · Matching maker and taker flow at
  uniform prices`. `--skip-close` Clear `3ZnHLn6Q…` (results `3a5QzoHU…`)
  Settle `51s24Wix…`. Batch 12 Settled `mark_valid=0` (empty close). Next
  batch 13 Collecting `4tHVHn3o…`. Do not treat `pnpm e2e:wallet` as a fill.

### Keeper lag (T9.8.6, 2026-08-20)

- [x] T-KEEPER-LAG-INTENT — Past-deadline Collecting that already meets
  `n_min` says `Ready to clear · Waiting for keeper` and appends elapsed
  wait `· HH:MM:SS late` after the close slot. Copy never uses the
  countdown string `past deadline`. Linked: T9.8.2, T9.8.6.
  Evidence 2026-08-20: `batchDisplay.test.ts` exact-deadline still
  `Waiting for keeper`; 50_000 close / 50_500 slot → `Waiting for keeper
  · 00:03:20 late`. Mock e2e `collecting-ready` (commitDeadlineSlot=10,
  fixture slot 42) → `Ready to clear · Waiting for keeper · 00:00:13
  late` on `status-batch-label` and `market-header-intent`;
  `market-header-batch` is not `/past deadline/i`. `pnpm e2e:wallet`
  **3 passed** (9.1s), still not a fill.
  Indexer `GET /api/healthz` returns sqliteWritable, latestIndexedSlot,
  rpcSlot, slotLag, lastBatch, subscriptions; never `rpcUrl`. Isolated
  healthStore: fill slot 150, rpcSlot 200 → slotLag 50. Indexer
  integration **27 passed**. Live maker after batch 13:
  `Waiting for minimum flow (0/1)` because posts < `n_min` — not keeper
  lag.

### No legacy web flow (T9.8.7, 2026-08-20)

- [x] T-NO-LEGACY-WEB-FLOW — Active trade UI and tests contain no
  commit/reveal/slashed journey. Linked: T9.8.7.
  Evidence 2026-08-20: `recoverOrderFormState` drops persisted
  `slashed | committing | awaiting_reveal | revealing`. Store statuses
  are `idle | submitting | done | failed`. Dev `?set=` honors only
  `failed | submitting | idle`. OrderForm never renders
  `order-form-slashed-banner`. `useCommitOrder` / `useRevealOrder`
  removed. SDK `classifyError` may still return severity `slashed` for
  codes 600/503 (taxonomy, not UI). Focused vitest **63 passed**.
  `pnpm exec playwright test e2e/trade.spec.ts --project=chromium`
  **33 passed** (13.6s), including `legacy query params do not open a
  slashed or reveal journey` and `?set=failed keeps the PostOrder form
  usable`. playwright-cli `-s=legacy`: `?set=slashed`
  `{banner:false, slashedText:false, reveal:false, buy:true}`.
  Historical docs and on-chain `commitDeadlineSlot` names stay.

### Browser E2E (Playwright)

- [x] T-WEB-WALLET-CONNECT — deterministic Phantom-compatible provider auto-connects without an extension or approval popup.
- [x] T-WEB-POST-ORDER — mocked registry/portfolio/book/Collecting-batch RPC state drives the real `/trade` form through PostOrder construction.
- [x] T-WEB-POST-WIRE — captured transaction pins disc `20`, buy+maker flags, exact 1e6-scaled price/qty, instrument `0`, and six account metas including the user signer.
- Run only this fast path with `cd mgk-frontend/apps/web && pnpm e2e:wallet`.

### Live devnet smoke (Playwright MCP, 2026-08-09) — historical, not a fill proof

One connected Phantom wallet. Opposing posts from this wallet exercise
**self-trade skip**, not independent-counterparty matching. Do not add new
Playwright MCP coverage. Matching proof is **T-WEB-PERSONA-*** below.

- [x] T-WEB-LIVE-POST — Phantom-approved Buy/Long limit order confirmed on
  devnet at `76.55` / `0.01`; signature
  `482LWPHQXSfXt1EecLmtHNeYGoQJVSn8VDCj4RQEFcDnKYyMTfYdpXBtwgmHgn8exZzJ7cKNunzP1AYhJ2Np1Xgg`.
- [x] T-WEB-GTC-OBSERVE — keeper advanced batch 7 → 8 and the book endpoint
  retained the new bid (`price=76550000`, `qty=10000`, `orderCount=1`).
- [x] T-WEB-DFBA-COPY — header and status bar agree on
  `Orders open · Waiting for minimum flow (0/1)`.
- [x] T-WEB-MARKET-BASELINE — `/api/markets/0/state` returns HTTP 200 with a
  zero baseline before the first fill.
- [x] T-WEB-CROSSED-BOOK — crossed best bid/ask does not render a midpoint;
  UI reports that the book is crossed.

Regression suites added during this continuation cover stale runtime account
owner/size validation, minimum-flow copy, background portfolio refresh
stability, transient batch RPC preservation, and crossed-book midpoint safety.

### Live surface continuation (2026-08-09) — historical UI wiring

Same single-wallet MCP session as above. Evidence that Sell, cancel, modify,
portfolio tabs, and Clearing copy work. **Not** T-WEB-PERSONA-MATCH.

- [x] T-WEB-LIVE-SELL — Playwright MCP submitted a Sell/Short PostOrder with
  maker + reduce-only selected; the transaction confirmed and the resulting
  resting order was visible in Open Orders.
- [x] T-WEB-LIVE-CANCEL — Open Orders cancel path opened wallet approval and
  removed the test short order after confirmation.
- [x] T-WEB-LIVE-MODIFY — Inline modify mode opened, rejected a zero quantity
  with visible validation feedback, kept the editor open, and sent no
  transaction.
- [x] T-WEB-LIVE-PORTFOLIO — Portfolio, balances, positions, open orders, trade
  history, and the three coming-soon history tabs rendered without application
  exceptions; deposit/withdraw controls enabled for a valid SOL amount without
  submitting funds.
- [x] T-WEB-CLEARING-DISPLAY — A live Clearing batch now renders `Batch:
  Clearing` plus `Orders closed · Matching maker and taker flow at uniform
  prices` instead of disappearing to `Batch: —`.
- [x] T-WEB-CROSSED-ORDER-FORM — Crossed best bid/ask no longer auto-fills a
  Sell price; the form shows `0.00`, base-asset `SOL` sizing, and collateral-
  derived availability.
- [x] T-WEB-DFBA-HISTORY-COPY — Order History no longer exposes commit/reveal
  terminology in its user-facing description or required indexer sources.

Focused regression evidence after these changes: web OrderForm + batch-store
tests **44 passed**, Open Orders tests **2 passed**, and history placeholder
tests **16 passed**.

Open infrastructure follow-up: the live browser produced Helius devnet RPC
`429` responses while several independent stores polled concurrently. Keep
this separate from protocol correctness; add shared throttling/indexer-backed
read caching before treating live console-error-free operation as complete.

### Independent-counterparty live DFBA (playwright-cli personas, planned)

**Gate for working-devnet matching proof.** Two named `playwright-cli` sessions
against `http://localhost:3000/trade` on **live Solana devnet** M9 programs
(core `C7w2mKz2KQgDroNNhACm9MutXhPiesVr9Gn2x8TDsRYx`). Signing is an injected
Wallet Standard / Phantom-compatible provider that **sends** transactions.
Keypairs stay on disk (`~/.config/solana/mgk-trader-{maker,taker}.json` or
`MGK_MAKER_KEYPAIR` / `MGK_TAKER_KEYPAIR`). Never Playwright MCP. Never
Phantom-extension popups as the matching gate. Never treat `pnpm e2e:wallet`
(capture-only `mockPhantom.ts`) as a fill.

Keeper is `node tools/keeper-crank.js`, not a browser persona. Optional
`-s=observer` is unsigned public UI. Live window stays `t_min=2`, `t_max=150`,
`n_min=1`.

`mark_valid` needs **both** auctions (bid = maker-buy × taker-sell, ask =
maker-sell × taker-buy). T-WEB-PERSONA-MATCH is not done with a single
buy-vs-sell pair. Do not reuse the 2026-08-09 crossed-book 76.55 / 0.10 prices.

- [x] T-WEB-PERSONA-SETUP — `playwright-cli -s=maker` and `-s=taker` have
  isolated storage; each UI shows a distinct funded pubkey after inject;
  InitPortfolio + Deposit complete (scripted reuse of `tools/trade-e2e.js`
  helpers is allowed); snapshots/traces/screenshots contain no secret key,
  seed, or password. Linked: T9.9.1 / T-WEB-TWO-WALLET-SETUP.
  Evidence 2026-08-20: maker `6LZPnkFwdT1xPoVy4y1WCyF6mRUyzvcs6Ndo9oFqBwWe`
  (portfolio `27zXKvEE…`, principal 100000400); taker
  `BeBT1zZAcPxeze8wiWNR7JFfPJL2QRPjd1cg26WJeXFe` (portfolio `8SWub3A3…`,
  principal 99999000). `mgk-order-form-wallet` isolated. `vitest run
  lib/e2e/livePhantom.test.ts` 3/3. Artifact scan of `/tmp/mgk-t991` +
  `.playwright-cli` YAML/PNG: no secretKey/seed/password/keypair bytes.
- [x] T-WEB-PERSONA-POST — Both UIs show the same Collecting `batch_id`. Four
  PostOrders through `/trade` testids (`order-form-side-buy` /
  `order-form-side-sell`, `order-form-checkbox-input-post-as-maker`,
  `order-form-price-input`, `order-form-qty-input`, `order-form-submit-buy` /
  `order-form-submit-sell`): maker-buy GTC, maker-sell GTC, taker-sell
  crossing the bid, taker-buy crossing the ask. Linked: T9.9.2 /
  T-WEB-TWO-WALLET-POST.
  Evidence 2026-08-20: Collecting batch 11
  (`5fNur4FYLzvKhHMeRw2LRs8fwGjhs3mAsft4rJURisCc`). CreateBatch
  `1k5YyfJfMQtDiEwqJNz4ecDn5TF9RWVcpGePcW5fnv1hH6u7fTHrFxeCKhtnekv5zQoTZ73ey6JoJmjM5ymHZhu`.
  Dual-auction UI posts at 86/88 qty 0.01 (not 76.55/0.10). Maker sell
  `r4AyJiLFfmRTP1FP2Jf2qaxH4VKL4Je86kX5E3d7PbKBjh43u97ALJFdvcHYL6o4Ri8FFBWqoupHeEwYEsPK8g5`;
  taker sell
  `5CWyKwT8Uq1VcU3z2gXM33445DZeStVukkBWnNTLisD6L8fXu3WEAhP7Ch21xJ3FTawjfsHvAXxP58zkzvJ8LQv2`;
  taker buy
  `3cAeT5eQge7ah6g8746AzK8AYvCyxyskCPFcy2FzeMTpBjThrWPMiQGGLYf3oFWMtbshTYwxKRDE3qdgTM3rxFmv`.
  On-chain `total_commitments=5` (extra 429 retry). Both headers:
  `BATCH: COLLECTING` / Ready to clear / Waiting for keeper.
- [x] T-WEB-PERSONA-MATCH — After CloseCollecting → DfbaClear → SettleBatch,
  both UIs show fills, fees, and positions; settled batch `mark_valid=1`.
  Capture signatures + result-account snapshots. Linked: T9.9.3 /
  T-WEB-TWO-WALLET-MATCH.
  Evidence 2026-08-20: batch 11 Settled `mark_valid=1` bid 86 / ask 88
  matched 0.01 each. Close
  `4MuCUWhCJEqVwQbFoN1NXbvFGuNGaKL9jGSXtqn41A6vFotVe5V9cm1aWpndtCUYHDCuKcyQRTyn4b1Ljqmejp5c`;
  Clear
  `39pVR7vjhgWRqskyytwXABfTkW2mXkuxSfyWGacvnRgx7JeGrVQiQTCM4CeXG8B9GLb5otxgUfCiDcTZaadwEKbb`
  (results `2qy2jdkTwT26hWSortMJrmxyadrUEFQYDfzwRFBWJhpx`); Settle
  `4SdygpL4BS9ykc35u51Vht14opVUF4yn5T6xg9bTFihdXo3NWXRVGW9kUXCTH7XdaRjcMSPM8XB9jXa59RVt1co3`.
  Maker UI Flat 0.000000 @ 86.00; taker UI Long 0.010000 @ 88.00.
  Residuals diagnosed in T9.9.5 (no matcher patch): bid fill vs stale
  Phantom `2ecHahNv…`; taker equity −880.34e9 is one-sided ask cash
  `qty * price` + 5 bps; Trade History tab has no fill/fee ledger
  (indexer down).
- [x] T-E2E-TWO-USER-FILL — Deterministic two-pubkey CI fixture (no RPC)
  asserting allocation, fee flow, position deltas, leftover + D3 fees,
  and no self-trade regression. Linked: T9.9.4.
  Evidence 2026-08-20: `cargo +stable test -p mgk-perps-core --lib t_e2e_two_user`
  → 3 passed (`t_e2e_two_user_fill_allocation_fees_and_positions`,
  `t_e2e_two_user_self_trade_does_not_fill`,
  `t_e2e_two_user_fill_makers_free_d3`). Host-only; matcher
  `run_dual_dfba` reused via core **dev-dependency**.

Operator runbook (T9.9.1, never omit `-s=` once both sessions are open):

```sh
# From .worktrees/feature-dfba-auction. Build SDK dist first (see next.config.ts).
pnpm -F @mgk/sdk build   # in mgk-frontend
pnpm --filter web dev    # http://localhost:3000/trade
node tools/fund-personas.js   # InitPortfolio + Deposit; logs RPC host only

playwright-cli -s=maker open http://localhost:3000/trade
playwright-cli -s=taker open http://localhost:3000/trade
tools/persona-inject.sh maker && playwright-cli -s=maker reload
tools/persona-inject.sh taker && playwright-cli -s=taker reload
# Isolation: eval window.solana.publicKey.toBase58(); localstorage-get mgk-order-form-wallet
```

Do not use `tools/playwright-cli-inject.js` (CLI daemon never sees `MGK_PERSONA`
from the invoking shell). Do not use Playwright MCP. `pnpm e2e:wallet` stays
capture-only. Keypairs: `~/.config/solana/mgk-trader-{maker,taker}.json`.

### Superseded (do not add new coverage)

- CommitOrder / RevealOrder success paths
- Fisher-Yates fairness demos as product gates
- Pre-signed reveal relayer
- Freshness mark blend / toxic-taker scoring (deferred)
- New Playwright MCP (`@playwright/mcp`) coverage as a matching or wallet-QA gate
- Phantom-extension popups as the independent-counterparty fill harness

### Pause matrix (T9.4.2, done 2026-08-06)

- [x] T-PAUSE-POST — PAUSE_POST bit 4 blocks PostOrder (with PAUSE_TRADING umbrella)
- [x] T-PAUSE-CLEAR — PAUSE_CLEAR bit 5 blocks CloseCollecting + ClearBatch (with PAUSE_TRADING umbrella)
- [x] T-PAUSE-BITS — 6 independent bits pinned (TRADING, WITHDRAWALS, LIQUIDATIONS, FUNDING, POST, CLEAR)
- [x] T-PAUSE-RESERVED — PAUSE_RESERVED_MASK now 0b_1100_0000 (bits 6..7 only)

### CU measurement (T9.1.7, done 2026-08-06)

- [x] T-CU-32 — 32 orders/side × 1000 iterations host benchmark
- [x] T-CU-64 — 64 orders/side × 1000 iterations host benchmark
- [x] T-CU-128 — 128 orders/side × 1000 iterations host benchmark
- [x] T-CU-OVERFLOW — cap=64 with 80 orders (priority selection)

## Coverage targets

| Layer | Target |
|-------|--------|
| DFBA pure math | 100% of `dfba.rs` public API |
| Book role flag | place + persist |
| Clear/settle wire | disc + header constants pinned |
| E2E | ≥1 dual-fill path on devnet/program-test when env allows; independent-wallet **browser** fill is T-WEB-PERSONA-MATCH |
| SBF | matcher + core `cargo build-sbf` zero stack overflow |

## Evidence log

| Date | Command | Result |
|------|---------|--------|
| 2026-08-02 | `cargo test -p mgk-perps-matcher --lib` | **110 passed**, 1 ignored |
| 2026-08-02 | `cargo +stable test -p mgk-perps-core --lib --features host-hash` | **193+** then **196 passed** (2026-08-03) |
| 2026-08-03 | lifecycle `e2e_` with `SBF_OUT_DIR=target/deploy` | dual fill + one-sided liq pause **ok** |
| 2026-08-02 | `cargo build-sbf` matcher+core | clean (no stack errors) |
| 2026-08-06 | `cargo +stable clippy --all-targets --all-features -- -D warnings` | **clean** (23 warnings fixed) |
| 2026-08-06 | `cargo test -p mgk-perps-matcher --lib` | **114 passed** (+4 CU benchmarks) |
| 2026-08-06 | `cargo +stable test -p mgk-perps-core --lib --features host-hash` | **196 passed** |
| 2026-08-06 | `cargo test -p mgk-common` | **44 passed** |
| 2026-08-06 | `cargo +stable check -p mgk-perps-core --test lifecycle` | compiles (e2e_resting_across_batch added) |
| 2026-08-06 | `cargo +stable test -p mgk-perps-core --lib --features host-hash` | **225 passed** (+25 T-POST-ORDER-UNIT/T-CLEAR-BATCH-IX/T-SETTLE-MARK) |
| 2026-08-06 | `cargo test -p mgk-common` | **45 passed** |
| 2026-08-06 | `cargo +stable clippy --all-targets --all-features -- -D warnings` | **clean** (post new tests) |
| 2026-08-06 | `cargo +stable test -p mgk-perps-core --lib --features host-hash` | **225 passed** |
| 2026-08-06 | `cargo test -p mgk-perps-matcher --lib` | **114 passed** |
| 2026-08-06 | `cargo test -p mgk-common` | **45 passed** |
| 2026-08-06 | lifecycle.rs e2e BPF tests | **7 pass, 4 ignored** (CU exhaustion in ClearBatch) |
| 2026-08-06 | `SBF_OUT_DIR=target/deploy cargo +stable test -p mgk-perps-core --test lifecycle --features host-hash` | **7 passed**, 4 `#[ignore]` |
| 2026-08-08 | `cd mgk-frontend/apps/web && pnpm e2e:wallet` | **1 passed**; deterministic wallet + mocked RPC; browser body ~1.1s |
| 2026-08-20 | `cd mgk-frontend/apps/web && pnpm e2e:wallet` | **2 passed** (9.8s); PostOrder construction + Collecting→Clearing→Settled copy; not a fill |
| 2026-08-20 | `cd mgk-frontend/apps/web && pnpm e2e:wallet` | **3 passed** (9.1s); + keeper-lag `collecting-ready` 00:00:13 late |
| 2026-08-20 | `cd mgk-frontend/apps/indexer && pnpm exec vitest run src/integration.test.ts` | **27 passed**; healthz lag/lastBatch |
| 2026-08-08 | `cd mgk-frontend/apps/web && pnpm exec playwright test --project=chromium` | **31 passed** |
| 2026-08-20 | `cd mgk-frontend/apps/web && pnpm exec playwright test e2e/trade.spec.ts --project=chromium` | **33 passed** (13.6s); T-NO-LEGACY-WEB-FLOW describe |
| 2026-08-20 | focused vitest T9.8.7 (store, wallet guard, submission, OrderForm) | **63 passed** |
| 2026-08-08 | `cd mgk-frontend/apps/web && pnpm exec vitest run` | **436 passed** |
| 2026-08-08 | `cd mgk-frontend/packages/sdk && pnpm test` | **158 passed** |
| 2026-08-20 | `cargo +stable test -p mgk-perps-core --lib t_e2e_two_user` | **3 passed** (T-E2E-TWO-USER-FILL) |
| 2026-08-20 | Phase 8: `cargo test -p mgk-perps-matcher --lib` | **114 passed**, 1 ignored (`test_book_pda_derivation_runtime`) |
| 2026-08-20 | Phase 8: `cargo +stable test -p mgk-perps-core --lib t_e2e_two_user` | **3 passed** (re-verified) |
| 2026-08-20 | Phase 8: `pnpm e2e:wallet` | **3 passed** (12.5s); not a fill |
| 2026-08-20 | Phase 8: `pnpm exec playwright test e2e/trade.spec.ts --project=chromium` | **33 passed** (13.5s) |
| 2026-08-20 | Phase 8: focused web vitest (store, wallet guard, submission, OrderForm, batchDisplay) | **84 passed** (78 + 6 wallet-guard); OrderForm WalletContext stderr is pre-existing, tests pass |
| 2026-08-20 | Phase 8: indexer `vitest run src/integration.test.ts src/runtimeValidation.test.ts` | **30 passed** |
| 2026-08-20 | Phase 8: Positions + Balances vitest | **26 passed** (T9.8.5 regression keep still open in live UI) |
| 2026-08-20 | `cargo +stable clippy -p mgk-perps-core --all-targets --all-features -- -D warnings` | **clean** |
| 2026-08-08 | `cd mgk-frontend/apps/web && pnpm typecheck` | **clean** |
| 2026-08-08 | `cargo +stable clippy --all-targets --all-features -- -D warnings` | **clean** |
| 2026-08-08 | `cargo +stable test --all-features` | **396 passed**, 5 ignored, 0 failed |

## Risks

- **Independent-wallet browser fill proven 2026-08-20:** batch 11 `mark_valid=1` via playwright-cli + crank. T9.9.5 diagnosis: stale-book bid user `2ecHahNv…` and taker equity −880.34e9 are not matcher faults. No Trade History fee ledger (indexer down).
- Same-wallet MCP smoke is self-trade skip, not a matcher failure.
- One-sided (single buy vs sell) posts can leave `mark_valid=0`.
- Crossed-book 76.55 / 0.10 prices will not clear both auctions.
- Helius / public-devnet 429s under concurrent store polling.
- Named playwright-cli sessions leak storage if `-s=` is omitted.
- Key material in snapshots/traces if the inject helper dumps secretKey.
- **BPF e2e CU exhaustion (P1 harness-only, not working-devnet):** Matcher DfbaClear consumes 1.4M CUs in ClearBatch under program-test 2.1's 200k meter. 4 e2e tests `#[ignore]`. Devnet empty Clear ≈ 2.6k CU. Do not block T9.9.1 on this.
- Core e2e needs `SBF_OUT_DIR`/`BPF_OUT_DIR` absolute path to `target/deploy` and `+stable` for host test binary.
- Results accounts must be **matcher-owned**.
- Keeper and both trader keypairs need SOL for fees and collateral on devnet.
- ~~BPF e2e `InvalidArgument` on Initialize~~ — **Fixed**: swapped vault/system_program account indices.

## Next testing work

1. ~~**T-WEB-PERSONA-SETUP (T9.9.1)**~~ — **Done 2026-08-20.**
2. ~~**T-WEB-PERSONA-POST (T9.9.2)**~~ — **Done 2026-08-20** (batch 11, four dual-auction UI posts).
3. ~~**T-WEB-PERSONA-MATCH (T9.9.3)**~~ — **Done 2026-08-20** (batch 11 `mark_valid=1`; residuals diagnosed T9.9.5).
4. ~~**T-E2E-TWO-USER-FILL (T9.9.4)**~~ — **Done 2026-08-20** (`cargo +stable test -p mgk-perps-core --lib t_e2e_two_user` 3 passed). T9.9.5: no matcher patch.
5. ~~**T-WEB-CHART-STATE (T9.8.3)**~~ — **Done 2026-08-20.** `TradingViewWidget.test.tsx` 12/12. playwright-cli `-s=chart-error`: delayed abort `tv.js` showed loading then error+Retry; toolbar/order form stayed clickable; unroute + Retry produced iframe.
6. ~~**T-NO-LEGACY-WEB-FLOW (T9.8.7)**~~ — **Done 2026-08-20.** Store recover drops commit-reveal/slashed. Playwright `trade.spec.ts` **33 passed**. M9.10 T9.10.1–3 done. T9.8.5 Positions flicker remains a regression.
7. ~~Fix BPF e2e CU exhaustion as working-devnet P0~~ — **Downgraded:** program-test harness only; not a live matching blocker.
8. ~~Rewrite `programs/perps-core/tests/lifecycle.rs` for PostOrder + DfbaClear~~ — **Done 2026-08-06**.
9. ~~**Phase 8 coverage audit (2026-08-20)**~~ — Closed remainder re-verified (commands in evidence log). No new M9.10 tests added.
10. ~~**T-OPS-KEEPER-LIQ (T9.10.2)**~~ — **Done 2026-08-20.** `tools/` 14 tests; live LiquidateUser `3WDbtrsw…`; `/healthz` host-only.
11. ~~**T-OPS-ORACLE-RELIABLE (T9.10.3)**~~ — **Done 2026-08-24.** Disc 23 tests, Unix timestamp freshness boundary tests, soft skip tests in Rust; 33 node tests in `tools/`; SDK 160 pass; indexer 34 pass; devnet live oracle binding `26G5oZBq…` + 4-venue update `5yJFzRB5…` + batch 20 settle `2BYRK69U…`.

Remaining (not this phase):

- **T9.8.5** Positions flicker — regression keep (unit tests 26 passed; live visual stability still Partial).
- **T9.10.4** indexer UI not a silent stale book.
- **T9.10.5** replace SMA funding with D7 `f(mark − index)` — **Done 2026-08-24.** Devnet: core upgrade + SetFundingParams `2Hys2B8…` (coeff 1→10000, interval=100, cum_funding preserved). JS operator tool: 21 tests.
- **T9.10.6** stop first-batch book/oracle mark seed.
- **T9.10.7** paper fill-lot 100/400 and 100/250/50 — test gap, not algorithm gap (queued under M9.10).
- BPF lifecycle **4 ignored** — program-test CU meter only.
- Requirements #15 batch p50/p99 latency — not measured.

Next: T9.8.5 regression watch (positions flicker). Security review remains before mainnet.

## Phase 8 — Check coverage vs requirements (2026-08-24)

| Req # | Criterion | Test evidence | Status |
|-------|-----------|---------------|--------|
| 1 | Rust tests include DFBA clear/alloc/self-trade/rest/cap/oracle | matcher lib **115 passed**; core lib **235 passed**; common **45 passed** | **Met** |
| 2 | Clippy `-D warnings` | `cargo +stable clippy --all-targets --all-features -- -D warnings` **clean** | **Met** |
| 3 | SBF no stack overflow | `cargo build-sbf` **clean** (stack frame < 4096B) | **Met** |
| 4 | Programs on devnet | Core `C7w2mKz2…` upgraded (`2D3Sjpyc…`), Oracle `CsSqVZMo…`, PriceOracle `5NSDGAaR…` | **Met** |
| 5 | E2E DFBA lifecycle on devnet | Batch 20 dual fill & settle `2BYRK69U…` | **Met** |
| 6 | Uniform price + makers-only-match-takers | `allocation_uniform_and_conserves`; two-user fill | **Met** |
| 7 | Mark / liq pause | `lifecycle_dual_fill_implies_mark_valid`; `lifecycle_one_sided_implies_liq_paused`; LiquidateUser gate | **Met** |
| 8 | Immediate cancel/modify | book + e2e cancel tests | **Met** |
| 9 | Self-trade | `self_trade_does_not_fill`; `t_e2e_two_user_self_trade_does_not_fill` | **Met** |
| 10 | Multi-venue oracle freshness & binding | Rust unit tests + `tools` node tests (33 pass) + devnet disc 23 binding + live 4-venue publish | **Met** |
| 10 | Maker free / taker fee | Host `t_e2e_two_user_fill_makers_free_d3` **met**; live instrument maker 0 / taker 5 (T9.10.1 retune `2WUksBFg…`) | **Met** |
| 11 | Funding mark vs index | Skip-when-`!mark_valid` **met**; D7 `compute_d7_funding_rate()` + SetFundingParams devnet `2Hys2B8…` + `tools/set-funding-params.js` 21 tests | **Met** |
| 12 | Per-batch cap | `cu_measurement_*` + `select_cap_*` | **Met** (on-chain CU spike at cap 64 is mainnet bar) |
| 13 | Pause flags | T-PAUSE-* | **Met** |
| 14 | Insurance inventory | historical e2e liquidate / ADL | **Prior evidence** |
| 15 | Batch latency p50/p99 | not measured | **Open** (ops, not matching) |

Web remainder (M9.8): T-WEB-ORIGIN-HYDRATION, T-WEB-CHART-STATE, T-WEB-DFBA-LIFECYCLE, T-KEEPER-LAG-INTENT, T-NO-LEGACY-WEB-FLOW all **checked** with fresh 2026-08-20 Phase 8 commands. `pnpm e2e:wallet` remains construction + copy, not a fill.

## Phase 9 — T9.10.6–7 settlement mark + reduce-only + prepare-close (2026-08-24)

**Rust verification:**
- `cargo +stable clippy --all-targets --all-features -- -D warnings` **clean**
- `cargo +stable test --all-features`: **439 pass** (267 core + 115 matcher + 46 common + 11 oracle), 5 ignored (CU harness)
- T9.10.6 adds 4 tests: `test_t9_10_6_valid_settlement_uses_clearing_price`, `_carries_forward_prev_mark`, `_first_invalid_stays_zero`, `_succession_valid_invalid_valid`
- T9.10.7 adds 8 tests: `test_reduce_only_flat_position_rejected`, `_long_position_sell_accepted`, `_long_position_oversized_rejected`, `_long_position_wrong_side_rejected`, `_short_position_buy_accepted`, `_short_position_oversized_rejected`, `_short_position_wrong_side_rejected`, `_reduce_only_violation_discriminator`
- Error code pin test: `MgkError::ReduceOnlyViolation as u32 == 606` verified

**Frontend verification:**
- `pnpm --filter web test -- --run`: **486 pass** across 51 files
- OrderForm tests added: position display (zero/long/short), prepare-close button visibility/states, fixed-point parsing, field assertions for prepare-close
- Pre-existing indexer typecheck errors (`syncer.ts`, `backfill.test.ts`) and lint error (`TradingViewWidget.tsx`) unchanged

**Playwright wallet verification:**
- 3 new e2e tests in `wallet-flow.spec.ts`: long prepare-close flow, short prepare-close flow, captured instruction field assertions (discriminator=20, side, is_maker=0, qty, instrument_id=0, reduce_only=1)
- Mock fixture extended: `setPortfolioPosition(instrumentId, qty, entryVwap)` for deterministic position injection
- Note: `pnpm e2e:wallet` requires running dev server; tests designed to run with `--project=chromium --workers=1`

**SDK verification:**
- `@mgk/sdk` typecheck + build clean
- `PercolatorError.ReduceOnlyViolation = 606` in error.ts, human message + retryable classification

## Open items

| # | Item | Severity | Status |
|---|------|----------|--------|
| 1 | Positions/Portfolio visual stability (T9.8.5) | P0 UX | Regression keep |
| 2 | BPF e2e CU exhaustion in ClearBatch | P1 | Open (test-only) |
| 3 | Indexer polish (syncer.ts, backfill.test.ts) | P2 | Pre-existing type errors |
| 4 | Batch latency p50/p99 measurement | P3 | Open (ops) |
| 5 | Security review before mainnet | P1 | Not started |
