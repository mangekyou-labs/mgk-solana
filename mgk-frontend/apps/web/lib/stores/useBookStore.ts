'use client';

import { useEffect, useMemo } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import type { Connection, PublicKey } from '@solana/web3.js';
import * as sdk from '@mgk/sdk';
import { create } from 'zustand';

import { config } from '@/lib/config';

type BookHeader = sdk.state.BookHeader;
type BookLevel = sdk.state.BookLevel;

export interface BookPollParams {
  connection: Connection;
  programId: PublicKey;
  instrumentId: number;
  intervalMs: number;
}

interface BookStore {
  data: BookHeader | null;
  instrumentId: number | null;
  loading: boolean;
  error: string | null;
  lastFetchedAt: number | null;
  isPolling: boolean;
  startPolling: (params: BookPollParams) => Promise<void>;
  stopPolling: () => void;
  refresh: () => Promise<void>;
}

// Poll state lives at module scope (not in the store) so that the
// `setInterval` handle and the active poll params don't get serialized
// by Zustand devtools / persisted to localStorage. Mirrors the pattern
// established by usePortfolioStore (T2.2) and useBatchStore (T2.4) —
// a "small duplicate beats a wrong abstraction": book polling is
// single-call (derive Book PDA → fetch → decode), batch polling is
// two-call (Registry → Batch), and book is per-instrument while batch
// is global, so we keep three near-identical stores rather than
// introducing a shared factory.
let pollHandle: ReturnType<typeof setInterval> | null = null;
let currentParams: BookPollParams | null = null;

export const useBookStore = create<BookStore>((set, get) => ({
  data: null,
  instrumentId: null,
  loading: false,
  error: null,
  lastFetchedAt: null,
  isPolling: false,

  startPolling: async (params) => {
    if (pollHandle) clearInterval(pollHandle);
    currentParams = params;
    set({ isPolling: true, instrumentId: params.instrumentId });
    await get().refresh();
    pollHandle = setInterval(() => {
      void get().refresh();
    }, params.intervalMs);
  },

  stopPolling: () => {
    if (pollHandle) {
      clearInterval(pollHandle);
      pollHandle = null;
    }
    currentParams = null;
    set({ isPolling: false });
  },

  refresh: async () => {
    if (!currentParams) return;
    set({ loading: true, error: null });
    try {
      const { connection, programId, instrumentId } = currentParams;

      const [bookPda] = sdk.deriveBookPda(instrumentId, programId);
      const accounts = await connection.getMultipleAccountsInfo([bookPda]);
      const acc = accounts[0] ?? null;
      if (!acc) {
        set({
          data: null,
          loading: false,
          error: null,
          lastFetchedAt: Date.now(),
        });
        return;
      }
      const data = sdk.state.decodeBookHeader(new Uint8Array(acc.data));

      set({
        data,
        loading: false,
        error: null,
        lastFetchedAt: Date.now(),
      });
    } catch (e) {
      set({
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
}));

/**
 * React hook that auto-starts book polling on mount and stops on unmount.
 * Book state is per-instrument: switching `instrumentId` replaces the
 * active poll (the previous interval is cleared in `startPolling`).
 * Returns the top-N levels (filtered to populated, sorted bid DESC /
 * ask ASC, sliced to `depth`).
 */
export function useBookTopN(
  instrumentId: number,
  depth = 20,
  intervalMs = 3000,
): {
  bids: BookLevel[];
  asks: BookLevel[];
  data: BookHeader | null;
  loading: boolean;
  error: string | null;
} {
  const { connection } = useConnection();

  const startPolling = useBookStore((s) => s.startPolling);
  const stopPolling = useBookStore((s) => s.stopPolling);

  useEffect(() => {
    startPolling({
      connection,
      programId: config.matcherProgramId,
      instrumentId,
      intervalMs,
    });
    return () => {
      stopPolling();
    };
  }, [connection, instrumentId, intervalMs, startPolling, stopPolling]);

  const data = useBookStore((s) => s.data);
  const loading = useBookStore((s) => s.loading);
  const error = useBookStore((s) => s.error);

  const { bids, asks } = useMemo(() => {
    if (!data) return { bids: [], asks: [] };
    const filledBids = data.bids.filter((l) => l.orderCount > 0);
    const filledAsks = data.asks.filter((l) => l.orderCount > 0);
    filledBids.sort((a, b) =>
      b.price > a.price ? 1 : b.price < a.price ? -1 : 0,
    );
    filledAsks.sort((a, b) =>
      a.price > b.price ? 1 : a.price < b.price ? -1 : 0,
    );
    return {
      bids: filledBids.slice(0, depth),
      asks: filledAsks.slice(0, depth),
    };
  }, [data, depth]);

  return { bids, asks, data, loading, error };
}
