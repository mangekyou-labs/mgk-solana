# mgk-frontend

Frontend subsystem of the **mgk** protocol — a fully on-chain perpetual futures DEX on Solana (commit-reveal CLOB, deterministic Fisher-Yates shuffle). See [`docs/ai/design/2026-06-16-feature-mgk-frontend.md`](../docs/ai/design/2026-06-16-feature-mgk-frontend.md) for the full design.

## Layout

```
mgk-frontend/
├── pnpm-workspace.yaml
├── package.json              # root scripts: dev / build / lint / test
├── apps/
│   ├── web/                  # Next.js 16 SPA, App Router, port 3000
│   │   ├── app/              # trade, portfolio, marketing pages
│   │   ├── components/       # chart, trade, orderform, portfolio, common
│   │   ├── lib/              # hooks, stores, config, feeds
│   │   └── e2e/              # Playwright smoke tests
│   └── indexer/              # Fastify 5 + SQLite, port 4000
│       └── src/              # subscriber, decoder, aggregator, store, rest, ws
└── packages/
    └── sdk/                  # @mgk/sdk: Pinocchio instruction encoders, PDA derivation, state decoders
```

## Prereqs

- Node 22+
- pnpm 9 (`corepack enable && corepack prepare pnpm@9.15.0 --activate`)

## Environment

| Variable | Default | Notes |
|---|---|---|
| `NEXT_PUBLIC_RPC_URL` | `https://api.devnet.solana.com` | Solana RPC endpoint |
| `NEXT_PUBLIC_CORE_PROGRAM_ID` | `CzWqtmcrm6sivjNHfNWhoMJfxP7ibm8KqXXjZpkswXy5` | mgk-perps-core on devnet |
| `NEXT_PUBLIC_MATCHER_PROGRAM_ID` | `AU4EKQAQupEbMWPK9fuJA7CZqfcjM5Bpgf6Ew9Y7o2FF` | mgk-perps-matcher on devnet |
| `NEXT_PUBLIC_ORACLE_PROGRAM_ID` | `6M9eEiDKy8imbDi44ZqquyfknNbveRjD4j9VnvYaHtmA` | mgk-oracle on devnet |
| `NEXT_PUBLIC_INDEXER_URL` | `http://localhost:4000` | Indexer REST + WS base URL |
| `NEXT_PUBLIC_HERMES_URL` | `https://hermes.pyth.network` | Pyth Hermes API |

## Common commands

```sh
# from mgk-frontend/
pnpm install                   # install all workspaces
pnpm dev                       # run web (:3000) + indexer (:4000) in parallel
pnpm -F web dev                # web only
pnpm -F indexer dev            # indexer only

# tests
pnpm test                      # all packages (web + sdk + indexer)
pnpm -F @mgk/sdk test          # SDK unit tests (151)
pnpm -F web test               # web unit tests (419)
pnpm -F indexer test           # indexer tests (28)

# typecheck
pnpm typecheck                 # all packages (tsc --noEmit)

# build
pnpm build                     # all packages
pnpm -F web build              # Next.js production build

# e2e
pnpm -F web e2e                # Playwright smoke tests (requires dev server)
```

## Architecture

```
Browser (Next.js 16 SPA)
  │
  ├── @mgk/sdk ──── Pinocchio instruction encoders (raw byte), PDA derivation, BPF state decoders
  │
  ├── Direct RPC ── getMultipleAccountsInfo (portfolio, batch, book) every 2-5s
  │
  ├── Wallet ────── @solana/wallet-adapter (Phantom, Solflare)
  │
  └── Indexer ───── REST (/api/*) + WebSocket (/ws) for candles, fills, batch state
         │
         └── Solana logs subscriber → SQLite → candle aggregation → fan-out WS
```

**Design decisions:**
- **No Anchor / IDL** — Pinocchio programs use single-byte discriminators. SDK hand-rolls byte layouts.
- **Direct RPC** for freshness-critical reads. Indexer for history and WS fan-out.
- **TradingView widget** for chart (`BINANCE:SOLUSDT` for devnet; Pyth data feed deferred to post-v1).
- **Zustand** stores for ephemeral UI state; React Query for indexer REST.
- **Client-side commit-reveal**: salt + hash computed in browser, persisted to localStorage across refresh.

## Devnet deployment

| Program | ID |
|---|---|
| mgk-perps-core | `CzWqtmcrm6sivjNHfNWhoMJfxP7ibm8KqXXjZpkswXy5` |
| mgk-perps-matcher | `AU4EKQAQupEbMWPK9fuJA7CZqfcjM5Bpgf6Ew9Y7o2FF` |
| mgk-oracle | `6M9eEiDKy8imbDi44ZqquyfknNbveRjD4j9VnvYaHtmA` |

## Relationship to the on-chain protocol

The frontend is a **consumer** of the on-chain mgk programs (`../programs/`). It does not import Rust source — the SDK hand-rolls the BPF layout table from the design doc. See [`../docs/ai/design/2026-06-16-feature-mgk-frontend.md`](../docs/ai/design/2026-06-16-feature-mgk-frontend.md) for the on-chain account layouts and Pinocchio instruction byte format.

## CI

[![mgk-frontend CI](../.github/workflows/mgk-frontend-ci.yml)](../.github/workflows/mgk-frontend-ci.yml) — SDK build + web typecheck/lint/test/build + Playwright E2E on push/PR to main.
