# mgk-frontend

Frontend subsystem of the **mgk** protocol. See [`../docs/ai/planning/2026-06-16-feature-mgk-frontend.md`](../docs/ai/planning/2026-06-16-feature-mgk-frontend.md) for the full plan.

## Layout

```
mgk-frontend/
├── pnpm-workspace.yaml   # pnpm 9 monorepo: apps/* + packages/*
├── package.json          # root scripts: dev / build / lint / test
├── apps/
│   ├── web/              # Next.js 15 SPA (port 3000)
│   └── indexer/          # Fastify + SQLite (port 4000)
└── packages/
    └── sdk/              # TypeScript encoders/decoders for mgk programs
```

## Prereqs

- Node 22+
- pnpm 9 (`corepack enable && corepack prepare pnpm@9.15.0 --activate`)

## Common commands

```sh
# from this directory (mgk-frontend/)
pnpm install                  # install all workspaces
pnpm dev                      # run web (3000) + indexer (4000) in parallel
pnpm -F web dev               # web only
pnpm -F indexer dev           # indexer only
pnpm -F @mgk/sdk test         # SDK unit tests
pnpm build                    # build all workspaces
pnpm lint                     # lint all workspaces
```

## Relationship to the on-chain protocol

The frontend is a **consumer** of the on-chain mgk programs (`../programs/`). It does not import Rust source — the SDK hand-rolls the BPF layout table from the design doc. See [`../docs/ai/design/2026-06-16-feature-mgk-frontend.md`](../docs/ai/design/2026-06-16-feature-mgk-frontend.md) for the on-chain account layouts and pinocchio instruction byte format.
