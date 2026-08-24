/**
 * In-memory health tracker shared by boot backfill, the subscriber/syncer
 * loop, and the /api/healthz endpoint.
 *
 * Status rules:
 *   warming   – no successful reconciliation yet
 *   healthy   – storage works, reconciliation current, lag ≤ 10 slots
 *   degraded  – RPC temporarily unavailable, poll failed, or lag > 10 slots
 *   critical  – SQLite unavailable, no reconciliation for 120 s, or lag > 50
 *               slots continuously for 120 s
 */

export type IndexerHealthStatus = 'warming' | 'healthy' | 'degraded' | 'critical';

export interface BackfillMetadata {
  state: 'idle' | 'running' | 'completed';
  completedAt: number | null;       // Unix ms
  slotsScanned: number;
  txsMatched: number;
  fillsInserted: number;
  batchesInserted: number;
}

export interface HealthTrackerSnapshot {
  status: IndexerHealthStatus;
  lastReconciledSlot: number | null;
  lastReconciledAt: number | null;       // Unix ms
  lastSuccessfulPollAt: number | null;   // Unix ms
  backfill: BackfillMetadata;
}

const CRITICAL_TIMEOUT_MS = 120_000;
const LAG_DEGRADED_THRESHOLD = 10;
const LAG_CRITICAL_THRESHOLD = 50;

export interface HealthTrackerConfig {
  /** Inject clock for testing. Defaults to Date.now(). */
  now?: () => number;
}

export function createHealthTracker(config: HealthTrackerConfig = {}) {
  const now = config.now ?? (() => Date.now());

  let lastReconciledSlot: number | null = null;
  let lastReconciledAt: number | null = null;
  let lastSuccessfulPollAt: number | null = null;

  // Track consecutive high-lag window for critical escalation
  let consecutiveHighLagSince: number | null = null;

  // Whether SQLite is writable (set externally when detection fails)
  let sqliteWritable = true;

  // RPC reachability (set externally)
  let rpcReachable: boolean | null = null;

  // Backfill metadata
  let backfill: BackfillMetadata = {
    state: 'idle',
    completedAt: null,
    slotsScanned: 0,
    txsMatched: 0,
    fillsInserted: 0,
    batchesInserted: 0,
  };

  function recordReconciliation(slot: number): void {
    lastReconciledSlot = slot;
    lastReconciledAt = now();
    lastSuccessfulPollAt = now();
    rpcReachable = true;
    // Reset high-lag tracking on any successful reconciliation
    consecutiveHighLagSince = null;
  }

  function recordPollSuccess(slot?: number): void {
    lastSuccessfulPollAt = now();
    rpcReachable = true;
    if (slot !== undefined) {
      lastReconciledSlot = slot;
      lastReconciledAt = now();
      consecutiveHighLagSince = null;
    }
  }

  function recordPollFailure(): void {
    rpcReachable = false;
  }

  function setSqliteWritable(writable: boolean): void {
    sqliteWritable = writable;
  }

  function updateBackfill(partial: Partial<BackfillMetadata>): void {
    backfill = { ...backfill, ...partial };
    if (partial.state === 'completed' && backfill.completedAt === null) {
      backfill.completedAt = now();
    }
  }

  function classify(
    currentRpcSlot: number | null,
    currentNow?: number,
  ): IndexerHealthStatus {
    const t = currentNow ?? now();

    // 1. warming — no successful reconciliation yet
    if (lastReconciledSlot === null) {
      return 'warming';
    }

    // 2. critical conditions
    if (!sqliteWritable) {
      return 'critical';
    }

    if (lastReconciledAt !== null && (t - lastReconciledAt) > CRITICAL_TIMEOUT_MS) {
      return 'critical';
    }

    const lag = currentRpcSlot !== null
      ? Math.max(0, currentRpcSlot - lastReconciledSlot)
      : null;

    if (lag !== null && lag > LAG_CRITICAL_THRESHOLD) {
      if (consecutiveHighLagSince === null) {
        consecutiveHighLagSince = t;
      }
      if ((t - consecutiveHighLagSince) > CRITICAL_TIMEOUT_MS) {
        return 'critical';
      }
      return 'degraded';
    } else {
      consecutiveHighLagSince = null;
    }

    // 3. degraded conditions
    if (rpcReachable === false) {
      return 'degraded';
    }

    if (lag !== null && lag > LAG_DEGRADED_THRESHOLD) {
      return 'degraded';
    }

    // 4. healthy
    return 'healthy';
  }

  function snapshot(currentRpcSlot: number | null): HealthTrackerSnapshot {
    return {
      status: classify(currentRpcSlot),
      lastReconciledSlot,
      lastReconciledAt,
      lastSuccessfulPollAt,
      backfill: { ...backfill },
    };
  }

  return {
    recordReconciliation,
    recordPollSuccess,
    recordPollFailure,
    setSqliteWritable,
    updateBackfill,
    classify,
    snapshot,
    /** Expose for direct use by /api/healthz */
    getLastReconciledSlot: () => lastReconciledSlot,
    getLastReconciledAt: () => lastReconciledAt,
    getLastSuccessfulPollAt: () => lastSuccessfulPollAt,
    getSqliteWritable: () => sqliteWritable,
    getBackfill: () => ({ ...backfill }),
  };
}

export type HealthTracker = ReturnType<typeof createHealthTracker>;
