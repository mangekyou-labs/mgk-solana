'use client';

import { useEffect } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { create } from 'zustand';

import { config } from '@/lib/config';

export interface UserFill {
  /** Solana slot this fill was included in. */
  slot: number;
  /** Batch ID at the time of the fill. */
  batch_id: number;
  /** Instrument ID. */
  instrument_id: number;
  /** 0 = taker is buy, 1 = taker is sell. */
  taker_side: number;
  /** Fill price, scaled 1e6 (USD). */
  price: number;
  /** Fill qty, scaled 1e6 (base units). */
  qty: number;
  /** Whether the user was the taker or the maker on this fill. */
  role: 'taker' | 'maker';
  /** Tx signature (base64). */
  tx_signature: string;
  /** Approximate ms-since-epoch derived from slot (slot * 400ms). */
  ts_estimate: number;
}

interface MyFillsData {
  fills: UserFill[];
  loading: boolean;
  error: string | null;
  lastFetchedAt: number | null;
  isPolling: boolean;
}

interface MyFillsStore extends MyFillsData {
  setState: (s: MyFillsData) => void;
  reset: () => void;
}

export const useMyFillsStore = create<MyFillsStore>((set) => ({
  fills: [],
  loading: false,
  error: null,
  lastFetchedAt: null,
  isPolling: false,
  setState: (s) => set(s),
  reset: () =>
    set({
      fills: [],
      loading: false,
      error: null,
      lastFetchedAt: null,
      isPolling: false,
    }),
}));

interface PollParams {
  pubkey: string;
  instrumentId: number;
  intervalMs: number;
  timeoutMs: number;
}

let pollHandle: ReturnType<typeof setInterval> | null = null;
let currentParams: PollParams | null = null;

async function fetchFills(
  pubkey: string,
  instrumentId: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<UserFill[]> {
  const url = `${config.indexerUrl}/api/users/${pubkey}/fills?instrumentId=${instrumentId}&limit=200`;
  const res = await fetch(url, { signal, headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`user fills fetch failed: ${res.status}`);
  }
  const body = (await res.json()) as { fills: UserFill[] };
  return body.fills;
}

async function tick(): Promise<void> {
  const params = currentParams;
  if (!params) return;
  const store = useMyFillsStore.getState();
  if (!store.isPolling) {
    store.setState({ ...store, loading: true });
  }
  try {
    const fills = await fetchFills(
      params.pubkey,
      params.instrumentId,
      params.timeoutMs,
      new AbortController().signal,
    );
    useMyFillsStore.setState({
      fills,
      loading: false,
      error: null,
      lastFetchedAt: Date.now(),
      isPolling: true,
    });
  } catch (err) {
    useMyFillsStore.setState({
      loading: false,
      error: err instanceof Error ? err.message : 'unknown',
      lastFetchedAt: Date.now(),
    });
  }
}

export function startMyFillsPolling(
  pubkey: string,
  instrumentId = 0,
  intervalMs = 5000,
  timeoutMs = 4000,
): Promise<void> {
  const params: PollParams = { pubkey, instrumentId, intervalMs, timeoutMs };
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

export function stopMyFillsPolling(): void {
  if (pollHandle != null) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
  currentParams = null;
  useMyFillsStore.getState().reset();
}

/**
 * React hook: polls the indexer's `GET /api/users/:pubkey/fills` endpoint
 * for the connected wallet and the given instrument. Returns the live store
 * state. Auto-starts on mount + wallet-connect, auto-stops on unmount +
 * disconnect.
 */
export function useMyFills(
  instrumentId = 0,
  intervalMs = 5000,
): MyFillsData {
  const state = useMyFillsStore();
  const { publicKey, connected } = useWallet();

  useEffect(() => {
    if (!connected || !publicKey) {
      stopMyFillsPolling();
      return;
    }
    void startMyFillsPolling(publicKey.toBase58(), instrumentId, intervalMs);
    return () => {
      stopMyFillsPolling();
    };
  }, [publicKey, connected, instrumentId, intervalMs]);

  return {
    fills: state.fills,
    loading: state.loading,
    error: state.error,
    lastFetchedAt: state.lastFetchedAt,
    isPolling: state.isPolling,
  };
}

/** Test-only: reset the store + clear the polling handle. */
export function __resetMyFillsStore(): void {
  stopMyFillsPolling();
}
