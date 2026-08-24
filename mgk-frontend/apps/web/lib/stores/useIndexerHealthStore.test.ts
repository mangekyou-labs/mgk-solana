import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetHealthStore,
  startHealthPolling,
  useIndexerHealthStore,
  type IndexerHealthResponse,
} from './useIndexerHealthStore';

const HEALTHY_RESPONSE: IndexerHealthResponse = {
  ok: true,
  status: 'healthy',
  ts: 1700000000000,
  sqliteWritable: true,
  processedThroughSlot: 5000,
  latestIndexedSlot: 5000,
  rpcSlot: 5002,
  rpcReachable: true,
  slotLag: 2,
  lastSuccessfulSyncAt: 1700000000000,
  lastSyncErrorAt: null,
  subscriptions: { core: true, matcher: true },
  lastBatch: { batchId: 1, phase: 0, ts: 1700000000000 },
  lastReconciledSlot: 5000,
  lastSuccessfulPollAt: 1700000000000,
  backfill: {
    state: 'completed',
    completedAt: 1700000000000,
    slotsScanned: 1000,
    txsMatched: 5,
    fillsInserted: 3,
    batchesInserted: 2,
  },
};

const DEGRADED_RESPONSE: IndexerHealthResponse = {
  ...HEALTHY_RESPONSE,
  status: 'degraded',
  slotLag: 15,
  processedThroughSlot: 4985,
  lastReconciledSlot: 4985,
};

function mockFetchOnce(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

describe('useIndexerHealthStore', () => {
  beforeEach(() => {
    __resetHealthStore();
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    __resetHealthStore();
    vi.restoreAllMocks();
  });

  it('initializes in warming status when no data is fetched yet', () => {
    const state = useIndexerHealthStore.getState();
    expect(state.status).toBe('warming');
    expect(state.displayStatus).toBe('warming');
    expect(state.data).toBeNull();
    expect(state.lastValidResponse).toBeNull();
    expect(state.consecutiveFailures).toBe(0);
  });

  it('updates state on successful health fetch', async () => {
    globalThis.fetch = mockFetchOnce(HEALTHY_RESPONSE);
    await startHealthPolling(5000, 4000);

    const state = useIndexerHealthStore.getState();
    expect(state.status).toBe('healthy');
    expect(state.displayStatus).toBe('healthy');
    expect(state.data).toEqual(HEALTHY_RESPONSE);
    expect(state.lastValidResponse).toEqual(HEALTHY_RESPONSE);
    expect(state.slotLag).toBe(2);
    expect(state.consecutiveFailures).toBe(0);
    expect(state.error).toBeNull();
  });

  it('sets displayStatus to reconnecting after one failure', async () => {
    // First fetch succeeds
    globalThis.fetch = mockFetchOnce(HEALTHY_RESPONSE);
    await startHealthPolling(5000, 4000);
    expect(useIndexerHealthStore.getState().displayStatus).toBe('healthy');

    // Second fetch fails
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));
    await startHealthPolling(5000, 4000);

    const state = useIndexerHealthStore.getState();
    expect(state.displayStatus).toBe('reconnecting');
    expect(state.consecutiveFailures).toBe(1);
    expect(state.lastValidResponse).toEqual(HEALTHY_RESPONSE);
  });

  it('sets displayStatus to unreachable after two consecutive failures', async () => {
    // First fetch succeeds
    globalThis.fetch = mockFetchOnce(HEALTHY_RESPONSE);
    await startHealthPolling(5000, 4000);

    // Fail twice
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));
    await startHealthPolling(5000, 4000);
    await startHealthPolling(5000, 4000);

    const state = useIndexerHealthStore.getState();
    expect(state.displayStatus).toBe('unreachable');
    expect(state.consecutiveFailures).toBe(2);
  });

  it('immediately recovers on next valid response', async () => {
    // Two failures
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('500 internal server error'));
    await startHealthPolling(5000, 4000);
    await startHealthPolling(5000, 4000);
    expect(useIndexerHealthStore.getState().displayStatus).toBe('unreachable');
    expect(useIndexerHealthStore.getState().consecutiveFailures).toBe(2);

    // Recovery
    globalThis.fetch = mockFetchOnce(DEGRADED_RESPONSE);
    await startHealthPolling(5000, 4000);

    const state = useIndexerHealthStore.getState();
    expect(state.status).toBe('degraded');
    expect(state.displayStatus).toBe('degraded');
    expect(state.consecutiveFailures).toBe(0);
    expect(state.data).toEqual(DEGRADED_RESPONSE);
    expect(state.slotLag).toBe(15);
    expect(state.error).toBeNull();
  });

  it('preserves lastValidResponse during failures', async () => {
    globalThis.fetch = mockFetchOnce(HEALTHY_RESPONSE);
    await startHealthPolling(5000, 4000);

    globalThis.fetch = vi.fn().mockRejectedValue(new Error('connection refused'));
    await startHealthPolling(5000, 4000);

    expect(useIndexerHealthStore.getState().lastValidResponse).toEqual(HEALTHY_RESPONSE);
  });

  it('deduplicates concurrent fetch requests', async () => {
    let fetchCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      fetchCount++;
      return new Response(JSON.stringify(HEALTHY_RESPONSE), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    // Trigger two concurrent ticks
    await Promise.all([
      startHealthPolling(5000, 4000),
      startHealthPolling(5000, 4000),
    ]);

    // Only one fetch should have been made (deduplicated)
    expect(fetchCount).toBe(1);
  });

  it('exposes manual refresh capability', async () => {
    globalThis.fetch = mockFetchOnce(HEALTHY_RESPONSE);
    await startHealthPolling(5000, 4000);
    expect(useIndexerHealthStore.getState().status).toBe('healthy');

    // Fail
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('timeout'));
    await startHealthPolling(5000, 4000);
    expect(useIndexerHealthStore.getState().displayStatus).toBe('reconnecting');

    // Manual refresh with recovery
    globalThis.fetch = mockFetchOnce(DEGRADED_RESPONSE);
    useIndexerHealthStore.getState().refresh();

    // Give the fetch time to resolve
    await new Promise((r) => setTimeout(r, 50));

    const state = useIndexerHealthStore.getState();
    expect(state.status).toBe('degraded');
    expect(state.consecutiveFailures).toBe(0);
  });
});
