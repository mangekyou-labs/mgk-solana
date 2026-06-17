'use client';

import { useEffect } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import type { Connection } from '@solana/web3.js';
import { create } from 'zustand';

export interface SlotPollParams {
  connection: Connection;
  intervalMs: number;
}

interface SlotStore {
  slot: number | null;
  loading: boolean;
  error: string | null;
  lastFetchedAt: number | null;
  isPolling: boolean;
  startPolling: (params: SlotPollParams) => Promise<void>;
  stopPolling: () => void;
  refresh: () => Promise<void>;
}

// Poll state lives at module scope (not in the store) so that the
// `setInterval` handle and the active poll params don't get serialized
// by Zustand devtools / persisted to localStorage. Mirrors the pattern
// established by usePortfolioStore (T2.2) and useBatchStore (T2.4).
let pollHandle: ReturnType<typeof setInterval> | null = null;
let currentParams: SlotPollParams | null = null;

export const useSlotStore = create<SlotStore>((set, get) => ({
  slot: null,
  loading: false,
  error: null,
  lastFetchedAt: null,
  isPolling: false,

  startPolling: async (params) => {
    if (pollHandle) clearInterval(pollHandle);
    currentParams = params;
    set({ isPolling: true });
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
      const slot = await currentParams.connection.getSlot();
      set({
        slot,
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
 * React hook that auto-starts slot polling on mount and stops on unmount.
 * Slot is global (not user-scoped) so this hook needs no wallet deps.
 * Default 1000ms — fast enough for a live countdown, slow enough to
 * stay well under public devnet RPC rate limits.
 */
export function useSlotPolling(intervalMs = 1000): {
  slot: number | null;
  loading: boolean;
  error: string | null;
  isPolling: boolean;
} {
  const { connection } = useConnection();

  const startPolling = useSlotStore((s) => s.startPolling);
  const stopPolling = useSlotStore((s) => s.stopPolling);

  useEffect(() => {
    startPolling({ connection, intervalMs });
    return () => {
      stopPolling();
    };
  }, [connection, intervalMs, startPolling, stopPolling]);

  return {
    slot: useSlotStore((s) => s.slot),
    loading: useSlotStore((s) => s.loading),
    error: useSlotStore((s) => s.error),
    isPolling: useSlotStore((s) => s.isPolling),
  };
}
