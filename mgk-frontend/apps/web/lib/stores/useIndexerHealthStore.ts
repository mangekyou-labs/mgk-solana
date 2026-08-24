'use client';

import { useEffect } from 'react';
import { create } from 'zustand';
import { config } from '@/lib/config';

export type IndexerHealthStatus =
  | 'warming'
  | 'healthy'
  | 'degraded'
  | 'critical';

export interface IndexerHealthResponse {
  ok: boolean;
  status: IndexerHealthStatus;
  ts: number;
  sqliteWritable: boolean;
  processedThroughSlot: number | null;
  latestIndexedSlot: number | null;
  rpcSlot: number | null;
  rpcReachable: boolean | null;
  slotLag: number | null;
  lastSuccessfulSyncAt: number | null;
  lastSyncErrorAt: number | null;
  subscriptions: { core: boolean; matcher: boolean };
  lastBatch: { batchId: number; phase: number; ts: number } | null;
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

/**
 * Derived display status that extends the backend status with
 * client-side connection states:
 *   - 'reconnecting': one failed request
 *   - 'unreachable': two+ consecutive failures
 */
export type IndexerDisplayStatus = IndexerHealthStatus | 'reconnecting' | 'unreachable';

export interface IndexerHealthData {
  data: IndexerHealthResponse | null;
  lastValidResponse: IndexerHealthResponse | null;
  /** Backend status from the latest successful response */
  status: IndexerHealthStatus;
  /** Derived display status incorporating consecutive failures */
  displayStatus: IndexerDisplayStatus;
  slotLag: number | null;
  consecutiveFailures: number;
  loading: boolean;
  error: string | null;
  lastFetchedAt: number | null;
  isPolling: boolean;
}

export interface IndexerHealthStore extends IndexerHealthData {
  setState: (s: Partial<IndexerHealthData>) => void;
  reset: () => void;
  refresh: () => Promise<void>;
}

const INITIAL_STATE: IndexerHealthData = {
  data: null,
  lastValidResponse: null,
  status: 'warming',
  displayStatus: 'warming',
  slotLag: null,
  consecutiveFailures: 0,
  loading: false,
  error: null,
  lastFetchedAt: null,
  isPolling: false,
};

export const useIndexerHealthStore = create<IndexerHealthStore>((set) => ({
  ...INITIAL_STATE,
  setState: (s) => set((prev) => ({ ...prev, ...s })),
  reset: () => set(INITIAL_STATE),
  refresh: () => {
    void tick(true);
    return Promise.resolve();
  },
}));

interface PollParams {
  intervalMs: number;
  timeoutMs: number;
}

let pollHandle: ReturnType<typeof setInterval> | null = null;
let currentParams: PollParams | null = null;
let inflightRequest: Promise<IndexerHealthResponse> | null = null;

function createTimeoutSignal(timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  if (typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal && typeof AbortSignal.timeout === 'function') {
    return { signal: AbortSignal.timeout(timeoutMs), cleanup: () => {} };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
  };
}

async function fetchHealth(timeoutMs: number): Promise<IndexerHealthResponse> {
  // Deduplicate concurrent requests
  if (inflightRequest) {
    return inflightRequest;
  }

  const { signal, cleanup } = createTimeoutSignal(timeoutMs);
  inflightRequest = (async () => {
    try {
      const url = `${config.indexerUrl}/api/healthz`;
      const res = await fetch(url, { signal, headers: { accept: 'application/json' } });
      if (!res.ok) {
        throw new Error(`health fetch failed with HTTP ${res.status}`);
      }
      const body = (await res.json()) as IndexerHealthResponse;
      if (!body || typeof body !== 'object' || typeof body.status !== 'string') {
        throw new Error('invalid healthz response schema');
      }
      return body;
    } finally {
      cleanup();
    }
  })();

  try {
    const result = await inflightRequest;
    return result;
  } finally {
    inflightRequest = null;
  }
}

function deriveDisplayStatus(
  status: IndexerHealthStatus,
  consecutiveFailures: number,
): IndexerDisplayStatus {
  if (consecutiveFailures >= 2) return 'unreachable';
  if (consecutiveFailures === 1) return 'reconnecting';
  return status;
}

async function tick(manual = false): Promise<void> {
  const params = currentParams;
  if (!params && !manual) return;

  const timeoutMs = params?.timeoutMs ?? 4000;
  const store = useIndexerHealthStore.getState();
  if (!store.data && !store.lastValidResponse) {
    store.setState({ loading: true });
  }

  try {
    const data = await fetchHealth(timeoutMs);
    useIndexerHealthStore.setState({
      data,
      lastValidResponse: data,
      status: data.status,
      displayStatus: deriveDisplayStatus(data.status, 0),
      slotLag: data.slotLag,
      consecutiveFailures: 0,
      loading: false,
      error: null,
      lastFetchedAt: Date.now(),
      isPolling: true,
    });
  } catch (err) {
    const current = useIndexerHealthStore.getState();
    const nextFailures = current.consecutiveFailures + 1;
    useIndexerHealthStore.setState({
      loading: false,
      consecutiveFailures: nextFailures,
      displayStatus: deriveDisplayStatus(current.status, nextFailures),
      error: err instanceof Error ? err.message : 'unknown error',
      lastFetchedAt: Date.now(),
      isPolling: true,
      lastValidResponse: current.lastValidResponse,
    });
  }
}

export function startHealthPolling(intervalMs = 5000, timeoutMs = 4000): Promise<void> {
  const params: PollParams = { intervalMs, timeoutMs };
  currentParams = params;
  if (pollHandle !== null) {
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

export function stopHealthPolling(): void {
  if (pollHandle !== null) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
  currentParams = null;
  useIndexerHealthStore.getState().reset();
}

/**
 * React hook: provides the live indexer health state and starts polling if not already running.
 */
export function useIndexerHealth(intervalMs = 5000, timeoutMs = 4000): IndexerHealthData {
  const state = useIndexerHealthStore();

  useEffect(() => {
    void startHealthPolling(intervalMs, timeoutMs);
  }, [intervalMs, timeoutMs]);

  return {
    data: state.data,
    lastValidResponse: state.lastValidResponse,
    status: state.status,
    displayStatus: state.displayStatus,
    slotLag: state.slotLag,
    consecutiveFailures: state.consecutiveFailures,
    loading: state.loading,
    error: state.error,
    lastFetchedAt: state.lastFetchedAt,
    isPolling: state.isPolling,
  };
}

export function __resetHealthStore(): void {
  if (pollHandle !== null) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
  currentParams = null;
  inflightRequest = null;
  useIndexerHealthStore.getState().reset();
}
