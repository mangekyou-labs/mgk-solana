import { describe, expect, it } from 'vitest';
import { createStore } from './store.js';

describe('store - multiple fills per transaction', () => {
  it('stores multiple fills from the same transaction and slot without primary key collision', () => {
    const store = createStore(':memory:');
    const txSig = '4apD1UuMX5Zfmxu9AnW9LFtBeMdhZ8t3bhWEcq84yvnfKyvvLG5389FgUCR2X8M8wGkUXhWRtLSNt2aqPhEqQRgR';
    const slot = 487207426;
    const batchId = 19;
    const instrumentId = 0;

    const makerPk = Buffer.from(new Uint8Array(32).fill(0x11));
    const takerPk = Buffer.from(new Uint8Array(32).fill(0x22));

    // Fill 1: Maker in Bid auction
    store.insertFill.run([
      slot,
      batchId,
      instrumentId,
      1, // takerSide
      50000,
      10000,
      makerPk,
      makerPk,
      Buffer.from(txSig, 'utf-8'),
      1, // isMaker
    ]);

    // Fill 2: Taker in Bid auction (same txSig, instrumentId, slot)
    store.insertFill.run([
      slot,
      batchId,
      instrumentId,
      1, // takerSide
      50000,
      10000,
      takerPk,
      takerPk,
      Buffer.from(txSig, 'utf-8'),
      0, // isMaker
    ]);

    const totalFills = store.db.prepare('SELECT COUNT(*) as count FROM fills WHERE tx_signature = ?').get(Buffer.from(txSig, 'utf-8')) as { count: number };
    expect(totalFills.count).toBe(2);

    const makerFills = store.db.prepare('SELECT * FROM fills WHERE taker_pubkey = ? OR maker_pubkey = ?').all(makerPk, makerPk);
    expect(makerFills).toHaveLength(1);

    const takerFills = store.db.prepare('SELECT * FROM fills WHERE taker_pubkey = ? OR maker_pubkey = ?').all(takerPk, takerPk);
    expect(takerFills).toHaveLength(1);
  });

  it('initializes sync_state with null values and advances cursor monotonically', () => {
    const store = createStore(':memory:');
    const initial = store.getSyncState();
    expect(initial).toEqual({
      processedThroughSlot: null,
      lastSuccessfulSyncAt: null,
      lastSyncErrorAt: null,
    });

    // Advance cursor
    store.updateSyncSuccess(100, 1700000000000);
    const afterFirst = store.getSyncState();
    expect(afterFirst.processedThroughSlot).toBe(100);
    expect(afterFirst.lastSuccessfulSyncAt).toBe(1700000000000);
    expect(afterFirst.lastSyncErrorAt).toBeNull();

    // Record error
    store.updateSyncError(1700000005000);
    const afterError = store.getSyncState();
    expect(afterError.processedThroughSlot).toBe(100);
    expect(afterError.lastSuccessfulSyncAt).toBe(1700000000000);
    expect(afterError.lastSyncErrorAt).toBe(1700000005000);

    // Update with lower slot does not regress cursor
    store.updateSyncSuccess(90, 1700000010000);
    expect(store.getSyncState().processedThroughSlot).toBe(100);

    // Update with higher slot advances cursor
    store.updateSyncSuccess(256, 1700000020000);
    expect(store.getSyncState().processedThroughSlot).toBe(256);
  });

  it('supports setSyncCursor for seeding bootstrap without backfill', () => {
    const store = createStore(':memory:');
    store.setSyncCursor(5000);
    expect(store.getSyncState().processedThroughSlot).toBe(5000);
  });

  it('checks SQLite writability correctly', () => {
    const store = createStore(':memory:');
    expect(store.isWritable()).toBe(true);
  });
});

