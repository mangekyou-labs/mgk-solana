import { describe, expect, it } from 'vitest';
import { createHealthTracker } from './healthTracker.js';

describe('healthTracker', () => {
  it('starts in warming state with no reconciliation', () => {
    const tracker = createHealthTracker();
    const snap = tracker.snapshot(1000);
    expect(snap.status).toBe('warming');
    expect(snap.lastReconciledSlot).toBeNull();
    expect(snap.lastReconciledAt).toBeNull();
    expect(snap.lastSuccessfulPollAt).toBeNull();
  });

  it('transitions to healthy after reconciliation with lag ≤ 10', () => {
    const t0 = 1_000_000;
    const tracker = createHealthTracker({ now: () => t0 });
    tracker.recordReconciliation(1000);
    const snap = tracker.snapshot(1000);
    expect(snap.status).toBe('healthy');
    expect(snap.lastReconciledSlot).toBe(1000);
    expect(snap.lastReconciledAt).toBe(t0);
    expect(snap.lastSuccessfulPollAt).toBe(t0);
  });

  it('stays healthy at boundary lag of 10 slots', () => {
    const tracker = createHealthTracker({ now: () => 1_000_000 });
    tracker.recordReconciliation(990);
    expect(tracker.classify(1000)).toBe('healthy');
  });

  it('transitions to degraded at lag of 11 slots', () => {
    const tracker = createHealthTracker({ now: () => 1_000_000 });
    tracker.recordReconciliation(989);
    expect(tracker.classify(1000)).toBe('degraded');
  });

  it('transitions to degraded when RPC is unreachable', () => {
    const tracker = createHealthTracker({ now: () => 1_000_000 });
    tracker.recordReconciliation(1000);
    tracker.recordPollFailure();
    expect(tracker.classify(1000)).toBe('degraded');
  });

  it('transitions to degraded when lag > 10 but ≤ 50', () => {
    const tracker = createHealthTracker({ now: () => 1_000_000 });
    tracker.recordReconciliation(950);
    expect(tracker.classify(1000)).toBe('degraded');
  });

  it('transitions to critical when SQLite is unwritable', () => {
    const tracker = createHealthTracker({ now: () => 1_000_000 });
    tracker.recordReconciliation(1000);
    tracker.setSqliteWritable(false);
    expect(tracker.classify(1000)).toBe('critical');
  });

  it('transitions to critical when no reconciliation for 120s', () => {
    const t0 = 1_000_000;
    const tracker = createHealthTracker({ now: () => t0 });
    tracker.recordReconciliation(1000);
    // Advance clock past 120s
    tracker.classify(1000, t0 + 120_001);
    expect(tracker.classify(1000, t0 + 120_001)).toBe('critical');
  });

  it('transitions to critical when lag > 50 continuously for 120s', () => {
    const t0 = 1_000_000;
    const tracker = createHealthTracker({ now: () => t0 });
    tracker.recordReconciliation(949); // lag = 51

    // First call: starts tracking high-lag window
    expect(tracker.classify(1000, t0)).toBe('degraded');

    // Before 120s: still degraded
    expect(tracker.classify(1000, t0 + 119_000)).toBe('degraded');

    // After 120s: critical
    expect(tracker.classify(1000, t0 + 120_001)).toBe('critical');
  });

  it('resets high-lag tracking when reconciliation succeeds', () => {
    let t = 1_000_000;
    const tracker = createHealthTracker({ now: () => t });
    tracker.recordReconciliation(949); // lag 51 at t0

    // Start high-lag window
    expect(tracker.classify(1000, t)).toBe('degraded');

    // Advance clock 60s, reconcile at t0+60s — should reset high-lag tracking
    t += 60_000;
    tracker.recordReconciliation(1000); // lastReconciledAt = t0+60s

    // At t0+120s (60s since last reconciliation), should be healthy
    t += 60_000;
    expect(tracker.classify(1000, t)).toBe('healthy');
  });

  it('recovers from degraded back to healthy when RPC recovers', () => {
    const t0 = 1_000_000;
    const tracker = createHealthTracker({ now: () => t0 });
    tracker.recordReconciliation(1000);
    tracker.recordPollFailure(); // degraded
    expect(tracker.classify(1000)).toBe('degraded');

    tracker.recordPollSuccess(1000); // recovers
    expect(tracker.classify(1000)).toBe('healthy');
  });

  it('recovers from critical to healthy when SQLite becomes writable and lag drops', () => {
    const t0 = 1_000_000;
    const tracker = createHealthTracker({ now: () => t0 });
    tracker.recordReconciliation(1000);
    tracker.setSqliteWritable(false);
    expect(tracker.classify(1000)).toBe('critical');

    tracker.setSqliteWritable(true);
    expect(tracker.classify(1000)).toBe('healthy');
  });

  it('clamps negative slot lag to zero', () => {
    const tracker = createHealthTracker({ now: () => 1_000_000 });
    tracker.recordReconciliation(1010); // reconciled ahead of rpc
    expect(tracker.classify(1000)).toBe('healthy');
  });

  it('recordPollSuccess without slot updates lastSuccessfulPollAt', () => {
    const t0 = 1_000_000;
    const tracker = createHealthTracker({ now: () => t0 });
    tracker.recordReconciliation(1000);
    tracker.recordPollSuccess(); // no slot
    const snap = tracker.snapshot(1000);
    expect(snap.lastSuccessfulPollAt).toBe(t0);
  });

  it('backfill metadata tracks state transitions', () => {
    const t0 = 1_000_000;
    const tracker = createHealthTracker({ now: () => t0 });
    expect(tracker.getBackfill().state).toBe('idle');

    tracker.updateBackfill({ state: 'running', slotsScanned: 50 });
    expect(tracker.getBackfill().state).toBe('running');
    expect(tracker.getBackfill().slotsScanned).toBe(50);

    tracker.updateBackfill({
      state: 'completed',
      slotsScanned: 100,
      txsMatched: 5,
      fillsInserted: 3,
      batchesInserted: 2,
    });
    const backfill = tracker.getBackfill();
    expect(backfill.state).toBe('completed');
    expect(backfill.completedAt).toBe(t0);
    expect(backfill.slotsScanned).toBe(100);
    expect(backfill.txsMatched).toBe(5);
    expect(backfill.fillsInserted).toBe(3);
    expect(backfill.batchesInserted).toBe(2);
  });

  it('does not expose RPC URLs, credentials, or secrets', () => {
    const tracker = createHealthTracker();
    tracker.recordReconciliation(1000);
    const snap = tracker.snapshot(1000);
    const serialized = JSON.stringify(snap);
    expect(serialized).not.toContain('http');
    expect(serialized).not.toContain('keypair');
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('private');
    expect(serialized).not.toContain('apiKey');
  });

  it('snapshot returns a defensive copy of backfill', () => {
    const tracker = createHealthTracker({ now: () => 1_000_000 });
    tracker.recordReconciliation(1000);
    const snap1 = tracker.snapshot(1000);
    const snap2 = tracker.snapshot(1000);
    expect(snap1.backfill).toEqual(snap2.backfill);
    expect(snap1.backfill).not.toBe(snap2.backfill);
  });
});
