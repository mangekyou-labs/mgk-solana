# mgk-frontend build context

## What
On-chain perps DEX (SOL-USD perpetual futures) on Solana devnet.

## Stack
- **Programs**: perps-core (J5fVjwm...), oracle, matcher
- **Frontend**: Next.js, Solana wallet-adapter, React
- **Indexer**: Fastify + WS server + keeper bot
- **RPC**: Helius devnet (CORS-friendly)
- **Wallet**: Phantom

## Key Architecture
- Portfolio accounts pre-created by keeper via `InitPortfolioForUser` (disc 19) using keypairs (Solana 4.x)
- Users call `InitPortfolio` (disc 1) on pre-created accounts
- Commit-reveal order flow with batch cycles
- Keeper posts oracle prices and manages batch state transitions

## Current Blocker: Phantom Simulation Revert

### Root Cause
Deployed perps-core program (J5fVjwm...) lacks `InitPortfolioForUser` (disc 19).

- Deployed version: M8.1 from commit `63fbe8c`
- Latest source: has disc 19 via commit `19efae1`
- Disc 18 (`CreatePortfolio`) IS deployed but requires user wallet signature (keeper can't use it)
- Without disc 19, keeper CANNOT pre-initialize portfolio accounts
- Phantom simulates `InitPortfolio` (disc 1) before account exists → simulation fails → Phantom blocks

### Fix
**Redeploy perps-core to devnet** with latest source. Then:
1. Run `init-protocol.ts` to create fresh registry with new program
2. Set `REGISTRY_ADDRESS` env var
3. Keeper can pre-create portfolios via disc 19
4. UI Init Portfolio succeeds in Phantom simulation

## Key Files Changed
- `useAccountActions.ts` — now calls `POST /api/portfolio/request-creation` before on-chain init
- `keeper.ts` — now drains portfolio creation queue; handles stale batch #0 skip
- `config.ts` — correct program IDs (J5fVjwm...)

## Program IDs (devnet)
- Core: `J5fVjwm96cQxcSqUz4QAmRBT75x7aN9NgG4xcnMmcfSv`
- Matcher: `AU4EKQAQupEbMWPK9fuJA7CZqfcjM5Bpgf6Ew9Y7o2FF`
- Oracle: `6M9eEiDKy8imbDi44ZqquyfknNbveRjD4j9VnvYaHtmA`
- Registry: `CLJesLL7yibGx48bCughkYyzPgYLFHDRMot3jEj1VUE9`