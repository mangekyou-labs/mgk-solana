---
phase: implementation
title: mgk Frontend - Implementation Notes
description: Current implementation status, shipped decisions, verification evidence, and remaining gaps for the mgk frontend subsystem
---

# mgk Frontend - Implementation Notes

## Current Status

The active branch is `feature-mgk-frontend`. The frontend subsystem is implemented as a pnpm monorepo under `mgk-frontend/` with:

- `apps/web`: Next.js trade UI, wallet adapter integration, direct RPC reads, order/account actions.
- `apps/indexer`: Fastify REST/WS API, SQLite store, keeper process, portfolio creation queue.
- `packages/sdk`: raw-byte Pinocchio instruction encoders, PDA helpers, state decoders, commitment hash/error helpers.

M1-M5 are effectively complete. M6 remains open for the full browser-wallet transaction E2E, preview deployment, and final polish. The on-chain perps-core/matcher changes live on this same branch because they are prerequisites for the frontend to work on devnet.

## Implementation Update - 2026-07-02 Devnet Phantom Recovery

### Problem

The browser UI built transactions with PDA-derived registry and batch accounts, but the current devnet deployment uses keypair-owned accounts for registry, vault, book, and current batch because of Solana 4.x `createAccount`/PDA limitations in this codebase. Phantom simulation correctly rejected transactions that referenced accounts that did not match the deployed protocol state.

A second devnet issue stranded users: batch #2 was in `Revealing` after the reveal deadline with one unrevealed commitment and zero revealed orders. `ClearBatch` rejects zero revealed orders, so the keeper had no path to create the next committing batch.

### Changes Shipped

| Area | Files | Change |
|---|---|---|
| Web account resolution | `apps/web/lib/onchainAccounts.ts`, `apps/web/lib/config.ts` | Added configured-account and live-indexer resolution for registry/current batch, with PDA fallback only when no deployed keypair address is known. Added `NEXT_PUBLIC_BATCH_ADDRESS`. |
| Order submission | `apps/web/lib/hooks/useOrderSubmission.ts` | Commit/reveal now resolve configured registry + live current batch; commit uses the full account list including portfolio, batch, registry, and system program; hidden portfolio auto-init was removed from order submission. |
| Batch polling | `apps/web/lib/stores/useBatchStore.ts` | Active batch id is `registry.batchIdCounter - 1`; batch address resolves through config/indexer; multiple mounted components share one polling loop instead of resetting each other. |
| Batch display | `apps/web/lib/trade/batchDisplay.ts`, `MarketHeader.tsx`, `StatusBar.tsx`, `BatchTimeline.tsx` | Committing batches past `t_max` but below `n_min` render as `accepting orders`, matching program behavior. Expired reveal/clear phases still warn as past deadline. |
| Indexer live routes | `apps/indexer/src/main.ts`, `apps/indexer/src/rest/routes.ts` | Mounted live keypair-aware book/batch routes. `/api/batch/current` reads registry and current batch from RPC, includes `batchAddress`, and caches live responses for 5 seconds to reduce devnet RPC pressure. |
| Keeper recovery | `apps/indexer/src/keeper.ts` | Keeper tracks/persists the current keypair batch, rejects stale persisted batch-key mismatches, and creates a fresh committing batch when a reveal window expires with zero revealed orders. |
| Docs | `.superstack/build-context.md`, this file, planning/testing docs | Recorded active devnet addresses, recovery behavior, verification evidence, and remaining risks. |

### Live Devnet State After Recovery

| Account | Address |
|---|---|
| Core program | `3jYQ4mpWBBtwrzYQ4zzKhgqVcWWsG2HpXi9oXTBpekja` |
| Matcher program | `AU4EKQAQupEbMWPK9fuJA7CZqfcjM5Bpgf6Ew9Y7o2FF` |
| Oracle program | `6M9eEiDKy8imbDi44ZqquyfknNbveRjD4j9VnvYaHtmA` |
| Registry | `F7zWN2XrVqNDBBYqsYpgxHa6AuPK1aQE33kHwM4f8ayV` |
| Vault | `3FZS8JUn8FGz1CUroGYwrBVHqotaUquJMNnSuBCQxheT` |
| Book | `5nfbjqTYpsnHnmCifdFpwLwajhyb8n6orVvbMbSrGT6w` |
| Recovered active batch | `BQgRjj7fuuuBkmn6RCgAFf3MVDEuLYpMRF5uYznHXUk4` |

The keeper recovery transaction created batch #3 after batch #2 was stranded with zero revealed orders. The web UI loaded `http://localhost:3000/trade?rpc=quicknode` with zero console errors and displayed `Batch: Committing` / `accepting orders`.

### Verified Commands

```sh
npx ai-devkit@latest lint
npx ai-devkit@latest lint --feature mgk-frontend
pnpm -F web test -- --run lib/trade/batchDisplay.test.ts lib/config.test.ts lib/stores/useBatchStore.test.ts lib/hooks/useOrderSubmission.test.ts
pnpm -F web typecheck
pnpm -F indexer typecheck
pnpm -F indexer test -- --run src/integration.test.ts
```

Live/manual evidence:

- Playwright loaded `/trade?rpc=quicknode` with 0 console errors after the final restart.
- Deposit through the browser wallet path previously confirmed on devnet with tx `4tg1nqy9shhBcvvgHxhVTtmr7i2a2Df3ek1eAfyFCCZ2yu5uE99o8ZnPHpuzPXCGYpRZVbRWFEy2VdFrVG6PRHbE`.
- `/api/batch/current` returned live RPC-backed batch JSON including the keypair `batchAddress`.

## Design Deviations

| Deviation | Reason | Status |
|---|---|---|
| Registry, vault, book, and batch accounts are keypairs on devnet, not canonical PDAs | Solana 4.x account creation constraints and deployed-program state | Supported through config/indexer resolution. Long-term cleanup: add canonical matcher `InitializeBook` and revisit PDA account creation. |
| The indexer also runs the keeper in-process | Simplifies devnet demo and lets REST expose the active keypair batch immediately | Acceptable for devnet. Production should split keeper process, add leader election or idempotent locking. |
| Committing can continue past `commit_deadline_slot` while below `n_min` | Current program only gates commits on `BatchStatus::Committing`; keeper waits for both deadline and `n_min` before close | UI now says `accepting orders` for this exact state. Protocol design should decide whether to extend deadlines, close empty batches, or keep current behavior. |
| Full Phantom commit/reveal order approval not completed in this pass | We verified account resolution, live batch recovery, deposit, and UI readiness; order signing still needs a browser-wallet E2E run | T6.1.1 remains open, now partially unblocked. |

## Remaining Implementation Gaps

1. **T6.1.1 - Full browser-wallet tx-flow E2E**: connect wallet, ensure portfolio, deposit, commit, reveal, wait keeper, verify book/fill/open-order state.
2. **Keeper lifecycle serialization**: current zero-reveal recovery helps, but a phase/batch mutex should prevent overlapping crank cycles.
3. **Canonical book initialization**: replace `BOOK_ADDRESS` keypair override with a matcher-owned canonical initialization instruction.
4. **Protocol zero-reveal handling**: on-chain path should explicitly slash/settle unrevealed commitments or otherwise advance the batch, not rely only on off-chain skip recovery.
5. **RPC rate-limit hardening**: QuickNode works better than the previous Infura endpoint; browser/indexer polling is cached, but devnet 429s remain possible under repeated manual reloads.

## Implementation Update - 2026-07-03 Phantom/Open Orders Verification and Matcher Blocker

### Progress

The browser-wallet path advanced from "Phantom preflight blocker" to "matched settlement blocker." Playwright opened `http://localhost:3000/trade`, submitted a sell order through Phantom, confirmed the commit popup and the reveal popup, and did not show the duplicate reveal popup that appeared earlier. After reveal, the UI showed `BATCH: REVEALING` and free collateral moved from `0.3300` to `0.3200`.

To produce a matched batch, a headless counterparty wallet (`ECmGsGAAPJimTwLk3SzkQ39pUQbaBj7U5qgSRRgYSFy`) submitted the buy side in the same batch. Batch #14 (`H6TYpwVtVy4JMjFLFpVAyifHf2RfpcnvopvUii1mzAsM`) reached `totalCommitments=2` and `totalRevealed=2`.

### Changes Shipped

| Area | Files | Change |
|---|---|---|
| Keeper duplicate-clear guard | `apps/indexer/src/keeper.ts` | Returned immediately after `ClearBatch success` so a stale local `Revealing` batch cannot flow into a duplicate clear in the same cycle. If settle sees a missing results account, it clears `state.resultsAddress` instead of retrying a bad address. |
| Open Orders account resolution | `apps/web/components/trade/OpenOrders.tsx` | Reads `config.bookAddress` before falling back to `sdk.deriveBookPda(...)`, matching the current devnet keypair book `5nfbjqTYpsnHnmCifdFpwLwajhyb8n6orVvbMbSrGT6w`. Cancel/modify account metas use the same resolved book address. |
| Bottom tab counts | `apps/web/components/trade/BottomTabs.tsx` | Open Orders and Positions counts are dynamic. The UI no longer hardcodes `Open Orders(0)`. |
| Focused tests | `apps/web/components/trade/OpenOrders.test.tsx`, `apps/web/components/trade/BottomTabs.test.tsx` | Added coverage that OpenOrders fetches the configured book and reports count changes to BottomTabs. |

### Live Devnet Evidence

| Evidence | Result |
|---|---|
| Recovered batch #13 | Restarting the keeper with valid results address `GKjbnJ2rQPevcxaSNJktdyrZYeJMHgTG7QRfo7LsTNjo` settled batch #13 with tx `358LAoWKvs61YXS6eczGzmnDdmNqweu97tkbVkQisew87q8jVpZHizECC4XjsnJHFW6y5uETLhrCwFYyq6SdsPzW` and created batch #14. |
| Bad stale results address | `GRPLE4Z4wTCShduGQaFNyUSrLWCDubVk8fmhRMTJgU1v` was the missing duplicate-clear result account that stranded the keeper before cleanup. |
| Counterparty txs | Deposit `3hwFNYyZDvCAYw29zAStqwptDJpkJ9Y6umK9cb1VPE9Pj2f49AANGngxtkbZrNu4s1CrMHoKTTPTdjvEB749PtoU`; CommitOrder `2JacWtBascQCfsPLdeMgW5G8rcBXDJ9PnGuL3eGqQKaSTLoKigiWfYbi7he1YqrWg8NJp6qqyEvoc86Yc3Xmx3Rz`; RevealOrder `5yV7LoqW5nJURcqqk5kfQrj5nk9MFVNrdqnm8V1A84ND3UFdQ8Vpaxn2jeTMB91fJeAYvfLFjYcYgsfHdD17n1ez`. |
| Open Orders UI | Live Playwright UI showed `Open Orders(2)` with one long row and one short row. |
| Positions UI | `Positions(0)` because matched clearing did not settle. |

### Current Blocker

Keeper `ClearBatch` fails when it CPIs into matcher `ClearAndMatch` for the two-order batch:

```text
Program log: Instruction: ClearBatch
Program log: Instruction: ClearAndMatch
failed: Access violation in program section at address 0x1000118b0 of size 22528
```

The address and size line up with the matcher scratch buffer (`22 * 1024`). The diagnostic `.data.S` experiment proved the code can build and pass native matcher tests when the scratch section is loadable, but Solana deployment rejected the ELF with `read-write data not supported`. Static writable scratch is therefore not a deployable fix. The next implementation should remove the static writable scratch requirement for SBF, then redeploy and re-run the matched browser-wallet flow.

### Implementation Update - 2026-07-07 T6.16 Fix: Heap-Allocated Scratch

**Problem.** All 11 scratch arrays in `programs/perps-matcher/src/instructions.rs` used `#[link_section = ".data.S"] static mut`, creating a writable data section that the SBF loader rejects (`read-write data not supported`). Single-order batches avoided scratch (fast path at line 637); multi-order batches crashed with `Access violation in program section at address 0x1000118b0 of size 22528`.

**Fix.** Replaced all static scratch with heap allocation via Pinocchio's BumpAllocator. The `entrypoint!` macro sets up a 32 KB BumpAllocator at `HEAP_START_ADDRESS` (0x300000000); each BPF instruction gets a fresh bump. Added two helpers:

- `heap_array_fixed<T, N>()` — allocates a zeroed `&'static mut [T; N]` via `alloc_zeroed`
- `heap_value<T>()` — allocates a single zeroed `&'static mut T`

All scratch types (`LimitOrder`, `BuyEntry`, `SellEntry`, `FillReceipt`, `MatchResult`, `PartitionedOrders`, `(Pubkey, u128)`) are valid when zeroed: `Side::Buy = 0`, `OrderType::LimitGTC = 0`, numeric fields = 0, bool = false, `Pubkey::default()` = all-zeros.

**Changes shipped.**

| Area | File | Change |
|---|---|---|
| Heap helpers | `programs/perps-matcher/src/instructions.rs` | Added `heap_array_fixed` + `heap_value` using `alloc::alloc::alloc_zeroed` + `core::alloc::Layout` |
| Scratch helpers | Same file | Rewrote all 11 `scratch_*()` functions from `unsafe { &mut STATIC }` to `heap_array_fixed()?` / `heap_value()?`, returning `Result<_, ProgramError>` |
| Removed | Same file | Deleted all 11 `static mut` arrays (`S`, `SORD`, `SCAP`, `SCBU`, `SCSL`, `SCPR`, `SCFL`, `SCEB`, `SCES`, `SCP0`, `SQUE`) and `scratch_reset()` |
| Entry points | Same file | Removed all 4 `scratch_reset()` calls; added `?` propagation on scratch helper calls in `process_compute_clearing` + `process_clear_and_match` |
| Tests | Same file | Added 3 tests: `test_heap_scratch_returns_writable_zeroed_memory`, `test_heap_scratch_limit_order_array_is_valid`, `test_heap_scratch_two_allocations_do_not_alias` |

**Devnet verification.** Matcher upgraded in-place (program ID `AU4EKQAQ...` unchanged, buffer `2hNyXAyV...`, upgrade sig `Er79dWQs...`). Batch #14 ClearBatch CPI succeeded (tx `5uqVcJAR...`, finalized). Keeper then called SettleBatch — batch #14 went through the full lifecycle (Commit → Reveal → Clear → Settle) and the keeper advanced to batch #15.

**ELF verification.** `llvm-objdump -h` on `target/deploy/mgk_perps_matcher.so` shows only `.text`, `.rodata`, `.data.rel.ro` — no `.bss` or `.data.S` sections.

**Test results.** 88 matcher tests pass (3 new + 85 existing). `cargo build-sbf` clean. Pre-existing clippy warnings in `clearing.rs`/`clob.rs` (too_many_arguments, private_interfaces) are unchanged — not introduced by this fix.

### Verified Commands

```sh
pnpm -F web test -- --run components/trade/OpenOrders.test.tsx components/trade/BottomTabs.test.tsx
pnpm -F web typecheck
cargo test -p mgk-perps-matcher
cargo build-sbf
```

`cargo test -p mgk-perps-matcher` (88 passed) and `cargo build-sbf` (clean, no writable data sections) are now production-verified on devnet: batch #14 settled successfully with the heap-allocated matcher.

## Implementation Update - 2026-07-14 Production Stability

### Problem

After deploying to Vercel (frontend) and Render (indexer), multiple production issues surfaced: `localhost:4000` hardcoded in the production JS bundle, Vercel build failures from `.vercelignore`, 429 rate limits from devnet RPC, keeper unable to close batches on Render, and "committing past deadline" errors.

### Changes Shipped

| Area | Files | Change |
|---|---|---|
| Turbopack env var fix | `apps/web/lib/config.ts` | Replaced `readEnv(name, fallback)` wrapper (dynamic `process.env[name]` lookup) with direct `process.env.NEXT_PUBLIC_*` access. Turbopack can statically replace direct property access but not dynamic lookups. |
| Vercel build fix | `.vercelignore` | Changed `programs/` to `/programs/` — bare pattern matched any `programs/` directory at any depth, excluding `mgk-frontend/packages/sdk/src/programs/` from the build. |
| Indexer batch trust | `apps/web/lib/onchainAccounts.ts` | `fetchIndexerBatchAddress` now returns the indexer's batch address regardless of batch ID mismatch. The indexer tracks the keeper's keypair batch directly; the registry counter may race during transitions. |
| RPC batching | `apps/web/lib/hooks/useOrderSubmission.ts` | Combined registry + portfolio `getAccountInfo` into single `getMultipleAccountsInfo` call. Commit flow: 3 RPC calls → 2. |
| Polling intervals | `useSlotPolling.ts`, `useBatchStore.ts`, `useBookStore.ts`, `usePortfolioStore.ts` | Slot: 1s→3s, Batch: 3s→5s, Book: 3s→5s, Portfolio: 3s→5s. Peak RPC load: ~5 calls/sec → ~2 calls/sec. |
| Indexer cache | `apps/indexer/src/rest/routes.ts` | `/api/batch/current` cache TTL: 5s→30s. 5/6 frontend requests now hit cache instead of RPC. |
| Keeper poll | `apps/indexer/src/main.ts` | Keeper poll interval: 2s→5s. Halves keeper RPC calls. |
| Helius RPC | Vercel `NEXT_PUBLIC_RPC_URL`, Render `RPC_URL` | Both set to `https://devnet.helius-rpc.com/?api-key=...` (10 RPS free tier). Replaces dead QuickNode and rate-limited public devnet. |
| Keeper keypair env var | `apps/indexer/src/keeper.ts` | Added `KEEPER_KEYPAIR` env var — JSON array of secret key bytes. Render's ephemeral filesystem loses `~/.config/solana/id.json` on every redeploy. Falls back to file if env var not set. |
| Vercel production deploy | N/A | `vercel promote` fails (rebuilds from repo root, no `next` package). Use `vercel deploy --prod` from `mgk-frontend/` directory instead. |

### Reverted: Commit Deadline Check

Added `getSlot()` check against `batch.commitDeadlineSlot` in commit flow, then removed. The on-chain `commit_order` does NOT check the deadline — it only checks `batch.status == Committing`. The keeper closes the batch when `past_deadline || enough_commitments`. If `nMin` isn't met, the batch stays Committing past deadline and still accepts commits. Frontend was rejecting valid commits the chain would accept.

### Remaining Issues

| Issue | Severity | Status |
|---|---|---|
| Keeper not closing batch #107 (deadline passed 1.6M slots ago) | **High** | `KEEPER_KEYPAIR` env var deployed on Render; needs verification in Render logs that keeper can sign `CloseCommitting` |
| `/api/markets/0/state` returns 404 | Medium | Market state reads from SQLite; no fills indexed yet |
| `vercel promote` broken | Low | Workaround: `vercel deploy --prod` from `mgk-frontend/` |

### Verified Commands

```sh
pnpm -F web test -- --run  # 436/436 pass
pnpm -F web typecheck       # clean
pnpm -F @mgk/sdk build      # clean
pnpm -F indexer build        # clean
```
