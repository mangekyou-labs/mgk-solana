import { renderHook, waitFor } from '@testing-library/react';
import { PublicKey, type AccountInfo, type Connection } from '@solana/web3.js';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// jsdom's crypto stack does not implement every elliptic-curve primitive
// `@solana/web3.js` needs for `findProgramAddressSync`. Mock the PDA derivation
// to a known pubkey so we can exercise the polling path under jsdom.
vi.mock('@solana/wallet-adapter-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/wallet-adapter-react')>();
  return {
    ...actual,
    useWallet: vi.fn(),
    useConnection: vi.fn(),
  };
});

vi.mock('@mgk/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mgk/sdk')>();
  return {
    ...actual,
    derivePortfolioPda: vi.fn(
      () =>
        [
          new PublicKey('11111111111111111111111111111111'),
          255,
        ] as const,
    ),
  };
});

const { usePortfolioPolling, usePortfolioStore } = await import(
  './usePortfolioStore'
);

const USER_PK = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

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

describe('usePortfolioPolling hook', () => {
  beforeEach(() => {
    resetStore();
  });
  afterEach(() => {
    usePortfolioStore.getState().stopPolling();
  });

  function mockWallet(publicKey: PublicKey | null, connected: boolean) {
    vi.mocked(useWallet).mockReturnValue({
      publicKey,
      connected,
      connecting: false,
      disconnecting: false,
      wallet: null,
      wallets: [],
      autoConnect: false,
      select: vi.fn(),
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      sendTransaction: vi.fn().mockResolvedValue('mock-sig'),
      signTransaction: undefined,
      signAllTransactions: undefined,
      signMessage: undefined,
      signIn: undefined,
    } as never);
  }

  function mockConnection(conn: Connection) {
    vi.mocked(useConnection).mockReturnValue({ connection: conn } as never);
  }

  it('starts polling when wallet is connected and exposes decoded data', async () => {
    const conn = new MockConnection();
    conn.responses = [makeAccountInfo(makePortfolioBuffer(USER_PK, 7_000_000n))];
    mockConnection(conn as unknown as Connection);
    mockWallet(USER_PK, true);

    const { result } = renderHook(() => usePortfolioPolling(50));

    await waitFor(() => {
      expect(result.current.data?.freeCollateral).toBe(7_000_000n);
    });
    expect(result.current.isPolling).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('does not poll when wallet is disconnected', () => {
    const conn = new MockConnection();
    mockConnection(conn as unknown as Connection);
    mockWallet(null, false);

    const { result } = renderHook(() => usePortfolioPolling(50));

    expect(result.current.isPolling).toBe(false);
    expect(result.current.data).toBeNull();
  });

  it('stops polling when wallet disconnects mid-session', async () => {
    const conn = new MockConnection();
    conn.responses = Array.from({ length: 100 }, () =>
      makeAccountInfo(makePortfolioBuffer(USER_PK, 0n)),
    );
    mockConnection(conn as unknown as Connection);
    mockWallet(USER_PK, true);

    const { result, rerender } = renderHook(() => usePortfolioPolling(25));
    await waitFor(() => expect(result.current.isPolling).toBe(true));

    const callsBefore = conn.calls.length;
    mockWallet(null, false);
    rerender();
    expect(result.current.isPolling).toBe(false);

    await wait(120);
    expect(conn.calls.length).toBe(callsBefore);
  });
});
