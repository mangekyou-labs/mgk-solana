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
  /** Optional override for the book account address. When set, skips PDA
   *  derivation and fetches this address directly. Used on devnet where the
   *  book is a matcher-owned keypair (no InitializeBook instruction yet). */
  bookAddress?: PublicKey | null;
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
      const { connection, programId, instrumentId, bookAddress } = currentParams;

      const bookPk = bookAddress ?? sdk.deriveBookPda(instrumentId, programId)[0];
      const accounts = await connection.getMultipleAccountsInfo([bookPk]);
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

export function useBookTopN(
  instrumentId: number,
  depth = 20,
  intervalMs = 5000,
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
      bookAddress: config.bookAddress,
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
