---
phase: monitoring
title: On-Chain Perps DEX — DFBA Monitoring
description: Monitoring contract for the permissionless batch keeper and WebSocket/SQLite indexer.
status: planned
feature: onchain-perps-dex
updated: 2026-08-08
---

# On-Chain Perps DEX — DFBA Monitoring

## Data path

The v1 indexer consumes core and matcher logs over Solana WebSockets, decodes custom single-byte instructions/events, and stores query-oriented rows in SQLite. Account polling for Registry, Batch, Book, and Oracle state complements logs. Every persisted row must include a slot and an idempotency key such as `(signature, event_index)`.

Backfill is required before this phase can be marked complete: restart recovery must page `getSignaturesForAddress`, parse transactions through the same decoder, and upsert through the same idempotent write path used by live ingestion.

## Required metrics

| Metric | Alert condition |
|--------|-----------------|
| Latest indexed slot / RPC slot lag | Warning above 10 slots; critical above 50 slots for 2 minutes |
| Collecting batch age | Warning beyond `t_batch_max_slots`; critical if no close transaction for 3 windows |
| Clear-to-settle latency | Warning above 8 slots; critical above 20 slots |
| Keeper transaction failures | Warning on 3 consecutive failures; critical on 10 |
| Backfill cursor gap | Critical whenever a detected signature/slot range remains unreconciled |
| Duplicate event attempts | Track rate; writes must remain idempotent and not inflate aggregates |
| `mark_valid=false` streak | Product warning after 10 settled batches; liquidations are paused by design |
| RPC/WebSocket reconnects | Warning on sustained reconnect loop or subscription downtime over 60 seconds |

## Health endpoints

The indexer health response should expose:

- process readiness and SQLite writeability;
- current RPC slot, last indexed slot, and lag;
- live subscription status for core and matcher;
- backfill cursor and last successful reconciliation;
- current batch ID/status and last successful Close/Clear/Settle signatures.

No wallet secrets, keypair paths, raw private RPC URLs, or transaction payload secrets may appear in logs or health responses.

## Incident playbook

1. Stop the keeper loop after repeated deterministic instruction errors; keep the read-only indexer online.
2. Compare current Registry/Batch/Book accounts with the last indexed slot.
3. Restart subscriptions from the latest confirmed slot and run signature backfill for the gap.
4. Resume the keeper only after idempotent replay completes and batch state is reconciled.
5. For `mark_valid=false`, do not override the DFBA mark with the oracle. Trading can continue; liquidation remains paused per protocol rules.

## Open implementation work

- Implement and test the signature backfill path (`pipeline.backfill_implemented=false`).
- Persist and expose ingestion lag and keeper-health counters.
- Add golden fixtures for `OrderPosted`, `BatchCleared`, and `Fill` once formal event framing lands.
- Move from local SQLite to PostgreSQL only when query volume or multi-instance writes require it; preserve slot and idempotency constraints.
