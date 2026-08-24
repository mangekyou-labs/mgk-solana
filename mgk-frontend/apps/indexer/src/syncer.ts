import { Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import * as sdk from '@mgk/sdk';
import type { Store } from './store.js';
import { decodeBatchEvent, decodeDfbaFills, decodeFills } from './decoder.js';
import { aggregateCandles } from './aggregator.js';
import { splitSlotRanges } from './backfill.js';
import { createHealthTracker, type HealthTracker } from './healthTracker.js';

export interface SyncChunkParams {
  connection: Connection;
  store: Store;
  corePk: PublicKey;
  matcherPk: PublicKey;
  startSlot: number;
  endSlot: number;
  onFill?: (fill: Record<string, unknown>) => void;
}

export interface SyncChunkResult {
  success: boolean;
  slotsProcessed: number;
  fillsInserted: number;
  error?: unknown;
}

export interface DecodedFillItem {
  slot: number;
  batchId: bigint;
  instrumentId: number;
  takerSide: number;
  price: bigint;
  qty: bigint;
  takerPubkey: Uint8Array;
  makerPubkey: Uint8Array;
  txSignature: string;
  isMaker: boolean;
}

/**
 * Fetch and decode all blocks in [startSlot, endSlot] and commit fills + candles + cursor atomically.
 * On any RPC failure, nothing is committed and the chunk is left uncommitted for retry.
 */
export async function syncChunk(params: SyncChunkParams): Promise<SyncChunkResult> {
  const { connection, store, corePk, matcherPk, startSlot, endSlot, onFill } = params;
  if (startSlot > endSlot) {
    return { success: true, slotsProcessed: 0, fillsInserted: 0 };
  }

  const decodedFills: DecodedFillItem[] = [];

  try {
    // Solana getBlocks returns only slots that actually produced confirmed blocks
    // Split into provider-safe sub-ranges if necessary (e.g. 64 slots per getBlocks call)
    const blockSlots: number[] = [];
    const ranges = splitSlotRanges(startSlot, endSlot, 64);
    for (const [rStart, rEnd] of ranges) {
      const slots = await connection.getBlocks(rStart, rEnd, 'confirmed');
      blockSlots.push(...slots);
    }

    for (const slot of blockSlots) {
      const block = await connection.getBlock(slot, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
      if (!block?.transactions) continue;

      for (const txResp of block.transactions) {
        const msg = txResp.transaction.message;
        const staticKeys: PublicKey[] = 'staticAccountKeys' in msg && Array.isArray(msg.staticAccountKeys)
          ? (msg.staticAccountKeys as PublicKey[])
          : 'accountKeys' in msg && Array.isArray(msg.accountKeys)
            ? (msg.accountKeys as PublicKey[])
            : [];

        const hasCore = staticKeys.some((k) => k.equals(corePk));
        const hasMatcher = staticKeys.some((k) => k.equals(matcherPk));
        if (!hasCore && !hasMatcher) continue;

        const compiledIxs = msg.compiledInstructions;
        for (const ix of compiledIxs) {
          const progKey = staticKeys[ix.programIdIndex];
          if (!progKey || !progKey.equals(corePk)) continue;

          const data = ix.data;
          let parsed: Uint8Array;
          if (data instanceof Uint8Array || Buffer.isBuffer(data)) {
            parsed = new Uint8Array(data);
          } else if (typeof data === 'string') {
            parsed = bs58.decode(data);
          } else {
            continue;
          }

          if (parsed.length < 1 || parsed[0] !== 8) continue; // SettleBatch discriminator = 8

          const batchIdx = ix.accountKeyIndexes[0];
          const batchPk = batchIdx === undefined ? undefined : staticKeys[batchIdx];
          let batchId = 0n;
          let isDfba = false;
          if (batchPk) {
            const batchInfo = await connection.getAccountInfo(batchPk, 'confirmed');
            if (batchInfo) {
              const batch = sdk.state.decodeBatch(new Uint8Array(batchInfo.data));
              batchId = batch.batchId;
              isDfba = batch.markValid || batch.matchedBidQty > 0n || batch.matchedAskQty > 0n;
            }
          }

          const resultsIdx = ix.accountKeyIndexes[3];
          if (resultsIdx === undefined || resultsIdx >= staticKeys.length) continue;
          const resultsPk = staticKeys[resultsIdx];
          if (!resultsPk) continue;

          const accInfo = await connection.getAccountInfo(resultsPk, 'confirmed');
          if (!accInfo) continue;

          const signature = txResp.transaction.signatures[0] ?? `unknown-${slot}`;
          const resultsData = new Uint8Array(accInfo.data);
          const fills = isDfba
            ? decodeDfbaFills(resultsData, slot, batchId, 0, signature)
            : decodeFills(resultsData, slot, batchId, 0, signature, 0);

          decodedFills.push(...fills);
        }
      }
    }
  } catch (error) {
    store.updateSyncError(Date.now());
    return {
      success: false,
      slotsProcessed: 0,
      fillsInserted: 0,
      error,
    };
  }

  // Atomic SQLite transaction: commit fills, candles, and sync cursor together
  const newlyInsertedFills: DecodedFillItem[] = [];
  const now = Date.now();

  const commitChunk = store.db.transaction(() => {
    for (const fill of decodedFills) {
      const info = store.insertFill.run([
        fill.slot,
        Number(fill.batchId),
        fill.instrumentId,
        fill.takerSide,
        Number(fill.price),
        Number(fill.qty),
        Buffer.from(fill.takerPubkey),
        Buffer.from(fill.makerPubkey),
        Buffer.from(fill.txSignature, 'utf-8'),
        fill.isMaker ? 1 : 0,
      ]);

      if (info.changes > 0) {
        newlyInsertedFills.push(fill);
        aggregateCandles(store, [
          {
            instrumentId: fill.instrumentId,
            timestampMs: fill.slot * 400,
            price: fill.price,
            qty: fill.qty,
          },
        ]);
      }
    }

    store.updateSyncSuccess(endSlot, now);
  });

  commitChunk();

  // Broadcast only newly inserted fills so retries cannot duplicate broadcasts
  if (onFill) {
    for (const fill of newlyInsertedFills) {
      onFill({
        slot: fill.slot,
        batch_id: Number(fill.batchId),
        instrument_id: fill.instrumentId,
        taker_side: fill.takerSide,
        price: Number(fill.price),
        qty: Number(fill.qty),
        taker_pubkey: Buffer.from(fill.takerPubkey),
        maker_pubkey: Buffer.from(fill.makerPubkey),
        tx_signature: Buffer.from(fill.txSignature, 'utf-8'),
        is_maker: fill.isMaker ? 1 : 0,
      });
    }
  }

  return {
    success: true,
    slotsProcessed: endSlot - startSlot + 1,
    fillsInserted: newlyInsertedFills.length,
  };
}

export interface SyncerConfig {
  connection: Connection;
  store: Store;
  coreProgramId: string;
  matcherProgramId: string;
  skipBackfill?: boolean;
  bootSlots?: number;
  maxChunkSlots?: number;
  pollIntervalMs?: number;
  onFill?: (fill: Record<string, unknown>) => void;
  onBatchEvent?: (event: unknown) => void;
}

export interface SyncerRuntimeHealth {
  rpcSlot: number | null;
  rpcReachable: boolean | null;
  processedThroughSlot: number | null;
  lastSuccessfulSyncAt: number | null;
  lastSyncErrorAt: number | null;
  lastHeartbeat: number | null;
  subscriptions: { core: boolean; matcher: boolean };
  lastBatch: { batchId: number; phase: number; ts: number } | null;
  inFlight: boolean;
}

export interface Syncer {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  triggerSync: () => Promise<void>;
  getRuntimeHealth: () => SyncerRuntimeHealth;
  getHealthTracker: () => HealthTracker;
}

export function createSyncer(config: SyncerConfig): Syncer {
  const {
    connection,
    store,
    coreProgramId,
    matcherProgramId,
    skipBackfill = false,
    bootSlots = 1000,
    maxChunkSlots = 256,
    pollIntervalMs = 2000,
    onFill,
    onBatchEvent,
  } = config;

  const corePk = new PublicKey(coreProgramId);
  const matcherPk = new PublicKey(matcherProgramId);

  const healthTracker = createHealthTracker();

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let batchPollTimer: ReturnType<typeof setInterval> | null = null;
  let coreListenerId: number | null = null;
  let matcherListenerId: number | null = null;

  let inFlight = false;
  let pendingScan = false;

  let rpcSlot: number | null = null;
  let rpcReachable: boolean | null = null;
  let lastHeartbeat: number | null = null;
  let lastBatch: { batchId: number; phase: number; ts: number } | null = null;

  let lastBatchId: bigint | null = null;
  let lastPhase: number | null = null;

  const runtimeSubscriptions = {
    core: false,
    matcher: false,
  };

  async function pollBatchState(): Promise<void> {
    try {
      const [registryPda] = sdk.deriveRegistryPda(corePk);
      const accounts = await connection.getMultipleAccountsInfo([registryPda]);
      const regData = accounts[0];
      if (!regData) return;

      const registry = sdk.state.decodeRegistry(new Uint8Array(regData.data));
      const batchId = registry.batchIdCounter;
      if (batchId === 0n) return;

      const [batchPda] = sdk.deriveBatchPda(batchId, corePk);
      const batchAccounts = await connection.getMultipleAccountsInfo([batchPda]);
      const batchData = batchAccounts[0];
      if (!batchData) return;

      const batch = sdk.state.decodeBatch(new Uint8Array(batchData.data));

      lastBatch = {
        batchId: Number(batch.batchId),
        phase: batch.status,
        ts: Date.now(),
      };

      if (batchId !== lastBatchId || batch.status !== lastPhase) {
        const event = decodeBatchEvent(batch);
        store.insertBatchEvent.run([
          Number(event.batchId),
          event.ts,
          event.phase,
          event.numCommitments,
          Number(event.closeSlot),
          Number(event.vwap) / 1e6,
        ]);

        if (onBatchEvent) {
          onBatchEvent(event);
        }

        lastBatchId = batchId;
        lastPhase = batch.status;
      }
    } catch {
      // Best-effort batch state update
    }
  }

  async function triggerSync(): Promise<void> {
    if (inFlight) {
      pendingScan = true;
      return;
    }

    inFlight = true;
    lastHeartbeat = Date.now();

    try {
      do {
        pendingScan = false;

        let currentConfirmedSlot: number;
        try {
          currentConfirmedSlot = await connection.getSlot('confirmed');
          rpcSlot = currentConfirmedSlot;
          rpcReachable = true;
          lastHeartbeat = Date.now();
          healthTracker.recordPollSuccess(currentConfirmedSlot);
        } catch (error) {
          rpcReachable = false;
          healthTracker.recordPollFailure();
          store.updateSyncError(Date.now());
          break;
        }

        let syncState = store.getSyncState();
        let cursor = syncState.processedThroughSlot;

        if (cursor === null) {
          // Uninitialized cursor (first boot)
          if (skipBackfill) {
            store.setSyncCursor(currentConfirmedSlot);
            store.updateSyncSuccess(currentConfirmedSlot, Date.now());
            cursor = currentConfirmedSlot;
          } else {
            cursor = Math.max(0, currentConfirmedSlot - bootSlots);
          }
        }

        // Process chunks until caught up
        while (cursor < currentConfirmedSlot) {
          const chunkStart = cursor + 1;
          const chunkEnd = Math.min(chunkStart + maxChunkSlots - 1, currentConfirmedSlot);

          const result = await syncChunk({
            connection,
            store,
            corePk,
            matcherPk,
            startSlot: chunkStart,
            endSlot: chunkEnd,
            onFill,
          });

          lastHeartbeat = Date.now();

          if (!result.success) {
            healthTracker.recordPollFailure();
            // Leave chunk uncommitted for next retry
            break;
          }

          healthTracker.recordReconciliation(chunkEnd);
          cursor = chunkEnd;
        }
      } while (pendingScan);
    } finally {
      inFlight = false;
    }
  }

  return {
    async start() {
      // First boot / bootstrap check
      const syncState = store.getSyncState();
      if (syncState.processedThroughSlot === null) {
        if (skipBackfill) {
          try {
            const head = await connection.getSlot('confirmed');
            rpcSlot = head;
            rpcReachable = true;
            store.setSyncCursor(head);
            store.updateSyncSuccess(head, Date.now());
          } catch {
            rpcReachable = false;
            store.updateSyncError(Date.now());
          }
        }
      }

      lastHeartbeat = Date.now();

      // Install truthful log subscriptions
      try {
        coreListenerId = connection.onLogs(
          corePk,
          () => {
            void triggerSync();
          },
          'confirmed',
        );
        runtimeSubscriptions.core = true;
      } catch {
        runtimeSubscriptions.core = false;
      }

      try {
        matcherListenerId = connection.onLogs(
          matcherPk,
          () => {
            void triggerSync();
          },
          'confirmed',
        );
        runtimeSubscriptions.matcher = true;
      } catch {
        runtimeSubscriptions.matcher = false;
      }

      // Start fallback poll loop (every 2s)
      pollTimer = setInterval(() => {
        void triggerSync();
      }, pollIntervalMs);

      // Start batch polling loop (every 5s)
      batchPollTimer = setInterval(() => {
        void pollBatchState();
      }, 5000);

      // Initial runs
      void pollBatchState();
      await triggerSync();
    },

    async stop() {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (batchPollTimer) {
        clearInterval(batchPollTimer);
        batchPollTimer = null;
      }

      if (coreListenerId !== null) {
        try {
          await connection.removeOnLogsListener(coreListenerId);
        } catch {
          // ignore
        }
        coreListenerId = null;
      }
      runtimeSubscriptions.core = false;

      if (matcherListenerId !== null) {
        try {
          await connection.removeOnLogsListener(matcherListenerId);
        } catch {
          // ignore
        }
        matcherListenerId = null;
      }
      runtimeSubscriptions.matcher = false;
    },

    triggerSync,

    getRuntimeHealth(): SyncerRuntimeHealth {
      const syncState = store.getSyncState();
      return {
        rpcSlot,
        rpcReachable,
        processedThroughSlot: syncState.processedThroughSlot,
        lastSuccessfulSyncAt: syncState.lastSuccessfulSyncAt,
        lastSyncErrorAt: syncState.lastSyncErrorAt,
        lastHeartbeat,
        subscriptions: { ...runtimeSubscriptions },
        lastBatch,
        inFlight,
      };
    },

    getHealthTracker(): HealthTracker {
      return healthTracker;
    },
  };
}
