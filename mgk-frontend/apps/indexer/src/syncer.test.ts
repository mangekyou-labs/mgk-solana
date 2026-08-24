import { describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import * as sdk from '@mgk/sdk';
import { createStore } from './store.js';
import { createSyncer, syncChunk, type SyncChunkResult } from './syncer.js';

describe('syncer - gap-aware slot synchronization', () => {
  const corePk = new PublicKey('C7w2mKz2KQgDroNNhACm9MutXhPiesVr9Gn2x8TDsRYx');
  const matcherPk = new PublicKey('7WiZuunbPGciCedsVTguvjezwwzrhmXG5HkdCuHizbNC');

  it('advances cursor on quiet markets even when getBlocks returns no blocks', async () => {
    const store = createStore(':memory:');
    const mockConnection = {
      getBlocks: vi.fn().mockResolvedValue([]),
    } as never;

    const result = await syncChunk({
      connection: mockConnection,
      store,
      corePk,
      matcherPk,
      startSlot: 100,
      endSlot: 200,
    });

    expect(result.success).toBe(true);
    expect(result.slotsProcessed).toBe(101); // 100..200 inclusive
    expect(result.fillsInserted).toBe(0);

    const syncState = store.getSyncState();
    expect(syncState.processedThroughSlot).toBe(200);
    expect(syncState.lastSuccessfulSyncAt).not.toBeNull();
  });

  it('leaves chunk uncommitted on RPC failure for retry', async () => {
    const store = createStore(':memory:');
    store.updateSyncSuccess(50, 1700000000000);

    const mockConnection = {
      getBlocks: vi.fn().mockRejectedValue(new Error('RPC rate limit / 429')),
    } as never;

    const result = await syncChunk({
      connection: mockConnection,
      store,
      corePk,
      matcherPk,
      startSlot: 51,
      endSlot: 100,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();

    // Cursor MUST NOT have advanced
    const syncState = store.getSyncState();
    expect(syncState.processedThroughSlot).toBe(50);
    expect(syncState.lastSyncErrorAt).not.toBeNull();
  });

  it('aggregates candles and broadcasts ONLY newly inserted fills (idempotency)', async () => {
    const store = createStore(':memory:');
    const broadcastFills: unknown[] = [];
    const txSig = 'test-tx-sig-idempotency-123';
    const makerPk = Buffer.from(new Uint8Array(32).fill(0x11));
    const takerPk = Buffer.from(new Uint8Array(32).fill(0x22));

    // Pre-insert fill 1
    store.insertFill.run([
      100, 1, 0, 0, 150_000_000, 1_000_000, takerPk, makerPk, Buffer.from(txSig, 'utf-8'), 0,
    ]);

    // Construct mock block with 1 old fill and 1 new fill
    const batchPk = new PublicKey('11111111111111111111111111111112');
    const resultsPk = new PublicKey('11111111111111111111111111111113');
    const mockBlock = {
      transactions: [
        {
          transaction: {
            signatures: [txSig],
            message: {
              staticAccountKeys: [batchPk, corePk, matcherPk, resultsPk],
              compiledInstructions: [
                {
                  programIdIndex: 1,
                  data: new Uint8Array([8]), // SettleBatch
                  accountKeyIndexes: [0, 1, 2, 3],
                },
              ],
            },
          },
        },
      ],
    };

    // DFBA results header (34 bytes: 8+8+8+8+2) + 2 fills (58 bytes each: 32+8+8+8+1+1)
    const resultsBuffer = new Uint8Array(34 + 58 * 2);
    const view = new DataView(resultsBuffer.buffer);
    view.setUint16(32, 2, true); // num_fills = 2

    // Fill 0: matches pre-inserted fill (price: 150_000_000, qty: 1_000_000, auction: 1 -> taker_side: 0)
    resultsBuffer.set(takerPk, 34);
    view.setBigUint64(34 + 40, 1_000_000n, true); // qty
    view.setBigInt64(34 + 48, 150_000_000n, true); // price
    resultsBuffer[34 + 56] = 0; // is_maker = 0
    resultsBuffer[34 + 57] = 1; // auction = 1 -> taker_side = 0

    // Fill 1: new fill (price: 155_000_000, qty: 2_000_000, auction: 0 -> taker_side: 1)
    const fill1Offset = 34 + 58;
    resultsBuffer.set(takerPk, fill1Offset);
    view.setBigUint64(fill1Offset + 40, 2_000_000n, true); // qty
    view.setBigInt64(fill1Offset + 48, 155_000_000n, true); // price
    resultsBuffer[fill1Offset + 56] = 0; // is_maker = 0
    resultsBuffer[fill1Offset + 57] = 0; // auction = 0 -> taker_side = 1

    const batchBuffer = new Uint8Array(sdk.state.BATCH_SIZE);
    const batchView = new DataView(batchBuffer.buffer);
    batchView.setBigUint64(0, 1n, true);
    batchView.setUint8(8, sdk.state.BatchStatus.Settled);
    batchView.setUint8(152, 1); // markValid = true (identifies as DFBA)

    const mockConnection = {
      getBlocks: vi.fn().mockResolvedValue([100]),
      getBlock: vi.fn().mockResolvedValue(mockBlock),
      getAccountInfo: vi.fn().mockImplementation((pk: PublicKey) => {
        if (pk.equals(batchPk)) {
          return Promise.resolve({
            data: Buffer.from(batchBuffer),
            executable: false,
            lamports: 1000,
            owner: corePk,
            rentEpoch: 0,
          });
        }
        return Promise.resolve({
          data: Buffer.from(resultsBuffer),
          executable: false,
          lamports: 1000,
          owner: matcherPk,
          rentEpoch: 0,
        });
      }),
    } as never;

    const result = await syncChunk({
      connection: mockConnection,
      store,
      corePk,
      matcherPk,
      startSlot: 100,
      endSlot: 100,
      onFill: (f) => broadcastFills.push(f),
    });

    expect(result.success).toBe(true);
    // Only 1 new fill inserted, not 2
    expect(result.fillsInserted).toBe(1);
    expect(broadcastFills).toHaveLength(1);
  });

  it('resumes on restart from next unprocessed slot', async () => {
    const store = createStore(':memory:');
    store.updateSyncSuccess(500, 1700000000000);

    const syncedChunks: Array<[number, number]> = [];
    const mockConnection = {
      getSlot: vi.fn().mockResolvedValue(550),
      getBlocks: vi.fn().mockImplementation((s: number, e: number) => {
        syncedChunks.push([s, e]);
        return Promise.resolve([]);
      }),
      onLogs: vi.fn().mockReturnValue(1),
      removeOnLogsListener: vi.fn().mockResolvedValue(undefined),
    } as never;

    const syncer = createSyncer({
      connection: mockConnection,
      store,
      coreProgramId: corePk.toBase58(),
      matcherProgramId: matcherPk.toBase58(),
      pollIntervalMs: 50,
      maxChunkSlots: 256,
    });

    await syncer.start();
    await syncer.triggerSync();
    await syncer.stop();

    expect(syncedChunks[0]).toEqual([501, 550]);
    expect(store.getSyncState().processedThroughSlot).toBe(550);
  });

  it('SKIP_BACKFILL=1 seeds cursor at confirmed head and skips backfill', async () => {
    const store = createStore(':memory:');
    const mockConnection = {
      getSlot: vi.fn().mockResolvedValue(10000),
      onLogs: vi.fn().mockReturnValue(1),
      removeOnLogsListener: vi.fn().mockResolvedValue(undefined),
    } as never;

    const syncer = createSyncer({
      connection: mockConnection,
      store,
      coreProgramId: corePk.toBase58(),
      matcherProgramId: matcherPk.toBase58(),
      skipBackfill: true,
      pollIntervalMs: 50,
    });

    await syncer.start();
    const health = syncer.getRuntimeHealth();
    expect(health.processedThroughSlot).toBe(10000);
    expect(store.getSyncState().processedThroughSlot).toBe(10000);
    await syncer.stop();
  });

  it('truthful subscription health sets flags true only after onLogs and false on stop', async () => {
    const store = createStore(':memory:');
    let coreListenerId = 1;
    let matcherListenerId = 2;

    const mockConnection = {
      getSlot: vi.fn().mockResolvedValue(100),
      getBlocks: vi.fn().mockResolvedValue([]),
      onLogs: vi.fn().mockImplementation((pk: PublicKey) => {
        if (pk.equals(corePk)) return coreListenerId;
        return matcherListenerId;
      }),
      removeOnLogsListener: vi.fn().mockResolvedValue(undefined),
    } as never;

    const syncer = createSyncer({
      connection: mockConnection,
      store,
      coreProgramId: corePk.toBase58(),
      matcherProgramId: matcherPk.toBase58(),
      skipBackfill: true,
    });

    // Before start: false
    expect(syncer.getRuntimeHealth().subscriptions).toEqual({ core: false, matcher: false });

    await syncer.start();

    // After start: true
    expect(syncer.getRuntimeHealth().subscriptions).toEqual({ core: true, matcher: true });

    await syncer.stop();

    // After stop: false
    expect(syncer.getRuntimeHealth().subscriptions).toEqual({ core: false, matcher: false });
  });

  it('single-flight worker coalesces overlapping triggers', async () => {
    const store = createStore(':memory:');
    store.setSyncCursor(100);

    let getBlocksCalls = 0;
    let resolveGate: () => void;
    const gatePromise = new Promise<void>((res) => {
      resolveGate = res;
    });

    const mockConnection = {
      getSlot: vi.fn().mockResolvedValue(200),
      getBlocks: vi.fn().mockImplementation(() => {
        getBlocksCalls++;
        return gatePromise.then(() => []);
      }),
      onLogs: vi.fn().mockReturnValue(1),
      removeOnLogsListener: vi.fn().mockResolvedValue(undefined),
    } as never;

    const syncer = createSyncer({
      connection: mockConnection,
      store,
      coreProgramId: corePk.toBase58(),
      matcherProgramId: matcherPk.toBase58(),
    });

    // Trigger 1 (in-flight)
    const sync1 = syncer.triggerSync();
    // Immediate subsequent triggers while in-flight
    const sync2 = syncer.triggerSync();
    const sync3 = syncer.triggerSync();

    // Allow getSlot microtask to resolve to reach getBlocks
    await new Promise((r) => setTimeout(r, 0));

    expect(getBlocksCalls).toBe(1);

    // Resolve gate
    resolveGate!();
    await Promise.all([sync1, sync2, sync3]);

    // Should have coalesced without duplicate overlapping runs
    expect(store.getSyncState().processedThroughSlot).toBe(200);
  });
});
