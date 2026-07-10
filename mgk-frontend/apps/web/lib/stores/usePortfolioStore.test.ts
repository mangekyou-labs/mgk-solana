// @vitest-environment node
import { PublicKey, type AccountInfo, type Connection } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  usePortfolioStore,
  type PortfolioPollParams,
} from './usePortfolioStore';

const USER_PK = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const CORE_PK = new PublicKey('J5fVjwm96cQxcSqUz4QAmRBT75x7aN9NgG4xcnMmcfSv');

function makePortfolioBuffer(user: PublicKey, freeCollateral: bigint): Uint8Array {
    const buf = new Uint8Array(1456);
  buf.set(user.toBytes(), 0);
  const view = new DataView(buf.buffer);
  const lo = freeCollateral & 0xffffffffffffffffn;
  const hi = freeCollateral >> 64n;
  view.setBigUint64(112, lo, true);
  view.setBigInt64(120, hi, true);
  return buf;
}

function makeAccountInfo(data: Uint8Array): AccountInfo<Buffer> {
  return {
    data: Buffer.from(data),
    executable: false,
    lamports: 1_000_000,
    owner: USER_PK,
    rentEpoch: 0,
  };
}

class MockConnection {
  responses: Array<AccountInfo<Buffer> | null | Error> = [];
  calls: PublicKey[][] = [];
  private idx = 0;

  async getMultipleAccountsInfo(keys: PublicKey[]): Promise<(AccountInfo<Buffer> | null)[]> {
    this.calls.push(keys);
    const resp = this.responses[this.idx] ?? null;
    this.idx++;
    if (resp instanceof Error) throw resp;
    return [resp];
  }
}

function buildParams(
  conn: Connection,
  overrides: Partial<PortfolioPollParams> = {},
): PortfolioPollParams {
  return {
    user: USER_PK,
    connection: conn,
    programId: CORE_PK,
    intervalMs: 3000,
    ...overrides,
  };
}

function resetStore() {
  usePortfolioStore.setState({
    data: null,
    loading: false,
    error: null,
    lastFetchedAt: null,
    isPolling: false,
  });
  usePortfolioStore.getState().stopPolling();
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('usePortfolioStore', () => {
  beforeEach(() => {
    resetStore();
  });
  afterEach(() => {
    usePortfolioStore.getState().stopPolling();
  });

  it('starts polling, runs an initial fetch, and stores the decoded portfolio', async () => {
    const conn = new MockConnection();
    conn.responses = [makeAccountInfo(makePortfolioBuffer(USER_PK, 5_000_000n))];

    await usePortfolioStore.getState().startPolling(
      buildParams(conn as unknown as Connection, { intervalMs: 50 }),
    );

    expect(usePortfolioStore.getState().isPolling).toBe(true);
    expect(usePortfolioStore.getState().data?.user.toBase58()).toBe(USER_PK.toBase58());
    expect(usePortfolioStore.getState().data?.freeCollateral).toBe(5_000_000n);
    expect(usePortfolioStore.getState().error).toBeNull();
    expect(usePortfolioStore.getState().lastFetchedAt).not.toBeNull();
  });

  it('fires a fetch on every interval tick', async () => {
    const conn = new MockConnection();
    conn.responses = Array.from({ length: 10 }, () =>
      makeAccountInfo(makePortfolioBuffer(USER_PK, 1n)),
    );

    await usePortfolioStore.getState().startPolling(
      buildParams(conn as unknown as Connection, { intervalMs: 25 }),
    );
    expect(conn.calls.length).toBe(1);

    await wait(120);
    expect(conn.calls.length).toBeGreaterThanOrEqual(5);
  });

  it('stops polling: clears the interval and flips isPolling off', async () => {
    const conn = new MockConnection();
    conn.responses = Array.from({ length: 100 }, () =>
      makeAccountInfo(makePortfolioBuffer(USER_PK, 0n)),
    );

    await usePortfolioStore.getState().startPolling(
      buildParams(conn as unknown as Connection, { intervalMs: 20 }),
    );
    expect(usePortfolioStore.getState().isPolling).toBe(true);

    usePortfolioStore.getState().stopPolling();
    expect(usePortfolioStore.getState().isPolling).toBe(false);

    const callsAfterStop = conn.calls.length;
    await wait(100);
    expect(conn.calls.length).toBe(callsAfterStop);
  });

  it('sets data to null when the account is not found (no error)', async () => {
    const conn = new MockConnection();
    conn.responses = [null];

    await usePortfolioStore.getState().startPolling(
      buildParams(conn as unknown as Connection, { intervalMs: 50 }),
    );

    expect(usePortfolioStore.getState().data).toBeNull();
    expect(usePortfolioStore.getState().error).toBeNull();
  });

  it('captures errors from getMultipleAccountsInfo', async () => {
    const conn = new MockConnection();
    conn.responses = [new Error('RPC timeout')];

    await usePortfolioStore.getState().startPolling(
      buildParams(conn as unknown as Connection, { intervalMs: 50 }),
    );

    expect(usePortfolioStore.getState().data).toBeNull();
    expect(usePortfolioStore.getState().error).toMatch(/RPC timeout/);
    expect(usePortfolioStore.getState().loading).toBe(false);
  });

  it('captures errors from decodePortfolio (e.g. truncated buffer)', async () => {
    const conn = new MockConnection();
    const short = new Uint8Array(64); // < PORTFOLIO_SIZE
    conn.responses = [makeAccountInfo(short)];

    await usePortfolioStore.getState().startPolling(
      buildParams(conn as unknown as Connection, { intervalMs: 50 }),
    );

    expect(usePortfolioStore.getState().data).toBeNull();
    expect(usePortfolioStore.getState().error).toMatch(/buffer too small/);
  });

  it('refresh is a no-op when no polling is active', async () => {
    const conn = new MockConnection();
    await usePortfolioStore.getState().refresh();
    expect(conn.calls.length).toBe(0);
    expect(usePortfolioStore.getState().loading).toBe(false);
  });

  it('startPolling replaces any in-flight poll (no leaked intervals)', async () => {
    const conn1 = new MockConnection();
    conn1.responses = Array.from({ length: 100 }, () =>
      makeAccountInfo(makePortfolioBuffer(USER_PK, 1n)),
    );
    const conn2 = new MockConnection();
    conn2.responses = Array.from({ length: 100 }, () =>
      makeAccountInfo(makePortfolioBuffer(USER_PK, 2n)),
    );

    await usePortfolioStore.getState().startPolling(
      buildParams(conn1 as unknown as Connection, { intervalMs: 20 }),
    );
    const calls1 = conn1.calls.length;
    expect(calls1).toBe(1);

    await usePortfolioStore.getState().startPolling(
      buildParams(conn2 as unknown as Connection, { intervalMs: 20 }),
    );
    expect(conn1.calls.length).toBe(calls1);

    await wait(150);
    expect(conn1.calls.length).toBe(calls1);
    expect(conn2.calls.length).toBeGreaterThan(calls1);
  });
});
