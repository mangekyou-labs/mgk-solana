import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { discoverSlots, recentSignatureSlots, splitSlotRanges } from './backfill.js';

describe('splitSlotRanges', () => {
  it('splits an inclusive slot span into provider-safe ranges', () => {
    expect(splitSlotRanges(10, 23, 5)).toEqual([
      [10, 14],
      [15, 19],
      [20, 23],
    ]);
  });

  it('deduplicates and filters signature slots to the requested window', () => {
    expect(recentSignatureSlots(
      [{ slot: 20 }, { slot: 20 }, { slot: 9 }, { slot: null }],
      10,
    )).toEqual([20]);
  });
});

describe('discoverSlots', () => {
  it('uses recent program signatures before provider-specific block scans', async () => {
    const calls: string[] = [];
    const connection = {
      getSlot: async () => 120,
      getSignaturesForAddress: async () => {
        calls.push('signatures');
        return [{ slot: 119 }, { slot: 118 }, { slot: 119 }];
      },
      getBlocks: async () => {
        calls.push('blocks');
        return [];
      },
    } as never;

    await expect(discoverSlots(
      connection,
      10,
      [new PublicKey('11111111111111111111111111111111')],
    )).resolves.toEqual([118, 119]);
    expect(calls).toEqual(['signatures']);
  });
});

describe('backfillTransactions', () => {
  it('parses transactions with staticAccountKeys without throwing on unresolved lookup tables', async () => {
    const { backfillTransactions } = await import('./backfill.js');
    const corePk = new PublicKey('C7w2mKz2KQgDroNNhACm9MutXhPiesVr9Gn2x8TDsRYx');
    const matcherPk = new PublicKey('7WiZuunbPGciCedsVTguvjezwwzrhmXG5HkdCuHizbNC');
    const mockStore = {
      insertFill: { run: () => {} },
      upsertCandle: { '1m': { run: () => {} } },
    } as never;

    const mockV0Message = {
      staticAccountKeys: [new PublicKey('11111111111111111111111111111111'), corePk],
      compiledInstructions: [],
      getAccountKeys: () => {
        throw new Error('Failed to get account keys because address table lookups were not resolved');
      },
    };

    const mockConnection = {
      getBlock: async () => ({
        transactions: [
          {
            transaction: { message: mockV0Message },
          },
        ],
      }),
    } as never;

    const res = await backfillTransactions(mockConnection, mockStore, corePk, matcherPk, [100]);
    expect(res.txsMatched).toBe(1);
  });
});
