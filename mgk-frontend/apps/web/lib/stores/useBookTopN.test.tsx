import { renderHook, waitFor } from '@testing-library/react';
import { act } from 'react';
import { PublicKey, type AccountInfo, type Connection } from '@solana/web3.js';
import * as sdk from '@mgk/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@solana/wallet-adapter-react', () => ({
  useConnection: () => ({ connection: globalThis.GLOBAL_CONNECTION }),
  useWallet: () => ({ publicKey: null, connected: false }),
}));

import { useBookTopN, useBookStore } from './useBookStore';

const MATCHER_PK = new PublicKey('9o2vTBBhEp6CYxNsDPsX79Euhzh8TtoLTSHR5R3jXebZ');
const BOOK_PDA = new PublicKey('A6qbhK9mPRpFhX7D1kZsBpr2xNy8mfgU5J7Vu9xLE5Rp');

vi.mock('@mgk/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof sdk>();
  return {
    ...actual,
    deriveBookPda: vi.fn(() => [BOOK_PDA, 255] as const),
  };
});

class MockConnection {
  responses: Array<AccountInfo<Buffer> | null | Error> = [];

  async getMultipleAccountsInfo(): Promise<(AccountInfo<Buffer> | null)[]> {
    const resp = this.responses.shift() ?? null;
    if (resp instanceof Error) throw resp;
    return [resp];
  }
}

declare global {
  var GLOBAL_CONNECTION: Connection | undefined;
}

function makeBookBuffer(
  bids: Array<{ price: bigint; totalQty: bigint; orderCount: number }>,
  asks: Array<{ price: bigint; totalQty: bigint; orderCount: number }>,
  bestBid = 0n,
  bestAsk = 0n,
): Uint8Array {
  const buf = new Uint8Array(sdk.state.BOOK_HEADER_SIZE);
  const view = new DataView(buf.buffer);
  view.setBigInt64(8, bestBid, true);
  view.setBigInt64(16, bestAsk, true);
  view.setUint32(24, bids.length, true);
  view.setUint32(28, asks.length, true);
  const BIDS_OFFSET = 48;
  const ASKS_OFFSET = BIDS_OFFSET + 64 * 24;
  for (let i = 0; i < 64; i++) {
    const b = bids[i];
    if (b) {
      view.setBigInt64(BIDS_OFFSET + i * 24, b.price, true);
      view.setBigUint64(BIDS_OFFSET + i * 24 + 8, b.totalQty, true);
      view.setUint16(BIDS_OFFSET + i * 24 + 16, b.orderCount, true);
    }
    const a = asks[i];
    if (a) {
      view.setBigInt64(ASKS_OFFSET + i * 24, a.price, true);
      view.setBigUint64(ASKS_OFFSET + i * 24 + 8, a.totalQty, true);
      view.setUint16(ASKS_OFFSET + i * 24 + 16, a.orderCount, true);
    }
  }
  return buf;
}

function makeAccountInfo(data: Uint8Array): AccountInfo<Buffer> {
  return {
    data: Buffer.from(data),
    executable: false,
    lamports: 1_000_000,
    owner: MATCHER_PK,
    rentEpoch: 0,
  };
}

function resetStore() {
  useBookStore.setState({
    data: null,
    instrumentId: null,
    loading: false,
    error: null,
    lastFetchedAt: null,
    isPolling: false,
  });
  useBookStore.getState().stopPolling();
}

describe('useBookTopN', () => {
  beforeEach(() => {
    resetStore();
  });
  afterEach(() => {
    useBookStore.getState().stopPolling();
    globalThis.GLOBAL_CONNECTION = undefined;
  });

  it('returns bids sorted by price DESC and asks sorted by price ASC', async () => {
    const conn = new MockConnection();
    globalThis.GLOBAL_CONNECTION = conn as unknown as Connection;
    // On-chain order is arbitrary (matcher allocates first empty slot);
    // the hook is responsible for sorting. Provide many responses so
    // the polling interval doesn't drain the queue mid-assertion.
    const buf = makeAccountInfo(
      makeBookBuffer(
        [
          { price: 98n, totalQty: 1n, orderCount: 1 },
          { price: 99n, totalQty: 2n, orderCount: 1 },
          { price: 97n, totalQty: 3n, orderCount: 1 },
        ],
        [
          { price: 101n, totalQty: 1n, orderCount: 1 },
          { price: 100n, totalQty: 2n, orderCount: 1 },
          { price: 102n, totalQty: 3n, orderCount: 1 },
        ],
        99n,
        100n,
      ),
    );
    conn.responses = Array.from({ length: 50 }, () => buf);

    const { result } = renderHook(() => useBookTopN(0, 20, 50));

    await waitFor(() => {
      expect(result.current.bids.length).toBe(3);
      expect(result.current.asks.length).toBe(3);
    });

    expect(result.current.bids.map((l) => l.price)).toEqual([99n, 98n, 97n]);
    expect(result.current.asks.map((l) => l.price)).toEqual([100n, 101n, 102n]);
  });

  it('drops empty levels (orderCount === 0) and slices to depth', async () => {
    const conn = new MockConnection();
    globalThis.GLOBAL_CONNECTION = conn as unknown as Connection;
    // Mix populated and empty levels.
    const buf = makeAccountInfo(
      makeBookBuffer(
        [
          { price: 99n, totalQty: 1n, orderCount: 1 },
          { price: 0n, totalQty: 0n, orderCount: 0 },
          { price: 98n, totalQty: 1n, orderCount: 1 },
        ],
        [],
        99n,
        0n,
      ),
    );
    conn.responses = Array.from({ length: 50 }, () => buf);

    const { result } = renderHook(() => useBookTopN(0, 5, 50));

    await waitFor(() => {
      expect(result.current.bids.length).toBe(2);
    });

    expect(result.current.bids.map((l) => l.price)).toEqual([99n, 98n]);
    expect(result.current.asks).toEqual([]);
  });

  it('limits the returned levels to `depth` (10 of 30)', async () => {
    const conn = new MockConnection();
    globalThis.GLOBAL_CONNECTION = conn as unknown as Connection;
    const bids = Array.from({ length: 30 }, (_, i) => ({
      price: BigInt(1000 - i),
      totalQty: 1n,
      orderCount: 1,
    }));
    const buf = makeAccountInfo(makeBookBuffer(bids, [], 1000n, 0n));
    conn.responses = Array.from({ length: 50 }, () => buf);

    const { result } = renderHook(() => useBookTopN(0, 10, 50));

    await waitFor(() => {
      expect(result.current.bids.length).toBe(10);
    });
  });

  it('returns empty arrays when the book account is missing', async () => {
    const conn = new MockConnection();
    globalThis.GLOBAL_CONNECTION = conn as unknown as Connection;
    conn.responses = [null];

    const { result } = renderHook(() => useBookTopN(0, 20, 50));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.bids).toEqual([]);
    expect(result.current.asks).toEqual([]);
  });

  it('starts polling on mount and stops on unmount', async () => {
    const conn = new MockConnection();
    globalThis.GLOBAL_CONNECTION = conn as unknown as Connection;
    conn.responses = Array.from({ length: 100 }, () =>
      makeAccountInfo(makeBookBuffer([], [])),
    );

    const { unmount } = renderHook(() => useBookTopN(0, 20, 30));
    await waitFor(() => {
      expect(useBookStore.getState().isPolling).toBe(true);
    });

    await act(async () => {
      unmount();
    });
    expect(useBookStore.getState().isPolling).toBe(false);
  });
});
