import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

import {
  __resetMarketStateStore,
  startMarketStatePolling,
  stopMarketStatePolling,
  useMarketStatePolling,
  useMarketStateStore,
  type MarketState,
} from './useMarketStateStore';

const SAMPLE_STATE: MarketState = {
  instrument_id: 0,
  last_price: 150.42,
  mark_price: 150.38,
  open_interest_long: 5000,
  open_interest_short: 3200,
  funding_rate: 0.0125,
  volume_24h: 12345.67,
  updated_ts: 1_700_000_000,
};

function mockFetchOnce(state: MarketState) {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(state), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

function mockFetchError(status: number) {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ error: 'nope' }), { status }),
  );
}

function mockFetchNetworkError(message: string) {
  return vi.fn().mockRejectedValue(new Error(message));
}

describe('useMarketStateStore', () => {
  beforeEach(() => {
    __resetMarketStateStore();
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    stopMarketStatePolling();
    vi.restoreAllMocks();
  });

  describe('startMarketStatePolling', () => {
    it('fetches once on start, then sets data in the store', async () => {
      globalThis.fetch = mockFetchOnce(SAMPLE_STATE);
      await startMarketStatePolling(0, 60_000);
      const state = useMarketStateStore.getState();
      expect(state.data).toEqual(SAMPLE_STATE);
      expect(state.error).toBeNull();
      expect(state.lastFetchedAt).toBeGreaterThan(0);
    });

    it('records an error string on HTTP failure but does not throw', async () => {
      globalThis.fetch = mockFetchError(404);
      await startMarketStatePolling(0, 60_000);
      const state = useMarketStateStore.getState();
      expect(state.data).toBeNull();
      expect(state.error).toMatch(/404/);
    });

    it('records an error string on network failure', async () => {
      globalThis.fetch = mockFetchNetworkError('connection refused');
      await startMarketStatePolling(0, 60_000);
      const state = useMarketStateStore.getState();
      expect(state.data).toBeNull();
      expect(state.error).toMatch(/connection refused/);
    });

    it('restarts the interval when called twice with different params', async () => {
      const fetch1 = mockFetchOnce(SAMPLE_STATE);
      globalThis.fetch = fetch1;
      await startMarketStatePolling(0, 60_000);
      expect(fetch1).toHaveBeenCalledTimes(1);

      const updated: MarketState = { ...SAMPLE_STATE, last_price: 200 };
      globalThis.fetch = mockFetchOnce(updated);
      await startMarketStatePolling(0, 60_000);
      expect(useMarketStateStore.getState().data?.last_price).toBe(200);
    });
  });

  describe('stopMarketStatePolling', () => {
    it('clears the polling handle', async () => {
      globalThis.fetch = mockFetchOnce(SAMPLE_STATE);
      await startMarketStatePolling(0, 60_000);
      stopMarketStatePolling();
      expect(useMarketStateStore.getState().isPolling).toBe(false);
    });
  });

  describe('useMarketStatePolling', () => {
    it('starts polling on mount, stops on unmount', async () => {
      globalThis.fetch = mockFetchOnce(SAMPLE_STATE);
      const { result, unmount } = renderHook(() =>
        useMarketStatePolling(0, 60_000),
      );
      await waitFor(() => expect(result.current.isPolling).toBe(true));
      expect(result.current.data).toEqual(SAMPLE_STATE);
      unmount();
      expect(useMarketStateStore.getState().isPolling).toBe(false);
    });
  });
});
