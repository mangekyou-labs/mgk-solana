---
phase: deployment
title: On-Chain Perps DEX — Devnet Deployment
description: Feature-scoped deployment status and release gates for the M9 DFBA programs.
status: deployed-devnet
feature: onchain-perps-dex
updated: 2026-08-08
---

# On-Chain Perps DEX — Devnet Deployment

## Current release

| Program | Devnet ID |
|---------|-----------|
| Core | `C7w2mKz2KQgDroNNhACm9MutXhPiesVr9Gn2x8TDsRYx` |
| Matcher | `7WiZuunbPGciCedsVTguvjezwwzrhmXG5HkdCuHizbNC` |
| Oracle | `CsSqVZMoXixNYstNhTtixeT4pyRgrYnXdpfoXQBgFPqZ` |

The M9 deployment, transaction signatures, initialized accounts, post-deploy fixes, and dual-fill evidence are recorded in [`2026-08-06-devnet-deploy-m9.md`](./2026-08-06-devnet-deploy-m9.md).

## Release gates

Run in this order before another program deployment:

```sh
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-features
cargo build-sbf
```

Then run `tools/init-protocol.js` idempotently, crank at least one complete batch, and run `tools/trade-e2e.js` to confirm a dual clear with `markValid=1`.

## Authority and rollback

- Devnet upgrade authority remains the recorded deployer key; mainnet requires multisig and an independent security review.
- Program IDs are immutable client contracts for this deployment. A rollback uses the last verified SBF artifact under the same upgrade authority, followed by the lifecycle smoke test.
- Do not deploy from the deterministic Playwright wallet test: it mocks signing and RPC intentionally. It verifies browser transaction construction only.

## Current status

No deployment was performed on 2026-08-08. This document provides the feature-named AI DevKit phase record and points to the existing verified M9 deployment evidence.
