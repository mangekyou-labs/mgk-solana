import type { FastifyInstance } from 'fastify';
import type { Store } from '../store.js';
import type { SyncerRuntimeHealth } from '../syncer.js';
import type { HealthTracker, HealthTrackerSnapshot, IndexerHealthStatus, BackfillMetadata } from '../healthTracker.js';

// Re-export for consumers
export type { IndexerHealthStatus } from '../healthTracker.js';

export interface IndexerHealthResponse {
  ok: boolean;
  status: IndexerHealthStatus;
  ts: number;
  sqliteWritable: boolean;
  processedThroughSlot: number | null;
  latestIndexedSlot: number | null; // compatibility alias
  rpcSlot: number | null;
  rpcReachable: boolean | null;
  slotLag: number | null;
  lastSuccessfulSyncAt: number | null;
  lastSyncErrorAt: number | null;
  subscriptions: { core: boolean; matcher: boolean };
  lastBatch: { batchId: number; phase: number; ts: number } | null;
  /** --- NEW fields for T9.10.4 --- */
  lastReconciledSlot: number | null;
  lastSuccessfulPollAt: number | null;
  backfill: {
    state: string;
    completedAt: number | null;
    slotsScanned: number;
    txsMatched: number;
    fillsInserted: number;
    batchesInserted: number;
  };
}

export interface HealthCheckParams {
  sqliteWritable: boolean;
  rpcReachable: boolean | null;
  rpcSlot: number | null;
  processedThroughSlot: number | null;
  lastSuccessfulSyncAt: number | null;
  lastSyncErrorAt: number | null;
  subscriptions: { core: boolean; matcher: boolean };
  lastHeartbeat: number | null;
  lastBatch?: { batchId: number; phase: number; ts: number } | null;
  now?: number;
  /** New: if provided, uses tracker snapshot instead of manual classification */
  trackerSnapshot?: HealthTrackerSnapshot;
}

/**
 * Legacy classifier — kept for backwards-compat in older tests that don't
 * supply a tracker. The production path uses the tracker's own classify().
 */
export function classifyHealth(params: HealthCheckParams): IndexerHealthStatus {
  const {
    sqliteWritable,
    rpcReachable,
    rpcSlot,
    processedThroughSlot,
    lastSuccessfulSyncAt,
    lastSyncErrorAt,
    subscriptions,
    lastHeartbeat,
    now = Date.now(),
    trackerSnapshot,
  } = params;

  // If a tracker snapshot is available, use it directly
  if (trackerSnapshot) {
    return trackerSnapshot.status;
  }

  // Legacy classification
  if (processedThroughSlot === null) {
    return 'warming';
  }

  const slotLag = rpcSlot !== null ? Math.max(0, rpcSlot - processedThroughSlot) : null;

  if (!sqliteWritable) {
    return 'critical';
  }

  if (rpcReachable === false) {
    return 'degraded';
  }

  if (lastHeartbeat === null || (now - lastHeartbeat) > 15_000) {
    return 'degraded';
  }

  if (slotLag !== null && slotLag > 50) {
    return 'critical';
  }

  if (slotLag !== null && slotLag >= 11) {
    return 'degraded';
  }

  if (!subscriptions.core || !subscriptions.matcher) {
    return 'degraded';
  }

  if (
    lastSyncErrorAt !== null &&
    lastSuccessfulSyncAt !== null &&
    lastSyncErrorAt > lastSuccessfulSyncAt
  ) {
    return 'degraded';
  }

  if (
    lastSuccessfulSyncAt !== null &&
    (now - lastSuccessfulSyncAt) <= 15_000 &&
    (slotLag === null || slotLag <= 10) &&
    subscriptions.core &&
    subscriptions.matcher
  ) {
    return 'healthy';
  }

  return 'degraded';
}

export function formatHealthResponse(params: HealthCheckParams): IndexerHealthResponse {
  const now = params.now ?? Date.now();
  const status = classifyHealth({ ...params, now });

  // Prefer lastReconciledSlot from tracker for slotLag, fall back to legacy
  const reconciledSlot = params.trackerSnapshot?.lastReconciledSlot ?? params.processedThroughSlot;
  const slotLag =
    params.rpcSlot !== null && reconciledSlot !== null
      ? Math.max(0, params.rpcSlot - reconciledSlot)
      : null;

  const trackerBackfill = params.trackerSnapshot?.backfill;

  return {
    ok: params.sqliteWritable,
    status,
    ts: now,
    sqliteWritable: params.sqliteWritable,
    processedThroughSlot: params.processedThroughSlot,
    latestIndexedSlot: params.processedThroughSlot,
    rpcSlot: params.rpcSlot,
    rpcReachable: params.rpcReachable,
    slotLag,
    lastSuccessfulSyncAt: params.lastSuccessfulSyncAt,
    lastSyncErrorAt: params.lastSyncErrorAt,
    subscriptions: {
      core: params.subscriptions.core,
      matcher: params.subscriptions.matcher,
    },
    lastBatch: params.lastBatch ?? null,
    lastReconciledSlot: params.trackerSnapshot?.lastReconciledSlot ?? null,
    lastSuccessfulPollAt: params.trackerSnapshot?.lastSuccessfulPollAt ?? null,
    backfill: trackerBackfill
      ? {
          state: trackerBackfill.state,
          completedAt: trackerBackfill.completedAt,
          slotsScanned: trackerBackfill.slotsScanned,
          txsMatched: trackerBackfill.txsMatched,
          fillsInserted: trackerBackfill.fillsInserted,
          batchesInserted: trackerBackfill.batchesInserted,
        }
      : {
          state: 'idle',
          completedAt: null,
          slotsScanned: 0,
          txsMatched: 0,
          fillsInserted: 0,
          batchesInserted: 0,
        },
  };
}

export async function healthRoutes(
  app: FastifyInstance,
  options?: {
    store?: Store;
    getRuntimeHealth?: () => SyncerRuntimeHealth;
    tracker?: HealthTracker;
  },
): Promise<void> {
  app.get('/api/healthz', async () => {
    const store = options?.store;
    const sqliteWritable = store ? store.isWritable() : true;
    const runtime = options?.getRuntimeHealth?.() ?? {
      rpcSlot: null,
      rpcReachable: true,
      processedThroughSlot: null,
      lastSuccessfulSyncAt: null,
      lastSyncErrorAt: null,
      lastHeartbeat: Date.now(),
      subscriptions: { core: false, matcher: false },
      lastBatch: null,
      inFlight: false,
    };

    const syncState = store ? store.getSyncState() : {
      processedThroughSlot: runtime.processedThroughSlot,
      lastSuccessfulSyncAt: runtime.lastSuccessfulSyncAt,
      lastSyncErrorAt: runtime.lastSyncErrorAt,
    };

    const tracker = options?.tracker;
    const trackerSnapshot = tracker?.snapshot(runtime.rpcSlot) ?? null;

    return formatHealthResponse({
      sqliteWritable,
      rpcReachable: runtime.rpcReachable,
      rpcSlot: runtime.rpcSlot,
      processedThroughSlot: syncState.processedThroughSlot,
      lastSuccessfulSyncAt: syncState.lastSuccessfulSyncAt,
      lastSyncErrorAt: syncState.lastSyncErrorAt,
      subscriptions: runtime.subscriptions,
      lastHeartbeat: runtime.lastHeartbeat,
      lastBatch: runtime.lastBatch,
      trackerSnapshot: trackerSnapshot ?? undefined,
    });
  });
}
