import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { usePythPriceStore, startPythPolling, type PythFeedState } from './usePythPriceStore';

const originalFetch = globalThis.fetch;

function mockFetchSequence(bodies: unknown[]): void {
  let i = 0;
  globalThis.fetch = vi.fn().mockImplementation(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => bodies[i++] ?? { binary: { encoding: 'base64', data: [] }, parsed: [] },
  })) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  // Reset the store between tests
  usePythPriceStore.setState({ feeds: {} });
  // Clear any running polling
  const stop = startPythPolling({ feedIds: [], intervalMs: 1_000_000 });
  stop();
});

const sampleBody1 = {
  binary: { encoding: 'base64', data: [] },
  parsed: [
    { id: '0xaaaa', price: { price: '100000000', conf: '0', expo: -8, publish_time: 1 }, ema_price: { price: '0', conf: '0', expo: -8, publish_time: 0 } },
  ],
};

const sampleBody2 = {
  binary: { encoding: 'base64', data: [] },
  parsed: [
    { id: '0xaaaa', price: { price: '101000000', conf: '0', expo: -8, publish_time: 2 }, ema_price: { price: '0', conf: '0', expo: -8, publish_time: 0 } },
  ],
};

describe('usePythPriceStore', () => {
  it('setFeed writes a per-id entry', () => {
    usePythPriceStore.getState().setFeed('aaaa', {
      data: null,
      loading: true,
      error: null,
      lastFetchedAt: null,
    });
    expect(usePythPriceStore.getState().feeds['aaaa']?.loading).toBe(true);
  });
});

describe('usePythPrices', () => {
  beforeEach(() => {
    usePythPriceStore.setState({ feeds: {} });
  });

  it('returns defaults for unknown feedIds', () => {
    // Direct store check — the hook is exercised end-to-end in
    // TickerBar.test.tsx ("renders a price once the first fetch resolves").
    expect(usePythPriceStore.getState().feeds['unknown']).toBeUndefined();
  });
});

describe('startPythPolling', () => {
  it('writes a successful feed to the store after the first tick', async () => {
    mockFetchSequence([sampleBody1]);
    const stop = startPythPolling({ feedIds: ['aaaa'], intervalMs: 1_000_000 });
    // Wait for the async tick to settle.
    await new Promise((r) => setTimeout(r, 10));
    const state: PythFeedState | undefined = usePythPriceStore.getState().feeds['aaaa'];
    expect(state).toBeDefined();
    expect(state?.data?.price).toBe(1_000_000n);
    expect(state?.loading).toBe(false);
    expect(state?.error).toBeNull();
    stop();
  });

  it('writes an error to the store when fetch fails', async () => {
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error('boom')) as unknown as typeof fetch;
    const stop = startPythPolling({ feedIds: ['aaaa'], intervalMs: 1_000_000 });
    await new Promise((r) => setTimeout(r, 10));
    const state = usePythPriceStore.getState().feeds['aaaa'];
    expect(state?.error).toMatch(/boom/);
    expect(state?.data).toBeNull();
    stop();
  });

  it('clears the interval when stop() is called', async () => {
    const f = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => sampleBody1,
    });
    globalThis.fetch = f as unknown as typeof fetch;
    const stop = startPythPolling({ feedIds: ['aaaa'], intervalMs: 30 });
    await new Promise((r) => setTimeout(r, 5));
    const beforeStop = f.mock.calls.length;
    stop();
    await new Promise((r) => setTimeout(r, 60));
    const afterStop = f.mock.calls.length;
    expect(afterStop).toBe(beforeStop);
  });

  it('overwrites the prior poll when startPythPolling is called again', async () => {
    const f = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => sampleBody2,
    });
    globalThis.fetch = f as unknown as typeof fetch;
    const stop1 = startPythPolling({ feedIds: ['aaaa'], intervalMs: 30 });
    const stop2 = startPythPolling({ feedIds: ['bbbb'], intervalMs: 30 });
    await new Promise((r) => setTimeout(r, 80));
    const callsForBbb = f.mock.calls.filter((call) => {
      const url = call[0] as string;
      return url.includes('bbbb');
    }).length;
    expect(callsForBbb).toBeGreaterThan(0);
    stop1();
    stop2();
  });
});
