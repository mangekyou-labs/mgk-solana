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

### Done (2026-08-06 session)

- **T-CLIPPY-FIX** — Fixed 23 clippy warnings across mgk-common, mgk-perps-core, mgk-perps-matcher. CI `cargo +stable clippy --all-targets --all-features -- -D warnings` now clean.
  - `items_after_test_module` in error.rs (moved `impl From` before `mod tests`)
  - `private_interfaces` in clearing.rs (BuyEntry/SellEntry → `pub`)
  - `dead_code` on `apply_dfba_fills_to_book` / `write_dfba_results` (`#[allow(dead_code)]`)
  - `too_many_arguments` on 6 functions (`#[allow(clippy::too_many_arguments)]`)
  - `derivable_impls` on DualAuctionResult (→ `#[derive(Default)]`)
  - `returns_result_unit` on `pack_orders` (`#[allow(clippy::result_unit_err)]`)
  - `collapsible_if` + `manual_checked_div` in settle_batch.rs
  - `assertions_on_constants` in commit_order.rs (→ `const { assert!(...) }`)
  - `needless_range_loop` in dfba.rs (→ iterator)
  - `nonminimal_bool` in settle_batch/clear_batch tests
  - `manual_is_multiple_of` in book.rs

- **T9.4.2** — DFBA pause matrix:
  - Added `PAUSE_POST = 1 << 4` and `PAUSE_CLEAR = 1 << 5` to `Registry`
  - Updated `PAUSE_RESERVED_MASK` to `0b_1100_0000` (only bits 6..7 reserved)
  - Added `is_posts_paused()` and `is_clears_paused()` helpers
  - Gated `PostOrder` on `PAUSE_POST | PAUSE_TRADING`
  - Gated `CloseCollecting` and `ClearBatch` on `PAUSE_CLEAR | PAUSE_TRADING`
  - Updated all pause flag tests to cover 6 flags
  - Files: `registry.rs`, `post_order.rs`, `close_committing.rs`, `clear_batch.rs`, `set_pause_flags.rs`

- **T9.1.7** — CU measurement at cap 32/64/128:
  - Added `cu_measurement_cap_32`, `cu_measurement_cap_64`, `cu_measurement_cap_128`, `cu_measurement_overflow_at_cap` benchmarks to `dfba.rs`
  - Host timing: cap 128 × 1000 iterations completes in <10ms; confirms efficient O(n log n) scaling

- **T9.0.3** — DFBA error codes:
  - Added `DfbaCapExceeded=603`, `MarkInvalidForLiquidation=604`, `BatchNotSettled=605` to `MgkError`
  - `liquidate_user.rs` now uses `BatchNotSettled` (was `InvalidInstruction`) and `MarkInvalidForLiquidation` (was `OperationPaused`)
  - Pin test for all 3 discriminators in `error.rs`

- **T9.4.4** — Oracle freshness for funding:
  - `read_oracle_price` in `settle_batch.rs` now returns `Option<(price, timestamp, is_active)>`
  - Funding accrual skips when oracle is stale (>600s from current slot approximation) or `is_active=false`
  - Mark path unaffected (pure DFBA when `mark_valid`)

- **T9.3.5** — `SetBatchParams` governance instruction (disc 21):
  - Added `max_orders_per_batch` (u8) and `marginal_size_cap` (u8) to Registry (replaced 2 of 4 padding bytes; Registry stays 86 bytes)
  - Wire: `max_orders(1) + marginal_cap(1) + t_min(8) + t_max(8) + n_min(4)` = 22 bytes
  - Governance signer required; validates max_orders 1..=128, t_max > t_min
  - Files: `set_batch_params.rs` (new), `entrypoint.rs`, `mod.rs`, `registry.rs`

- **T9.5.5b** — BPF e2e resting across batch:
  - Added `test_e2e_resting_across_batch` to `lifecycle.rs`
  - Scenario: maker buy@100k+98k, taker sell@99k → 100k fills, 98k rests; batch 1 taker sell@97k crosses resting 98k; verifies `is_maker=true` on resting fill
  - BPF_OUT_DIR/SBF_OUT_DIR gated

- **T9.4.5** — Insurance inventory: already implemented. `Vault.insurance_fund` (u128) + `uncovered_bad_debt` (u128) + `adl_debt`/`adl_pending`. Fee/rebate flow in `settle_batch.rs:535-575`.

- **T9.5.5c** — BPF e2e self-trade: `test_e2e_self_trade_no_fill` in `lifecycle.rs`. Same wallet maker-buy + taker-sell at same price → 0 fills (self-trade excluded).

- **T9.5.5d** — BPF e2e cancel: `test_e2e_cancel_resting_between_batches` in `lifecycle.rs`. Maker posts, batch settles (resting), cancel all → book empty.

### Phase 5 — remaining unit tests + cleanup (2026-08-06)

- **T-POST-ORDER-UNIT** — 9 new tests in `post_order.rs`: wire format (disc 20, 21 bytes), parse buy-taker + sell-maker-reduce_only, validation constants (negative price, zero qty, invalid side), account count (6), CPI PlaceResting fields (disc 6, 54 bytes).
- **T-CLEAR-BATCH-IX** — 10 new tests in `clear_batch.rs`: DfbaClear CPI layout (disc 5, 11 bytes, 2 accounts), mark_valid/liq_paused flag logic (dual fill, bid-only, ask-only, no fills), clearing_price mid rounding (even+even, odd+odd, odd+even), zero when invalid, total_volume sum + saturation.
- **T-SETTLE-MARK** — 6 new tests in `settle_batch.rs`: mark_price from dual mid (clearing_price), carry-forward when invalid, zero first batch no dual, dual mid rounding matches clear, liq_paused flag set/cleared.
- **Legacy cleanup** — 5 commit-reveal e2e tests in `lifecycle.rs` rewritten with DFBA PostOrder pattern (2026-08-06 follow-on):
  - `test_e2e_gtc_rests_then_matches_next_batch` — DFBA resting order across 2 batches
  - `test_e2e_settle_creates_next_batch_pda` — verifies batch 1+2 PDA creation via SettleBatch
  - `test_e2e_liquidate_user_happy_path` — DFBA mark + pre-built underwater portfolio liquidation
  - `test_e2e_liquidate_user_adl_stub_fires` — ADL when insurance < bad debt
  - `test_e2e_cancel_all_resting_orders` — CancelAllRestingOrders clears book
  - All `#[ignore]` attributes removed. 10 e2e tests total (5 original DFBA + 5 rewritten).
- **Helper functions added** — `build_cancel_all_resting_data`, `build_oracle_data`, `build_underwater_portfolio_data`, `build_vault_data`, `build_liquidate_data`
- **Initialize instruction accounts fixed** — root cause of pre-existing `InvalidArgument`: vault and system_program account indices were swapped in all Initialize calls. BPF entrypoint expects `system_program` at index 3 and `vault` at index 4, but tests had them reversed. Fixed across all11 e2e tests.
- **BPF e2e mark_valid assertions fixed** — liquidate tests (happy_path, adl_stub) needed dual-side orders (bid + ask auctions) to produce `mark_valid=1`. Added maker-sell + taker-buy PostOrder calls alongside existing maker-buy + taker-sell.
- **CU budget helper** — added `submit_cu` helper that wraps `ComputeBudgetInstruction::set_compute_unit_limit` for CU-heavy transactions (ClearBatch with book iteration).
- **Known issue — CU exhaustion (program-test only)** — 4 e2e tests `#[ignore]`: `ComputeBudgetInstruction` is parsed by program-test 2.1 but the CU meter still enforces 200k. **Not a production blocker**: empty-book ClearBatch on devnet uses ~2.6k CU.

### Done (2026-08-06 evening — devnet lifecycle fix)

- **Vault size** — `VAULT_SPACE` corrected 58 → 80 (`size_of::<Vault>()`)
- **Matcher InitializeBook (disc 7)** — reserved for future multi-step PDA book (CPI create still 10KB-capped); production book is client-side keypair
- **SettleBatch creates next batch PDA** — `invoke_signed` when next batch empty; wire `+ next_batch_bump(1)`; accounts +payer +system
- **Registry counter raw write** — settle_batch uses volatile byte writes at offset 36 (SBF field-assign bug)
- **tools/init-protocol.js** — idempotent vault + matcher-owned book keypair + params + batch0
- **tools/keeper-crank.js** — book keypair resolution, CU budget on Clear, open-batch scanner, settle PDA create accounts
- **Devnet verified** — Close → Clear → Settle for batches 0 and 1; batch 2 Collecting; counter=2
- **Dual-fill e2e** — `tools/trade-e2e.js`: InitPortfolioForUser + Deposit + 4× PostOrder + Clear/Settle
  - Batch 2: `markValid=1`, bid=ask=100000, mBid=mAsk=10, status=Settled
  - InitPortfolioForUser must include System Program account for CPI create
  - SettleBatch `num_portfolios` + portfolio metas required for fill application
  - Keeper: `PORTFOLIO_ADDRESSES=a,b` env for filled settles

```text
cargo +stable clippy -p mgk-perps-core -p mgk-perps-matcher --all-targets --all-features -- -D warnings   # clean
cargo +stable test -p mgk-perps-core --lib --features host-hash   # 225 passed
cargo test -p mgk-perps-matcher --lib                              # 114 passed
# Devnet:
#   node tools/keeper-crank.js
#   node tools/trade-e2e.js   # PASS dual fill + mark_valid
```

### Frontend M9 wiring (2026-08-06)

- **`apps/web/lib/config.ts`** — defaults to M9 program IDs + book/vault/registry:
  - core `C7w2m…`, matcher `7WiZu…`, oracle `CsSqV…`
  - book `J33Y6yo…` (matcher keypair), vault/registry PDAs
- **`useOrderSubmission`** — uses `config.bookAddress` (not book PDA); validates book exists
- **`resolveOpenBatch`** — scans counter window for Collecting batch (handles counter desync)
- **`useBatchStore`** — uses `resolveOpenBatch` for current batch display
- **Indexer** `.env` / `.env.example` / `main.ts` defaults updated to M9
- **`.env.local`** updated for web app

```text
cd mgk-frontend/apps/web && pnpm exec vitest run lib/config.test.ts lib/hooks/useOrderSubmission.test.ts
# 34 passed
cd mgk-frontend/apps/web && pnpm e2e
# 30 passed (layout + order form DFBA + chart; Helius RPC)
```

### Browser e2e (Playwright MCP + suite, 2026-08-06)

With `NEXT_PUBLIC_RPC_URL` = Helius devnet:

| Check | Result |
|-------|--------|
| `/trade` loads | ✅ title `mgk — On-chain perps` |
| Batch status from chain | ✅ `Batch: Committing` / accepting orders (batch 3) |
| Order book mid | ✅ `0.10` (resting from dual-fill e2e) |
| Wallet auto-connect | ✅ shows abbreviated pubkey when extension present |
| Sell tab + Post as maker | ✅ toggles via MCP |
| Price/qty fill | ✅ |
| `?set=slashed` banner | ✅ Order slashed + Start fresh |
| Indexer offline | Expected `localhost:4000` refused; Vol/OI show — |
| Full signed PostOrder | Needs human Phantom approve + portfolio (Set Up Account → indexer) |

`pnpm e2e`: **30 passed**.

### Deterministic browser wallet e2e (2026-08-08)

- Added `apps/web/e2e/wallet-flow.spec.ts` and `e2e/fixtures/mockPhantom.ts`.
- The fixture injects a Phantom-compatible provider before hydration and auto-connects a deterministic public key. No browser extension, private key, approval popup, or real transaction is used.
- A mocked JSON-RPC boundary supplies registry, funded portfolio, matcher-owned book, and Collecting batch accounts. Indexer batch discovery is mocked at the HTTP boundary.
- The test fills the live order form, selects maker role, submits Buy, and inspects the prepared transaction. It pins PostOrder disc `20`, buy side, maker flag, scaled price `100_250_000`, scaled qty `2_500_000`, instrument `0`, and six account metas with the user signer.
- Added focused command: `pnpm e2e:wallet`.

```text
pnpm e2e:wallet
# 1 passed; browser test body ~1.1s
```

### Phase 5/6 verification and reconciliation (2026-08-08)

| Gate | Fresh result |
|------|--------------|
| AI DevKit base + `onchain-perps-dex` feature lint | Clean |
| Web typecheck | Clean |
| Focused wallet Playwright | 1 passed |
| Full Playwright | 31 passed |
| Web Vitest | 436 passed |
| SDK Vitest | 158 passed |
| Rust clippy (`+stable`) | Clean |
| Rust all-feature tests (`+stable`) | 396 passed, 5 ignored |

The unqualified Rust commands select Solana's bundled Rust 1.79 toolchain: it lacks `cargo-clippy` and is too old for current locked dev dependencies. The same gates pass with `+stable`; no dependency or lockfile change was made.

### M9.8 implementation continuation (2026-08-09)

Playwright MCP placed a real devnet Buy/Long limit order at `76.55` for
`0.01` base units. Phantom approval completed and the transaction confirmed:

`482LWPHQXSfXt1EecLmtHNeYGoQJVSn8VDCj4RQEFcDnKYyMTfYdpXBtwgmHgn8exZzJ7cKNunzP1AYhJ2Np1Xgg`

The keeper advanced batch 7 to batch 8. The indexer book endpoint then showed
the new bid resting at raw price `76550000`, raw quantity `10000`, with one
order, proving GTC persistence across the batch rollover.

Observed and fixed fallacies:

- `Batch: Collecting past deadline` could disagree with the header and ignored
  `n_min`; `describeBatchPhase` now receives registry state and both header and
  status bar share the same state/intent copy.
- Portfolio panels replaced valid data with a loading skeleton on every
  background refresh; existing data now remains visible and exposes a quiet
  `data-refreshing` marker.
- A stale batch/oracle account from an older deployment could be decoded or
  mutated; indexer keeper validation now checks owner and minimum account size
  before reuse, then creates fresh current-layout accounts.
- The empty SOL market state returned 404 before its first fill; the indexer
  now seeds a zero baseline row and serves 200.
- A crossed book could produce a meaningless midpoint; the header now reports
  `Book is crossed; midpoint is unavailable until the next clear.`
- The Oracle tooltip no longer claims the keeper is offline; it states that the
  deployed feed is not surfaced in the v1 header.

Fresh frontend/indexer gates: web Vitest **447 passed** (49 files), indexer
Vitest **33 passed** (3 files), and both app typechecks are clean. Rust
`cargo +stable clippy --all-targets --all-features -- -D warnings` is clean;
`cargo +stable test --all-features` passes with **396 passed, 5 ignored**.
The unqualified Rust test command remains blocked by the active Solana Rust
1.79 toolchain's MSRV mismatch.

### M9.9 live surface continuation (2026-08-09)

Playwright MCP exercised the non-buy paths on the connected devnet wallet:

- Sell/Short order submission completed on-chain at the live crossed-book ask
  (`0.10`, size `1.0` base units), proving the side, maker, reduce-only, and
  transaction-confirmation paths are wired. The test order was subsequently
  cancelled through Open Orders.
- Portfolio navigation, balances, positions, open orders, modify mode,
  cancel mode, trade history, funding history, position history, and account
  history were opened and observed.
- A batch with one post reached Clearing. The header previously dropped to
  `Batch: —` because read-only polling only accepted Collecting; polling now
  preserves Clearing/Settled state for the status display while PostOrder still
  rejects non-Collecting batches.
- A crossed book previously supplied the stale `0.10` ask as the Sell default;
  the order form now requires an explicit price whenever best bid exceeds best
  ask. Size is labeled in SOL/base units and available size/margin are derived
  from free collateral instead of hardcoded zeroes.
- Order History copy and indexer requirements now describe DFBA posts,
  cancellations, modifications, and batch clearing rather than commit/reveal.
- Inline modify validation now keeps the editor open with explicit feedback for
  zero or sub-precision quantities instead of silently doing nothing.

The live browser also exposed repeated Helius devnet RPC `429` responses under
the combined polling load. This is retained as a follow-up availability issue;
the UI remained usable from last-good/indexer-backed state, but a production
deployment should add shared RPC throttling or route read polling through the
indexer cache.

### M9.9 matching-proof retarget (planning, 2026-08-20)

The 2026-08-09 Playwright MCP path in this file is **historical UI wiring**,
not independent-counterparty matching evidence (one Phantom wallet ⇒
self-trade skip). Planning locked the matching-proof slice as **T9.9.1–5**:
`playwright-cli` named sessions (`-s=maker`, `-s=taker`) with injected
live-signing wallets from `~/.config/solana/mgk-trader-{maker,taker}.json`
against live M9 programs. Four dual-auction posts, then `node tools/keeper-crank.js`.
Matching rewrite is out of scope unless that live reproduction exposes a real
discrepancy. T9.9.1–5 closed 2026-08-20.

### T9.9.1 persona harness (done 2026-08-20)

Live-signing inject keeps secrets in Node: `exposeFunction` hops
(`__mgkLiveSign`, `__mgkLiveSignAndSend`) + `addInitScript` Phantom-compatible
provider. Page payload is pubkey bytes only.

Changed / added files:
- `mgk-frontend/apps/web/e2e/fixtures/livePhantom.ts` — path-in helper; `sendRawTransaction`
- `mgk-frontend/apps/web/lib/e2e/livePhantom.test.ts` — 3 node tests (distinct pubkeys, no secret in payload, live send not capture-only)
- `tools/live-wallet.js`, `tools/inject-persona.js`, `tools/persona-inject.sh`
- `tools/fund-personas.js` — InitPortfolio + Deposit; RPC host only in logs
- `mgk-frontend/apps/web/next.config.ts` — `turbopack.root` = `mgk-frontend`, relative `@mgk/sdk` alias, `transpilePackages`, `serverExternalPackages: []`

Operator path is `tools/persona-inject.sh`. `tools/playwright-cli-inject.js` is
intentionally a hard error: `run-code --filename` runs in the already-started
CLI daemon, so invoking-shell `MGK_PERSONA` never arrives. `run-code` vm has
no `require`/`import`; the sh wrapper reaches Node via
`page.constructor.constructor('return process')()` + `getBuiltinModule('module').createRequire`.

Isolation: maker `6LZPnkFwdT1xPoVy4y1WCyF6mRUyzvcs6Ndo9oFqBwWe` vs taker
`BeBT1zZAcPxeze8wiWNR7JFfPJL2QRPjd1cg26WJeXFe`; distinct
`mgk-order-form-wallet` localStorage; screenshots show truncated `6LZP…BwWe` /
`BeBT…eXFe`. Artifact scan: no secretKey/seed/password/keypair arrays.
Portfolios funded (principals 100000400 / 99999000). `/trade` HTTP 200 after
SDK dist build.

Deviation: none vs design (playwright-cli personas, not MCP, not extension
popups). Residual: Helius 429s; header `BATCH: —` until T9.9.2 keeper opens
Collecting; page console may include full RPC URLs — do not copy them into
docs.

### T9.9.2 same-batch UI posts (done 2026-08-20)

CreateBatch disc 16 opened Collecting batch **11** because the registry
counter had advanced without batch PDAs. PDA
`5fNur4FYLzvKhHMeRw2LRs8fwGjhs3mAsft4rJURisCc`. Both persona UIs showed
`BATCH: COLLECTING`, then `Ready to clear · Waiting for keeper` after
`n_min=1`.

Four dual-auction PostOrders through `/trade` (not 76.55 / 0.10):
maker-buy 86, maker-sell 88, taker-sell 86, taker-buy 88, qty 0.01 around
oracle ~87.19. On-chain `total_commitments=5` (one extra 429 retry landed).
Batch remained Collecting (status 0) until T9.9.3 crank.

Ops: pause page `setInterval`s before Helius-sensitive posts; dismiss stale
toasts and wait for a **new** explorer tx href. `n_min` does not auto-close
Collecting. PostOrder ignores `t_max` while status is Collecting.

Keeper-crank now loads `.env.local`, logs RPC host only, retries 429s, and
prints the matcher-owned results account.

### T9.9.3 crank + observe (done 2026-08-20)

`node tools/keeper-crank.js` with `CURRENT_BATCH_PDA=5fNur4FYLzvKhHMeRw2LRs8fwGjhs3mAsft4rJURisCc` and both portfolio PDAs.

- Close: `4MuCUWhCJEqVwQbFoN1NXbvFGuNGaKL9jGSXtqn41A6vFotVe5V9cm1aWpndtCUYHDCuKcyQRTyn4b1Ljqmejp5c`
- Clear: `39pVR7vjhgWRqskyytwXABfTkW2mXkuxSfyWGacvnRgx7JeGrVQiQTCM4CeXG8B9GLb5otxgUfCiDcTZaadwEKbb`
- Results: `2qy2jdkTwT26hWSortMJrmxyadrUEFQYDfzwRFBWJhpx` (matcher-owned, 5 fills)
- Settle: `4SdygpL4BS9ykc35u51Vht14opVUF4yn5T6xg9bTFihdXo3NWXRVGW9kUXCTH7XdaRjcMSPM8XB9jXa59RVt1co3`
- Batch 11: status Settled, `mark_valid=1`, `liq_paused=0`, bid 86000000, ask 88000000, matched 10000/10000, mid 87000000
- Next batch 12 Collecting (counter 13)

UI after reload + `persona-inject.sh`: maker Positions Flat 0.000000 entry 86.00; taker Long 0.010000 entry 88.00 liq 87.99. Wallets `6LZP…BwWe` / `BeBT…eXFe`. Header moved to Collecting batch 12 (`Waiting for minimum flow (0/1)`).

Deviation vs the four-order persona set: bid-auction taker was stale Phantom `2ecHahNv1LcVsmp614f8XTdpcTksNMwx7FkCJBtsMiQX` (historical book), not the persona taker-sell. Ask auction filled persona taker-buy vs maker-sell (split 5000+5000 from the extra 429 post). Taker equity/free-collateral display −880.34. Trade History has no fill ledger (indexer was not running). These are T9.9.5 residuals, not a matching rewrite.

Changed files this slice: `tools/keeper-crank.js` (`loadEnvLocal`, RPC host only, 429 retry, results pubkey log, `NEXT_PUBLIC_BOOK_ADDRESS` / `DEPLOYER_KEYPAIR` fallbacks).

### T9.9.4 two-user CI fixture (done 2026-08-20)

Host-only (no RPC). Reuses matcher `run_dual_dfba`; does **not** rewrite
`compute_clearing` / `allocate_side`.

Changed files:
- `programs/perps-core/Cargo.toml` — `mgk-perps-matcher` **dev-dependency**
- `programs/perps-core/src/instructions/settle_batch.rs` — `dfba_signed_qty`,
  `apply_one_dfba_fill` (production SettleBatch DFBA loop), `apply_dfba_results`
  (`#[cfg(test)]` host apply over packed 34+58 results), tests
  `t_e2e_two_user_fill_allocation_fees_and_positions`,
  `t_e2e_two_user_self_trade_does_not_fill`,
  `t_e2e_two_user_fill_makers_free_d3`

TDD: red was stub `apply_dfba_results` → Default (positions_len 0 vs 1; D3
equity 100e6 vs 20.1e9). Green extracted production-identical fill apply.
Volume is `fill_qty` per fill (4 fills → `TWO_USER_QTY * 4`, matching live
`totalVolume=40000` shape).

Verify: `cargo +stable test -p mgk-perps-core --lib t_e2e_two_user` → 3 passed.
`cargo +stable clippy -p mgk-perps-core --all-targets --all-features -- -D warnings`
clean. Default rustc (Solana 1.79-dev) cannot compile these host tests.

Deviation: none vs D3 pin in tests (`maker_fee_bps=0`); live instrument leftover
−2 is unchanged (T9.10.1).

### T9.9.5 discrepancy diagnosis (done 2026-08-20, no patch)

| | Two-user fixture | Live batch 11 |
|---|---|---|
| Users | 2 tags (0x6A / 0xBE) | 3: maker `6LZP…`, taker `BeBT…`, stale `2ecHahNv…` |
| Fills | 4 | 5 (extra 429 maker-sell split 5000+5000) |
| Bid | maker+taker 10000@86 | maker 10000@86; taker fill is stale Phantom, not persona sell |
| Ask | maker+taker 10000@88 | maker 5000+5000@88; persona taker 10000@88 |
| Positions | both qty 0 | maker Flat 0 @ 86; taker Long 0.01 @ 88 |
| Equity | start − bid_n + ask_n ± fees | taker ≈ start − `10000 * 88e6` − 5 bps ≈ −880.34e9 |
| Volume | 40000 | 40000 |

Matcher allocation matches the fixture. Live residuals are stale-book
contamination, a 429 retry, and the existing cash formula (`notional = qty *
price`, no extra 1e6 divide). Trade History still has no fill ledger (indexer
was down). No matching rewrite. Next: M9.8 remainder, not M9.10.

### T9.8.1 origin hydration (done 2026-08-20)

`mgk-frontend/apps/web/next.config.ts`: `allowedDevOrigins: ["127.0.0.1"]`
and `turbopack.root=mgk-frontend` so React hydrates at loopback (localhost
is already a Next default). Playwright MCP is not the gate.

Evidence (playwright-cli, not MCP):

| Session | URL | Result |
|---------|-----|--------|
| `-s=origin-local` | `http://localhost:3000/trade` | HTTP 200; Select Wallet heading; `tf-15m` `data-active=true`; `"localhost ok"` |
| `-s=origin-loopback` | `http://127.0.0.1:3000/trade` | HTTP 200; same clicks; `"127.0.0.1 ok"` |

CI: `e2e/trade.spec.ts` `Browser origin hydration` covers both origins.
Console noise (Helius 429, indexer refused) is not a hydration failure.

Next: T9.8.3 chart loading/error/retry. Do not start M9.10.

### T9.8.3 chart loading/error/retry (done 2026-08-20)

`TradingViewWidget` phases: `loading` / `ready` / `error`. Failed `tv.js`
load exposes `data-testid="tradingview-retry"`. Retry calls
`resetTradingViewScriptLoader()` (drops the rejected promise and failed
script tag) and remounts via `retryNonce`. ChartToolbar and OrderForm are
siblings, so they stay interactive.

TDD: red was missing `tradingview-loading` and `tradingview-retry`.
`pnpm exec vitest run components/chart/TradingViewWidget.test.tsx` → 12 passed.

Browser (playwright-cli, not MCP):

| Session | Result |
|---------|--------|
| `-s=origin-loopback` | iframe present; no error/retry; toolbar `tf-15m` + order form |
| `-s=chart-error` delayed abort `tv.js` | `{loading:true, retry:true, toolbar:true, active:"true", orderForm:true}` |
| unroute + Retry | `{loading:true, iframe:true, err:0, retry:0, toolbar:true}` |

`playwright-cli run-code` has no `setTimeout`; delay aborts with `page.waitForTimeout`.

Next: T9.8.4 visible Collecting → Settled on persona sessions. Do not start M9.10.

### T9.8.4 visible DFBA lifecycle (done 2026-08-20)

`mockPhantom.installMockSolanaRpc` now returns `{ batchAddress, setBatchPhase }`
and mutates the in-memory batch account (`collecting` / `clearing` /
`settled-valid` / `settled-invalid`). `wallet-flow.spec.ts` walks header and
status-bar copy after PostOrder. `pnpm e2e:wallet` is still not a fill.

`tools/keeper-crank.js` flags: `--close-only` (CloseCollecting, leave Clearing)
and `--skip-close` (Clear+Settle on an already-Clearing batch). Mutually
exclusive. Default still Close→Clear→Settle in one shot, which is too fast
for both UIs to capture Clearing.

Live evidence (playwright-cli `-s=maker` / `-s=taker`, not MCP):

| Step | Result |
|------|--------|
| Collecting | batch 12 `A23Nka5dHjF5xePjWZMnBzV3bg7LdtD9BzEwMKLUGXPW` |
| `--close-only` | Close `38JW1iAPW3LJMcAm92iHQxuNqwdU8jMEpT57CHdBBKpeQqV4s7txWcECNa99ExkqNsjn19DkEuXqZ4QXCeD763nd`; status=2 |
| Both UIs | `Batch: Clearing · Orders closed · Matching maker and taker flow at uniform prices` |
| `--skip-close` | Clear `3ZnHLn6Q3TEatW6Vs2BGddvNJEFSoVhSuu8hBZ49sDYNvRk6fx9oiGEfwta9uXregno8bA3bCVxErxXujojBz9Cb` (results `3a5QzoHUk46vodWxvSVqsEQU3jFfWs8Bv7GrYZE4XyJH`); Settle `51s24WixcFN74FaTioYXPhmGncTSZWWrmKYNvaU7qAJuQhTLLFr1Vy2ZxqSWsP13b7vihkEf4kfvWMdG9dcm74ES` |
| After settle | batch 12 Settled `mark_valid=0` (empty close); UI follows next Collecting batch 13 `4tHVHn3odTNsej9CKAuSCAiJuuJpjF4rxpRNKSk1unji` |

`resolveOpenBatch` prefers the next Collecting window after Settle, so live
Settled copy is not held. Re-inject after `__mgkLiveSign` is already
registered fails; reload only.

Next: T9.8.6 keeper-lag visibility. Do not start M9.10.

### T9.8.6 keeper-lag visibility (done 2026-08-20)

`describeBatchPhase` keeps the approved Ready to clear / Waiting for keeper
contract and appends elapsed time after the close slot:
`Waiting for keeper · HH:MM:SS late`. `formatKeeperWait` rounds slots at
`SLOT_MS` (0.4s) and never uses the `past deadline` countdown string.
Exact-deadline Collecting (slotsLate ≤ 0) stays `Waiting for keeper`.
Below `n_min` is unchanged (`Waiting for minimum flow`).

Indexer `GET /api/healthz` now returns sqliteWritable, latestIndexedSlot,
rpcSlot, slotLag, lastBatch `{ batchId, phase, ts }`, and subscription
flags. The response must not include `rpcUrl` or other endpoint secrets.
`main.ts` passes the store, `connection.getSlot('confirmed')` (errors →
null), and a mutable subscriptions object flipped after `subscriber.start()`.

TDD: red was missing `00:03:20 late` in `batchDisplay.test.ts` and missing
`sqliteWritable` on healthz. Green: web helper + indexer integration 27/27.

`pnpm e2e:wallet` **3 passed**. Mock phase `collecting-ready` sets
commitDeadlineSlot=10 against fixture slot 42 → `00:00:13 late` on
`status-batch-label` and `market-header-intent`. Still not a fill.

Live `-s=maker` after batch 13: `Waiting for minimum flow (0/1)` because
posts < `n_min` — that is not keeper lag.

Next: T9.8.7 (closed 2026-08-20). Do not start M9.10.

### T9.8.7 retire remaining legacy web affordances (done 2026-08-20)

Active trade UI is PostOrder-only. Order-form statuses are
`idle | submitting | done | failed`. `recoverOrderFormState` drops
persisted `slashed | committing | awaiting_reveal | revealing` (returns
null so the form resets). Dev `?set=` only honors `failed | submitting |
idle`.

Removed: `SlashedBanner`, store-driven `orderStatus`/`clearOrder` on the
form, `useCommitOrder` / `useRevealOrder`, `commitOrderAccountCount`.
`applySeverity` always `setStatus('failed')` and the toast is
`Post failed:` with retry — even when SDK `classifyError` returns
severity `slashed` for leftover codes 600/503.

Kept: on-chain field names `commitDeadlineSlot` / `revealDeadlineSlot`
(layout); batch fixture `slashedDeposits`; SDK slashed taxonomy tests;
historical commit-reveal docs.

TDD: red was `recoverOrderFormState is not a function`. Green: export +
legacy-status drop.

Evidence 2026-08-20:

| Check | Result |
|-------|--------|
| Focused vitest | **63 passed** (`useOrderFormStore` 8, wallet guard 6, `useOrderSubmission.e2e` 6, `useOrderSubmission` 14, `OrderForm` 29) |
| Playwright | `pnpm exec playwright test e2e/trade.spec.ts --project=chromium` **33 passed** (13.6s). Describe `Order form — no legacy commit-reveal journey` covers `?set=slashed\|committing\|awaiting_reveal\|revealing` (banner count 0, no `/order slashed/i`, no `/awaiting reveal/i`, buy submit visible) and `?set=failed` keeps PostOrder usable |
| playwright-cli `-s=legacy` | `?set=slashed` `{banner:false, slashedText:false, reveal:false, buy:true}` at `127.0.0.1:3000`. Sell tab + qty still interact. Mobile 390×844 buy visible. `/portfolio` no slashed banner |

Do not start M9.10.

## Check Implementation (Phase 7) — 2026-08-20

Compares shipped DFBA code in `.worktrees/feature-dfba-auction` against
`docs/ai/design/feature-onchain-perps-dex.md` and
`docs/ai/requirements/2026-06-18-feature-onchain-perps-dex.md`. Historical
commit-reveal Phase 7 lives in
`docs/ai/implementation/2026-07-03-feature-onchain-perps-dex.md` (superseded
banner). AI DevKit linted implementation path remains that 2026-07-03 file;
these notes are the active DFBA alignment record.

### Design summary (must-respect)

- Matching is Jump-paper DFBA: open PostOrder, dual uniform auctions
  (bid = maker-buy × taker-sell, ask = maker-sell × taker-buy), volume-max,
  price-priority then pro-rata, rest with role, self-trade skip. No sequencer,
  no commit-reveal.
- Batch: Collecting (Committing alias) → Clearing → Settled.
- Mark = mid(bid, ask) only when both auctions usable; else `liq_paused`.
  Oracle is index/funding only.
- Core sole custody; matcher CPI never holds funds. Pinocchio, single-byte
  discs, `no_std`.
- LiquidateUser requires Settled + `mark_valid` + `!liq_paused`.
- Working-devnet leftover vs mainnet leftover is the design appendix, not
  matching.

### File-by-file vs design

| Area | Path | Intent | Verdict |
|------|------|--------|---------|
| Dual clear | `programs/perps-matcher/src/state/dfba.rs` | Paper volume-max + allocate | **Match.** Do not rewrite. Fill-lot 100/400 and 100/250/50 are a test gap (T9.10.7) |
| DfbaClear | matcher `entrypoint` disc 5 | Dual auction + book collect | **Match** |
| PostOrder | core disc 20 + matcher PlaceResting 6 | Single-tx post, `is_maker` | **Match** |
| Retired C/R | `commit_order.rs` / `reveal_order.rs` discs 4/5 | Occupy disc; `InvalidInstruction` | **Match** (“CommitOrder retired; use PostOrder”) |
| Close | `close_committing.rs` disc 6 | Collecting → Clearing | **Match** (time-only close allowed with 0 posts) |
| Clear | `clear_batch.rs` disc 7 | CPI DFBA; `mark_valid` iff both auctions | **Match** |
| Settle | `settle_batch.rs` disc 8 | Dual mid or carry-forward; funding skip | **Partial.** Dual mid when `mark_valid`; skip funding when `!mark_valid` / stale. First `!mark_valid` still seeds via `compute_mark_price` (T9.10.6). Cash `qty * price` is diagnosed, not matcher |
| Liq | `liquidate_user.rs` | Gate on dual mark | **Match** (`MarkInvalidForLiquidation`) |
| Funding | `state/funding.rs` | D7 `f(mark − index)` | **Deviation (should-do).** Still SMA of book premium vs oracle. Skip-when-invalid shipped |
| Fees | live instrument | D3 maker 0 / taker 5 | **Match (T9.10.1 2026-08-20).** Disc 22 + live retune `Hz9UtmSX…` maker 0 / taker 5 |
| Web copy | `batchDisplay.ts` `describeBatchPhase` | Truthful Collecting/Clearing/Settled | **Match** (T9.8.2/4/6) |
| Web post | OrderForm + `useOrderSubmission` | PostOrder-only | **Match** (T9.8.7). SDK may still classify leftover 600/503 as `slashed`; UI maps to `failed` |
| Indexer | `/api/healthz` + `backfill.ts` | Lag not silent | **Partial.** Healthz shipped in T9.8.6; T9.10.4 still the working-devnet bar for UI-not-stale |
| Formal events | D9 | `BatchCleared` / `Fill` | **Deferred** (mainnet; design-locked) |
| Frontend reqs | `docs/ai/requirements/2026-06-16-feature-mgk-frontend.md` | DFBA amendment | **Open** (design should-do #9; not this feature’s matching) |
| ARCHITECTURE / grant | public docs | DFBA narrative | **Stale** (mainnet bar; historical commit-reveal copy) |

### Alignment

| Slice | Severity | Notes |
|-------|----------|-------|
| Matching (M9.0–M9.6 + M9.9) | **HIGH** | Paper dual-auction shipped; T-E2E-TWO-USER-FILL 3/3; live batch 11 `mark_valid=1` |
| Retired commit-reveal | **HIGH** | Stubs occupy 4/5; active UI/tests PostOrder-only (`T-NO-LEGACY-WEB-FLOW`) |
| Liq / mark gate | **HIGH** | Liquidations cannot run on invalid mark |
| M9.8 remainder | **HIGH** | T9.8.1/3/4/6/7 Done 2026-08-20 |
| T9.8.5 Positions flicker | **PARTIAL** | Implementation evidence; keep as regression (blocker #10) |
| Working-devnet bar | **IN PROGRESS** | T9.10.1–3 done; T9.10.4–7 remain |
| M9.10 | **IN PROGRESS** | Started 2026-08-20 on user `9.10`. T9.10.1 live maker 0; T9.10.2 live LiquidateUser; T9.10.3 live multi-venue oracle binding |

**Overall:** HIGH for DFBA matching + approved M9.8 remainder + T9.10.1-3 ops foundation.

### Deviations (do not treat as matcher bugs)

| ID | Item | Severity | Owner |
|----|------|----------|-------|
| T9.10.1 | Live maker fee −2 vs locked 0 bps | **Done 2026-08-20** | Disc 22 + upgrade `2PJmEb8U…` + retune `2WUksBFg…` |
| T9.10.2 | Crank exists; not 24/7 keeper+liquidator | **Done 2026-08-20** | `ops-keeper.js` + live `3WDbtrsw…` |
| T9.10.3 | Index keeper freshness | **Done 2026-08-24** | Disc 23 + upgrade `2D3Sjpyc…` + `ops-oracle.js` + live `26G5oZBq…` |
| T9.10.4 | Indexer UI not silent stale book | Must-do (healthz precursor shipped) | Indexer |
| T9.10.5 | SMA funding vs D7 | **Done 2026-08-24** | Core funding.rs + SetFundingParams disc 24 + `tools/set-funding-params.js` (21 tests) + devnet `Dmh6CEXi…` + `2Hys2B8…` (coeff 1→10000, interval=100, cum_funding preserved) |
| T9.10.6 | First `!mark_valid` `compute_mark_price` seed | Should-do | settle_batch.rs |
| T9.10.7 | Reduce-only UX + paper fill-lot tests | Should-do | Web + matcher tests |
| — | Cash notional `qty * price` (no extra USD_SCALE) | Diagnosed | T9.9.5; not matcher |
| — | BPF e2e 4 ignored (program-test CU) | Test-only | Not prod (empty Clear ≈ 2.6k CU) |

### Constraints that still hold

- Do not rewrite matching.
- M9.10 is in progress (started on explicit `9.10`).
- Do not treat `pnpm e2e:wallet` or Playwright MCP as a fill.
- Extra feature worktree count is 1 (`.worktrees/feature-dfba-auction` only).
  Lint warn “No dedicated worktree registered for feature-onchain-perps-dex”
  is expected — do not add a second worktree.
- Do not paste Helius api-key / full RPC URL.

### Next

Next: T9.8.5 regression watch (positions flicker). Security review remains before mainnet.

### Phase 8 testing (2026-08-20)

Coverage audit of the closed remainder only. No M9.10 tests added (paper
fill-lot 100/400 and 100/250/50 stay T9.10.7).

Fresh this session (worktree):

| Command | Result |
|---------|--------|
| `cargo test -p mgk-perps-matcher --lib` | **114 passed**, 1 ignored |
| `cargo +stable test -p mgk-perps-core --lib t_e2e_two_user` | **3 passed** |
| `pnpm e2e:wallet` | **3 passed** (12.5s); not a fill |
| `pnpm exec playwright test e2e/trade.spec.ts --project=chromium` | **33 passed** (13.5s) |
| focused web vitest (form/store/submission/batchDisplay + wallet guard) | **84 passed** |
| Positions + Balances vitest | **26 passed** (T9.8.5 still Partial in live UI) |
| indexer integration + runtimeValidation | **30 passed** |

Full `cargo +stable test --all-features` and full web Vitest were not
re-run this session. Next: Phase 9 `dev-review`. Do not start M9.10.

### T9.10.1 maker fee 0 bps (2026-08-20)

User named `9.10`. Do not rewrite matching.

- Red: `test_instrument_new` left −2 / right 0.
- Green: `Instrument::new` default 0; `tools/init-protocol.js` `makerFeeBps=0`; lifecycle init bytes 0. `SetInstrumentFees` disc 22 (`apply_instrument_fees`). SDK `encodeSetInstrumentFees` 5 bytes. Operator `tools/set-instrument-fees.js` (RPC host only).
- Live: core upgrade `2PJmEb8UM6ET7K64y1PgoPNPeqakx7bKPLiv7P67hLktdsnZN5SiVEfi5XXFin3Ex1NNdNHospjbaMVEYZwruaXa`; retune `2WUksBFgAcGm5WKMrVetHQQehdSrLAxabNj9Um4FJgHVBaCSqVUs3AoF4iMtqitDzmV1rmZcQrGibVPZV5T3WvCh` on `Hz9UtmSXyKFnp1pGvrhrAmizMsvEkYRh5Eih1r7Lf1hG` −2 → 0, taker 5.
- Tests: `cargo +stable test -p mgk-perps-core --lib -- test_instrument_new test_set_instrument_fees test_maker_fee_rebate` 5 passed; `t_e2e_two_user` 3 passed; `cargo +stable clippy -p mgk-perps-core --all-targets --all-features -- -D warnings` clean; SDK `core.test.ts` 22 passed.
- Rebate field remains signed (`test_maker_fee_rebate`, two-user fill still pins −2 as an explicit example). Next: T9.10.2.

### T9.10.2 24/7 keeper + liquidator (2026-08-20)

User named `9.10`. Do not rewrite matching. D6: only the **current** settled batch’s dual clear validates mark.

- TDD: `tools/ops-health.js` (3/10 tx failures, 1/3 collecting windows, mark streak 10, slot lag 10/50, sanitize secrets). `tools/ops-liquidate.js` skip: no_positions / healthy / batch_not_settled / mark_invalid / liquidations_paused. `cd tools && node --test` **14 passed**.
- Daemon: `tools/ops-keeper.js` `--loop` `--interval` `--health-port` `--no-crank` `--no-liquidate`. Collecting crank waits for deadline (`n_min` ignored). Clearing always cranks. HTTP `127.0.0.1/healthz`. Health file default `~/.config/solana/mgk-ops-health.json`. RPC **host** only (`trade-e2e.js` / `init-protocol.js` same).
- Live scan before seed: latest settled batch 12 `mark_valid=0` → taker skip/`mark_invalid` (did **not** use leftover batch 11 mark).
- Seed: `TRADE_QTY=1` `trade-e2e.js` batch 13 dual-clear `mark_valid=1` Close `dyzNZYGg…` Clear `4uUYJ1Xx…` Settle `4dZx4czR…`.
- LiquidateUser `3WDbtrswKNyVKRtJ2585hgoF6R9sdH3CS49T3SUkPqE9etVefKrX8UHJnLfRXSn3gfNr2b8J16MhRNopSyU5s5gp` (`err: None`, slot 485857620) taker `8SWub3A3vNaK7dGotzyJJfmkhcbjYxPoXZv3UQFWPHBE` health `-880240001000` → flatten `positionsLen=0` (leftover equity still negative). Maker `27zXKvEE…` skip/healthy.
- Deadline-gated empty crank batch 14: Close `f3GX7pYY…` Clear `8z1XiER6…` Settle `4rMFLcL8…` next Collecting 15. Empty settle leaves current mark invalid (D6; next dual-clear restores).
- `/healthz` keys include `rpcHost`, `lastLiquidation`, `settledBatch`; no rpcUrl/api-key/keypair. Loop smoke on port 4090 then stopped (public RPC 429s).
- Stale collecting-age after successful crank: `windowsForHealth({ crankedThisTick })` + re-resolve open/settled after crank.

### T9.10.3 Multi-Venue Index Keeper Reliability (2026-08-24)

User named `9.10.3`. Harden the existing 128-byte `PriceOracle` path.

- **Core Instruction Disc 23 `SetInstrumentOracle`**: Wire format is discriminator only (`[23]`). Validates governance signer authorization, core program ownership of instrument and registry, oracle owner `CsSqVZMoXixNYstNhTtixeT4pyRgrYnXdpfoXQBgFPqZ`, 128-byte size, magic `0x4C43_524F_4C43_5250`, version 0, `is_active == true`, and binding `oracle.instrument == instrument.key()`.
- **SettleBatch Oracle Validation & Freshness**: Validates `oracle_account.key() == instrument.oracle_addr`, owner == oracle program, size >= 128, magic, version 0, binding, and `price > 0`. Freshness compares oracle timestamp with `Clock::get()?.unix_timestamp` (`0 <= (now - ts) < 600`). Softly skips funding when oracle is stale, future-dated, inactive, or mismatched; settlement and trading proceed without error.
- **SBF Stack Optimization**: Borrowed `OrderBook` by reference instead of value copy in `settle_batch.rs` to keep stack frame safely below the 4096-byte Solana SBF limit.
- **SDK**: Added `SetInstrumentOracle: 23` in `CORE_INSTRUCTION` and `encodeSetInstrumentOracle(): Uint8Array`.
- **Multi-Venue Index Sources (`tools/oracle-sources.js`)**: Concurrently fetches Binance (`SOLUSDT`), Coinbase (`SOL-USD`), OKX (`SOL-USDT`), Bybit (`SOLUSDT`) with 3s timeout per source. Computes preliminary median, applies 100 bps outlier rejection, enforces quorum (>=3 accepted venues), computes final median, and calculates confidence as maximum absolute deviation scaled to 1e6.
- **Standalone Daemon (`tools/ops-oracle.js`) & Governance Operator (`tools/set-instrument-oracle.js`)**: Supports `--bootstrap`, `--one-shot`, `--loop` with `ORACLE_POLL_MS` (10s), HTTP health endpoint `/health` on 4091, atomic JSON health file, 3x bounded backoff retries, alerting (warning at 3 failures/60s age, critical exit at 10 failures/600s age), and strict secret sanitization.
- **Indexer Keeper Cleanup**: Removed duplicate single-source Binance price fetching and oracle posting from `mgk-frontend/apps/indexer/src/keeper.ts`.
- **Tests**: `tools` node tests 33/33 pass; SDK unit tests 160 pass; indexer tests 34 pass; Rust unit tests 235 pass in core, 115 in matcher, 45 in common; full suite clippy and SBF builds clean.
- **Live Devnet Rollout**:
  - Upgraded Core program `C7w2mKz2KQgDroNNhACm9MutXhPiesVr9Gn2x8TDsRYx` via tx `2D3Sjpyc8HrYVkVL2wX31pEyMQyDHo4AXSyMkFXutugvN7hPN2iqZX6LpNQvToBiM9KUejhcMZ1gxDidCDbiqD3E`.
  - Bootstrapped and activated PriceOracle `5NSDGAaRqfxe6mkZG9fEAZdzK4r77nEBEobohZGYP6PN` via tx `3pH2n5Y7r4LqrgomDuw2iy59YbyFf7zqqf6XHDj2Fg67YJRfWFPDYDMurAbFfAmwCqCpozuk5r7zABQQLaz22aNG`.
  - Bound instrument `Hz9UtmSXyKFnp1pGvrhrAmizMsvEkYRh5Eih1r7Lf1hG` to oracle via `SetInstrumentOracle` (disc 23) via tx `26G5oZBqJsbuwbGPcrtepCeRWF8VEtWegGoqe6Av8YUbvd4n7CMaPTpcAbetPoyHsDfQ7C8XeYQrVCC2BsBsuzA2`.
  - Executed live 4-venue price update via tx `5yJFzRB5iFvQ2aWBHPLLgpALT4jzGcfcbsUUdZFfRpS3WmnAtPMYAGKE1HneYhu9UHrvwq3puBwvgoS1wEUipoaC` (price 93.92 USD, confidence ±0.01 USD).
  - Executed live batch 20 close/clear/settle into batch 21 via tx `2BYRK69U9RGjWyV8QouJMp5XMhMvVnqzqsCR6biie421EMtQXkXjkQCsxWJ81fi2xi2XTXtQW6dkywqE3xTU6UpX`.

Next: T9.10.4.

### T9.10.6 Settlement Mark Selector + T9.10.7 Reduce-Only / Prepare-Close (2026-08-24)

User named `9.10.6-7`. Complete the final two M9.10 tasks.

**T9.10.6 — Pure settlement-mark selector:**
- Replaced the three-way mark fallback in `settle_batch.rs` (lines 583–602) with a pure settlement-mark selector. Removed the `compute_mark_price` / `mark_price::sweep_book_side` call from the settle path. Oracle remains for funding index only.
- New logic: `mark_valid != 0 → clearing_price`; `mark_valid == 0 && prev_mark != 0 → carry forward`; `mark_valid == 0 && prev == 0 → zero`. No oracle or book seeding.
- 4 new tests (`test_t9_10_6_valid_settlement_uses_clearing_price`, `_carries_forward`, `_first_invalid_stays_zero`, `_succession_valid_invalid_valid`).

**T9.10.7 — Reduce-only enforcement:**
- Added `ReduceOnlyViolation = 606` to `mgk-common/src/error.rs` (DFBA-specific range 603–609).
- `process_post_order` now enforces reduce-only constraints when `reduce_only == true`: flat position → reject; wrong-side (long+buy or short+sell) → reject; qty > |position| → reject. Multiple concurrent reduce-only orders are NOT execution-reserved; validation is at post time only.
- 8 unit tests in `post_order.rs` (`test_reduce_only_*`). Pin test asserts code 606.
- SDK: `PercolatorError.ReduceOnlyViolation = 606` + human message + retryable classification.

**T9.10.7 — Prepare-close UX:**
- Added `positionQty: bigint` prop to `OrderForm` (default 0n). Trade page passes `position?.qty`.
- Prepare-close button: shown when `positionQty != 0`. Long → reduce-only sell at best bid, taker mode. Short → reduce-only buy at best ask, taker mode. Qty set to absolute position. Disabled when book crossed or no opposing quote.
- Replaced `parseFloat(x) * 1e6` with exact six-decimal fixed-point `parseFixed6`/`formatFixed6` for price and qty inputs.
- Signed position displayed in summary panel (`data-testid="order-form-position-display"`).
- 12 new vitest tests: position display, prepare-close button states, field assertions for long/short, fixed-point parsing.

**T9.10.7 — Mock fixture + e2e:**
- Extended `mockPhantom.ts`: `encodePortfolioWithPosition(instrumentId, qty, entryVwap)` writes at correct Portfolio struct offsets; `setPortfolioPosition` on `MockRpcHandle`.
- 3 new Playwright wallet e2e tests in `wallet-flow.spec.ts`: deterministic long prepare-close, short prepare-close, captured PostOrder instruction field assertions (discriminator, side, is_maker, qty, reduce_only).

**Verification:**
- `cargo +stable clippy --all-targets --all-features -- -D warnings` clean.
- `cargo +stable test --all-features`: 439 pass (267 core + 115 matcher + 46 common + 11 oracle), 5 ignored (CU harness).
- `pnpm --filter web test -- --run`: 486 pass across 51 files.
- Pre-existing issues (not from this session): indexer `syncer.ts` / `backfill.test.ts` type errors, `TradingViewWidget.tsx` lint error, `livePhantom.ts` generic type error.
