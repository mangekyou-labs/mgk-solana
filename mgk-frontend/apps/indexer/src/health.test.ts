import { describe, expect, it } from 'vitest';
import { classifyHealth, formatHealthResponse, type HealthCheckParams } from './rest/health.js';
import { createHealthTracker } from './healthTracker.js';

describe('health classification', () => {
  const baseHealthyParams: HealthCheckParams = {
    sqliteWritable: true,
    rpcReachable: true,
    rpcSlot: 1000,
    processedThroughSlot: 1000,
    lastSuccessfulSyncAt: Date.now() - 2000, // 2s ago
    lastSyncErrorAt: null,
    subscriptions: { core: true, matcher: true },
    lastHeartbeat: Date.now() - 1000, // 1s ago
    lastBatch: { batchId: 1, phase: 0, ts: Date.now() },
    now: Date.now(),
  };

  it('classifies warming when bootstrap/cursor is incomplete (legacy path)', () => {
    const status = classifyHealth({
      ...baseHealthyParams,
      processedThroughSlot: null,
    });
    expect(status).toBe('warming');
  });

  it('uses tracker snapshot status when provided', () => {
    const tracker = createHealthTracker({ now: () => Date.now() });
    tracker.recordReconciliation(1000);
    const snap = tracker.snapshot(1000);
    expect(classifyHealth({ ...baseHealthyParams, trackerSnapshot: snap })).toBe('healthy');
  });

  it('classifies healthy when lag <= 10, subscriptions active, sync within 15s', () => {
    // 0 lag
    expect(classifyHealth({ ...baseHealthyParams, rpcSlot: 1000, processedThroughSlot: 1000 })).toBe('healthy');
    // 10 lag (boundary)
    expect(classifyHealth({ ...baseHealthyParams, rpcSlot: 1010, processedThroughSlot: 1000 })).toBe('healthy');
  });

  it('classifies degraded when lag is 11 to 50 slots', () => {
    // 11 lag (boundary)
    expect(classifyHealth({ ...baseHealthyParams, rpcSlot: 1011, processedThroughSlot: 1000 })).toBe('degraded');
    // 50 lag (boundary)
    expect(classifyHealth({ ...baseHealthyParams, rpcSlot: 1050, processedThroughSlot: 1000 })).toBe('degraded');
  });

  it('classifies degraded when a subscription is down', () => {
    expect(classifyHealth({
      ...baseHealthyParams,
      subscriptions: { core: false, matcher: true },
    })).toBe('degraded');

    expect(classifyHealth({
      ...baseHealthyParams,
      subscriptions: { core: true, matcher: false },
    })).toBe('degraded');
  });

  it('classifies degraded when latest scan failed while a recent successful checkpoint remains', () => {
    const now = Date.now();
    expect(classifyHealth({
      ...baseHealthyParams,
      now,
      lastSuccessfulSyncAt: now - 5000,
      lastSyncErrorAt: now - 1000, // error after success, but still within 15s
    })).toBe('degraded');
  });

  it('classifies critical when lag exceeds 50 slots (legacy path)', () => {
    // 51 lag (boundary)
    expect(classifyHealth({ ...baseHealthyParams, rpcSlot: 1051, processedThroughSlot: 1000 })).toBe('critical');
    // 200 lag
    expect(classifyHealth({ ...baseHealthyParams, rpcSlot: 1200, processedThroughSlot: 1000 })).toBe('critical');
  });

  it('classifies critical when SQLite is not writable (legacy path)', () => {
    expect(classifyHealth({
      ...baseHealthyParams,
      sqliteWritable: false,
    })).toBe('critical');
  });

  it('classifies degraded when RPC is not reachable (legacy path)', () => {
    expect(classifyHealth({
      ...baseHealthyParams,
      rpcReachable: false,
    })).toBe('degraded');
  });

  it('classifies degraded when worker heartbeat exceeds 15 seconds (legacy path)', () => {
    const now = Date.now();
    expect(classifyHealth({
      ...baseHealthyParams,
      now,
      lastHeartbeat: now - 16_000, // 16s ago
    })).toBe('degraded');
  });

  it('clamps negative slot lag to zero', () => {
    const response = formatHealthResponse({
      ...baseHealthyParams,
      rpcSlot: 990,
      processedThroughSlot: 1000,
    });
    expect(response.slotLag).toBe(0);
  });

  it('provides backwards-compatible fields and does not leak secrets', () => {
    const response = formatHealthResponse(baseHealthyParams);
    expect(response.ok).toBe(true);
    expect(response.status).toBe('healthy');
    expect(response.processedThroughSlot).toBe(1000);
    expect(response.latestIndexedSlot).toBe(1000); // compatibility alias
    expect(response.sqliteWritable).toBe(true);

    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain('http');
    expect(serialized).not.toContain('keypair');
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('private');
    expect(serialized).not.toContain('apiKey');
  });

  it('includes lastReconciledSlot, lastSuccessfulPollAt, and backfill in response', () => {
    const tracker = createHealthTracker({ now: () => Date.now() });
    tracker.recordReconciliation(5000);
    tracker.updateBackfill({ state: 'completed', slotsScanned: 100, fillsInserted: 5 });

    const snap = tracker.snapshot(5002);
    const response = formatHealthResponse({ ...baseHealthyParams, trackerSnapshot: snap });

    expect(response.lastReconciledSlot).toBe(5000);
    expect(response.lastSuccessfulPollAt).not.toBeNull();
    expect(response.backfill.state).toBe('completed');
    expect(response.backfill.slotsScanned).toBe(100);
    expect(response.backfill.fillsInserted).toBe(5);
  });

  it('computes slotLag from lastReconciledSlot when tracker is provided', () => {
    const tracker = createHealthTracker({ now: () => Date.now() });
    tracker.recordReconciliation(990);

    const snap = tracker.snapshot(1000);
    const response = formatHealthResponse({
      ...baseHealthyParams,
      rpcSlot: 1000,
      processedThroughSlot: 1000, // legacy: 0 lag
      trackerSnapshot: snap,
    });

    // slotLag computed from lastReconciledSlot (990), not processedThroughSlot (1000)
    expect(response.slotLag).toBe(10);
  });

  it('falls back to legacy slotLag when no tracker is supplied', () => {
    const response = formatHealthResponse({
      ...baseHealthyParams,
      rpcSlot: 1000,
      processedThroughSlot: 995,
    });
    expect(response.slotLag).toBe(5);
  });

  it('includes default backfill metadata when no tracker is supplied', () => {
    const response = formatHealthResponse(baseHealthyParams);
    expect(response.backfill).toEqual({
      state: 'idle',
      completedAt: null,
      slotsScanned: 0,
      txsMatched: 0,
      fillsInserted: 0,
      batchesInserted: 0,
    });
  });
});
