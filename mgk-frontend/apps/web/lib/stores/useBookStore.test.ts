// @vitest-environment node
import { PublicKey, type AccountInfo, type Connection } from '@solana/web3.js';
import * as sdk from '@mgk/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useBookStore, type BookPollParams } from './useBookStore';

const MATCHER_PK = new PublicKey('9o2vTBBhEp6CYxNsDPsX79Euhzh8TtoLTSHR5R3jXebZ');

function makeBookBuffer(
  bids: Array<{ price: bigint; totalQty: bigint; orderCount: number }> = [],
  asks: Array<{ price: bigint; totalQty: bigint; orderCount: number }> = [],
  overrides: Partial<{
    instrumentId: number;
    bestBid: bigint;
    bestAsk: bigint;
    nextOrderId: bigint;
    lastUpdateSlot: bigint;
  }> = {},
): Uint8Array {
  const buf = new Uint8Array(sdk.state.BOOK_HEADER_SIZE);
  const view = new DataView(buf.buffer);
  view.setUint16(0, overrides.instrumentId ?? 7, true);
  view.setBigInt64(8, overrides.bestBid ?? 0n, true);
  view.setBigInt64(16, overrides.bestAsk ?? 0n, true);
  view.setUint32(24, bids.length, true);
  view.setUint32(28, asks.length, true);
  view.setBigUint64(32, overrides.nextOrderId ?? 0n, true);
  view.setBigUint64(40, overrides.lastUpdateSlot ?? 0n, true);
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

class MockConnection {
  responses: Array<AccountInfo<Buffer> | null | Error> = [];
  calls: PublicKey[][] = [];
  private idx = 0;

  async getMultipleAccountsInfo(
    keys: PublicKey[],
  ): Promise<(AccountInfo<Buffer> | null)[]> {
    this.calls.push(keys);
    const resp = this.responses[this.idx++] ?? null;
    if (resp instanceof Error) throw resp;
    return [resp];
  }
}

function buildParams(
  conn: Connection,
  overrides: Partial<BookPollParams> = {},
): BookPollParams {
  return {
    connection: conn,
    programId: MATCHER_PK,
    instrumentId: 0,
    intervalMs: 3000,
    ...overrides,
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

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('useBookStore', () => {
  beforeEach(() => {
    resetStore();
  });
  afterEach(() => {
    useBookStore.getState().stopPolling();
  });

  it('decodes the Book header from the matcher Book PDA', async () => {
    const conn = new MockConnection();
    conn.responses = [
      makeAccountInfo(
        makeBookBuffer(
          [
            { price: 150_000_000n, totalQty: 3_000_000n, orderCount: 2 },
            { price: 149_900_000n, totalQty: 1_500_000n, orderCount: 1 },
          ],
          [{ price: 150_500_000n, totalQty: 2_000_000n, orderCount: 1 }],
          { bestBid: 150_000_000n, bestAsk: 150_500_000n, instrumentId: 0 },
        ),
      ),
    ];

    await useBookStore.getState().startPolling(
      buildParams(conn as unknown as Connection, { intervalMs: 50 }),
    );

    const state = useBookStore.getState();
    expect(state.isPolling).toBe(true);
    expect(state.instrumentId).toBe(0);
    expect(state.data?.instrumentId).toBe(0);
    expect(state.data?.bestBid).toBe(150_000_000n);
    expect(state.data?.bestAsk).toBe(150_500_000n);
    expect(state.data?.bidCount).toBe(2);
    expect(state.data?.askCount).toBe(1);
    expect(state.data?.bids[0]?.price).toBe(150_000_000n);
    expect(state.data?.bids[1]?.price).toBe(149_900_000n);
    expect(state.data?.asks[0]?.price).toBe(150_500_000n);
    expect(state.error).toBeNull();
    expect(conn.calls.length).toBe(1);
  });

  it('handles Book PDA missing (instrument not initialized) — clears data, no error', async () => {
    const conn = new MockConnection();
    conn.responses = [null];

    await useBookStore.getState().startPolling(
      buildParams(conn as unknown as Connection, { intervalMs: 50 }),
    );

    const state = useBookStore.getState();
    expect(state.data).toBeNull();
    expect(state.error).toBeNull();
    expect(state.lastFetchedAt).not.toBeNull();
  });

  it('handles a zeroed book (deployed but empty) — returns empty header', async () => {
    const conn = new MockConnection();
    conn.responses = [makeAccountInfo(makeBookBuffer())];

    await useBookStore.getState().startPolling(
      buildParams(conn as unknown as Connection, { intervalMs: 50 }),
    );

    const state = useBookStore.getState();
    expect(state.data?.bestBid).toBe(0n);
    expect(state.data?.bestAsk).toBe(0n);
    expect(state.data?.bidCount).toBe(0);
    expect(state.data?.askCount).toBe(0);
    expect(state.error).toBeNull();
  });

  it('captures errors from getMultipleAccountsInfo', async () => {
    const conn = new MockConnection();
    conn.responses = [new Error('RPC timeout')];

    await useBookStore.getState().startPolling(
      buildParams(conn as unknown as Connection, { intervalMs: 50 }),
    );

    const state = useBookStore.getState();
    expect(state.data).toBeNull();
    expect(state.error).toMatch(/RPC timeout/);
    expect(state.loading).toBe(false);
  });

  it('captures errors from decodeBookHeader (truncated buffer)', async () => {
    const conn = new MockConnection();
    const short = new Uint8Array(64);
    conn.responses = [makeAccountInfo(short)];

    await useBookStore.getState().startPolling(
      buildParams(conn as unknown as Connection, { intervalMs: 50 }),
    );

    const state = useBookStore.getState();
    expect(state.data).toBeNull();
    expect(state.error).toMatch(/buffer too small/);
  });

  it('fires a refresh on every interval tick', async () => {
    const conn = new MockConnection();
    conn.responses = Array.from({ length: 20 }, () =>
      makeAccountInfo(makeBookBuffer()),
    );

    await useBookStore.getState().startPolling(
      buildParams(conn as unknown as Connection, { intervalMs: 25 }),
    );
    expect(conn.calls.length).toBe(1);

    await wait(120);
    expect(conn.calls.length).toBeGreaterThanOrEqual(5);
  });

  it('stops polling: clears the interval and flips isPolling off', async () => {
    const conn = new MockConnection();
    conn.responses = Array.from({ length: 100 }, () =>
      makeAccountInfo(makeBookBuffer()),
    );

    await useBookStore.getState().startPolling(
      buildParams(conn as unknown as Connection, { intervalMs: 20 }),
    );
    expect(useBookStore.getState().isPolling).toBe(true);

    useBookStore.getState().stopPolling();
    expect(useBookStore.getState().isPolling).toBe(false);

    const callsAfterStop = conn.calls.length;
    await wait(100);
    expect(conn.calls.length).toBe(callsAfterStop);
  });

  it('startPolling replaces any in-flight poll (no leaked intervals)', async () => {
    const conn1 = new MockConnection();
    conn1.responses = Array.from({ length: 100 }, () =>
      makeAccountInfo(makeBookBuffer()),
    );
    const conn2 = new MockConnection();
    conn2.responses = Array.from({ length: 100 }, () =>
      makeAccountInfo(makeBookBuffer()),
    );

    await useBookStore.getState().startPolling(
      buildParams(conn1 as unknown as Connection, { instrumentId: 0, intervalMs: 20 }),
    );
    const calls1 = conn1.calls.length;
    expect(calls1).toBe(1);

    await useBookStore.getState().startPolling(
      buildParams(conn2 as unknown as Connection, { instrumentId: 1, intervalMs: 20 }),
    );
    expect(useBookStore.getState().instrumentId).toBe(1);
    expect(conn1.calls.length).toBe(calls1);

    await wait(150);
    expect(conn1.calls.length).toBe(calls1);
    expect(conn2.calls.length).toBeGreaterThan(calls1);
  });

    it('uses an explicit bookAddress override instead of deriving the PDA', async () => {
    const customBook = new PublicKey('5nfbjqTYpsnHnmCifdFpwLwajhyb8n6orVvbMbSrGT6w');
    const conn = new MockConnection();
    conn.responses = [
      makeAccountInfo(
        makeBookBuffer(
          [{ price: 150_000n, totalQty: 100n, orderCount: 1 }],
          [],
          { instrumentId: 0, bestBid: 150_000n },
        ),
      ),
    ];

    await useBookStore.getState().startPolling(
      buildParams(conn as unknown as Connection, { bookAddress: customBook }),
    );

    // Should fetch from the override address, not the derived PDA
    expect(conn.calls[0][0]).toEqual(customBook);
    expect(useBookStore.getState().data?.bidCount).toBe(1);
    expect(useBookStore.getState().data?.bestBid).toBe(150_000n);
  });

  it('refresh is a no-op when no polling is active', async () => {
    const conn = new MockConnection();
    await useBookStore.getState().refresh();
    expect(conn.calls.length).toBe(0);
    expect(useBookStore.getState().loading).toBe(false);
  });
});
