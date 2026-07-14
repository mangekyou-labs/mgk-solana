'use client';

import { useEffect } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import type { Connection, PublicKey } from '@solana/web3.js';
import * as sdk from '@mgk/sdk';
import { create } from 'zustand';

import { config } from '@/lib/config';
import { resolveBatchAddress, resolveRegistryAddress } from '@/lib/onchainAccounts';

type BatchState = sdk.state.BatchState;
type RegistryState = sdk.state.RegistryState;

export interface BatchPollParams {
  connection: Connection;
  programId: PublicKey;
  registryAddress?: PublicKey | null;
  batchAddress?: PublicKey | null;
  indexerUrl?: string;
  intervalMs: number;
}

interface BatchStore {
  data: BatchState | null;
  registry: RegistryState | null;
  currentBatchId: bigint | null;
  loading: boolean;
  error: string | null;
  lastFetchedAt: number | null;
  isPolling: boolean;
  startPolling: (params: BatchPollParams) => Promise<void>;
  stopPolling: () => void;
  refresh: () => Promise<void>;
}

// Poll state lives at module scope (not in the store) so that the
// `setInterval` handle and the active poll params don't get serialized
// by Zustand devtools / persisted to localStorage. Mirrors the pattern
// established by usePortfolioStore (T2.2) — a "small duplicate beats a
// wrong abstraction": portfolio polling is per-user, batch polling is
// global, and the two-call RPC shape (Registry → Batch) is unique to
// the batch flow, so we keep two near-identical stores rather than
// introducing a shared factory.
let pollHandle: ReturnType<typeof setInterval> | null = null;
let currentParams: BatchPollParams | null = null;
let hookConsumerCount = 0;
let hookParamsKey: string | null = null;

export const useBatchStore = create<BatchStore>((set, get) => ({
  data: null,
  registry: null,
  currentBatchId: null,
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
      const { connection, programId, registryAddress, batchAddress, indexerUrl } = currentParams;

      const registryPda = resolveRegistryAddress(programId, registryAddress ?? null);
      const registryAccounts =
        await connection.getMultipleAccountsInfo([registryPda]);
      const registryAcc = registryAccounts[0] ?? null;
      if (!registryAcc) {
        set({
          data: null,
          registry: null,
          currentBatchId: null,
          loading: false,
          error: null,
          lastFetchedAt: Date.now(),
        });
        return;
      }
      const registry = sdk.state.decodeRegistry(
        new Uint8Array(registryAcc.data),
      );

      if (registry.batchIdCounter === 0n) {
        set({
          data: null,
          registry,
          currentBatchId: 0n,
          loading: false,
          error: null,
          lastFetchedAt: Date.now(),
        });
        return;
      }

      const activeBatchId = registry.batchIdCounter - 1n;
      const batchPda = await resolveBatchAddress({
        batchId: activeBatchId,
        programId,
        batchAddress: batchAddress ?? null,
        indexerUrl,
      });
      const batchAccounts = await connection.getMultipleAccountsInfo([batchPda]);
      const batchAcc = batchAccounts[0] ?? null;
      if (!batchAcc) {
        set({
          data: null,
          registry,
          currentBatchId: activeBatchId,
          loading: false,
          error: null,
          lastFetchedAt: Date.now(),
        });
        return;
      }
      const data = sdk.state.decodeBatch(new Uint8Array(batchAcc.data));

      set({
        data,
        registry,
        currentBatchId: activeBatchId,
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
 * React hook that auto-starts batch polling on mount and stops on unmount.
 * Batch state is global (not user-scoped) so this hook needs no wallet deps —
 * it kicks off polling as soon as the connection is available.
 */
export function useBatchPolling(intervalMs = 5000): {
  data: BatchState | null;
  registry: RegistryState | null;
  currentBatchId: bigint | null;
  loading: boolean;
  error: string | null;
  lastFetchedAt: number | null;
  isPolling: boolean;
  refresh: () => Promise<void>;
} {
  const { connection } = useConnection();

  const startPolling = useBatchStore((s) => s.startPolling);
  const stopPolling = useBatchStore((s) => s.stopPolling);

  useEffect(() => {
    const params = {
      connection,
      programId: config.coreProgramId,
      registryAddress: config.registryAddress,
      batchAddress: config.batchAddress,
      indexerUrl: config.indexerUrl,
      intervalMs,
    };
    const nextParamsKey = [
      connection.rpcEndpoint,
      config.coreProgramId.toBase58(),
      config.registryAddress?.toBase58() ?? '',
      config.batchAddress?.toBase58() ?? '',
      config.indexerUrl,
      intervalMs,
    ].join('|');

    hookConsumerCount += 1;
    if (hookConsumerCount === 1 || hookParamsKey !== nextParamsKey) {
      hookParamsKey = nextParamsKey;
      startPolling(params);
    }

    return () => {
      hookConsumerCount = Math.max(0, hookConsumerCount - 1);
      if (hookConsumerCount === 0) {
        hookParamsKey = null;
        stopPolling();
      }
    };
  }, [connection, intervalMs, startPolling, stopPolling]);

  return {
    data: useBatchStore((s) => s.data),
    registry: useBatchStore((s) => s.registry),
    currentBatchId: useBatchStore((s) => s.currentBatchId),
    loading: useBatchStore((s) => s.loading),
    error: useBatchStore((s) => s.error),
    lastFetchedAt: useBatchStore((s) => s.lastFetchedAt),
    isPolling: useBatchStore((s) => s.isPolling),
    refresh: useBatchStore((s) => s.refresh),
  };
}
