'use client';

import { useEffect } from 'react';
import { create } from 'zustand';

import { config } from '@/lib/config';

export interface MarketState {
  instrument_id: number;
  last_price: number;
  mark_price: number;
  open_interest_long: number;
  open_interest_short: number;
  funding_rate: number;
  volume_24h: number;
  updated_ts: number;
}

interface MarketStateData {
  data: MarketState | null;
  loading: boolean;
  error: string | null;
  lastFetchedAt: number | null;
  isPolling: boolean;
}

interface MarketStateStore extends MarketStateData {
  setState: (s: MarketStateData) => void;
}

export const useMarketStateStore = create<MarketStateStore>((set) => ({
  data: null,
  loading: false,
  error: null,
  lastFetchedAt: null,
  isPolling: false,
  setState: (s) => set(s),
}));

interface PollParams {
  instrumentId: number;
  intervalMs: number;
  timeoutMs: number;
}

let pollHandle: ReturnType<typeof setInterval> | null = null;
let currentParams: PollParams | null = null;

async function fetchMarketState(
  instrumentId: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<MarketState> {
  const url = `${config.indexerUrl}/api/markets/${instrumentId}/state`;
  const res = await fetch(url, { signal, headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`market state fetch failed: ${res.status}`);
  }
  return (await res.json()) as MarketState;
}

async function tick(): Promise<void> {
  const params = currentParams;
  if (!params) return;
  const store = useMarketStateStore.getState();
  if (!store.data) {
    store.setState({ ...store, loading: true });
  }
  try {
    const data = await fetchMarketState(
      params.instrumentId,
      params.timeoutMs,
      new AbortController().signal,
    );
    useMarketStateStore.setState({
      data,
      loading: false,
      error: null,
      lastFetchedAt: Date.now(),
      isPolling: true,
    });
  } catch (err) {
    // 404 = market not registered yet (indexer running but no fills).
    // Network errors = indexer offline. Both are non-fatal.
    useMarketStateStore.setState({
      loading: false,
      error: err instanceof Error ? err.message : 'unknown',
      lastFetchedAt: Date.now(),
    });
  }
}

export function startMarketStatePolling(
  instrumentId: number,
  intervalMs = 5000,
  timeoutMs = 4000,
): Promise<void> {
  const params: PollParams = { instrumentId, intervalMs, timeoutMs };
  currentParams = params;
  if (pollHandle != null) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
  return tick().then(() => {
    if (currentParams !== params) return;
    pollHandle = setInterval(() => {
      void tick();
    }, intervalMs);
  });
}

export function stopMarketStatePolling(): void {
  if (pollHandle != null) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
  currentParams = null;
  useMarketStateStore.setState({ isPolling: false });
}

/**
 * React hook: polls `GET /api/markets/:id/state` on the configured
 * indexer. Returns the live store state. Caller mounts it once per
 * instrument (default instrument 0 = SOL-USD Perp).
 */
export function useMarketStatePolling(
  instrumentId = 0,
  intervalMs = 5000,
): MarketStateData {
  const state = useMarketStateStore();
  useEffect(() => {
    void startMarketStatePolling(instrumentId, intervalMs);
    return () => {
      stopMarketStatePolling();
    };
  }, [instrumentId, intervalMs]);
  return {
    data: state.data,
    loading: state.loading,
    error: state.error,
    lastFetchedAt: state.lastFetchedAt,
    isPolling: state.isPolling,
  };
}

/** Test-only: reset the store + clear the polling handle. */
export function __resetMarketStateStore(): void {
  stopMarketStatePolling();
  useMarketStateStore.setState({
    data: null,
    loading: false,
    error: null,
    lastFetchedAt: null,
    isPolling: false,
  });
}
