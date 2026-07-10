import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

import {
  __resetMyFillsStore,
  startMyFillsPolling,
  stopMyFillsPolling,
  useMyFills,
  useMyFillsStore,
} from './useMyFillsStore';

const PUBKEY = 'DdqGmK5uamYN5vmuZrzpQhKeehLdwtPLVJdhu5P2iJKC';
const INSTRUMENT = 0;
const FILLS_RESPONSE = {
  fills: [
    {
      slot: 1001,
      batch_id: 1,
      instrument_id: 0,
      taker_side: 0,
      price: 150_400_000,
      qty: 5_000_000,
      role: 'taker',
      tx_signature: 'YWFhYWE=',
      ts_estimate: 1001 * 400,
    },
    {
      slot: 1002,
      batch_id: 1,
      instrument_id: 0,
      taker_side: 1,
      price: 151_000_000,
      qty: 3_000_000,
      role: 'maker',
      tx_signature: 'YmJiYmI=',
      ts_estimate: 1002 * 400,
    },
  ],
};

function mockFetchOnce(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

let mockWallet: { publicKey: { toBase58: () => string } | null; connected: boolean };
vi.mock('@solana/wallet-adapter-react', () => ({
  useWallet: () => mockWallet,
}));

describe('useMyFillsStore', () => {
  beforeEach(() => {
    __resetMyFillsStore();
    globalThis.fetch = vi.fn();
    mockWallet = {
      publicKey: { toBase58: () => PUBKEY },
      connected: true,
    };
  });

  afterEach(() => {
    stopMyFillsPolling();
    vi.restoreAllMocks();
    __resetMyFillsStore();
  });

  it('starts empty and not polling', () => {
    const s = useMyFillsStore.getState();
    expect(s.fills).toEqual([]);
    expect(s.loading).toBe(false);
    expect(s.isPolling).toBe(false);
  });

  it('fetches fills and populates the store', async () => {
    globalThis.fetch = mockFetchOnce(FILLS_RESPONSE);
    await startMyFillsPolling(PUBKEY, INSTRUMENT, 60_000);
    const s = useMyFillsStore.getState();
    expect(s.fills).toEqual(FILLS_RESPONSE.fills);
    expect(s.error).toBeNull();
    expect(s.lastFetchedAt).toBeGreaterThan(0);
  });

  it('calls the correct indexer URL', async () => {
    const fetchMock = mockFetchOnce(FILLS_RESPONSE);
    globalThis.fetch = fetchMock;
    await startMyFillsPolling(PUBKEY, INSTRUMENT, 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain(`/api/users/${PUBKEY}/fills`);
    expect(url).toContain(`instrumentId=${INSTRUMENT}`);
    expect(url).toContain('limit=200');
  });

  it('records an error when the indexer returns non-OK', async () => {
    globalThis.fetch = mockFetchOnce({ error: 'no' }, 500);
    await startMyFillsPolling(PUBKEY, INSTRUMENT, 60_000);
    const s = useMyFillsStore.getState();
    expect(s.error).toMatch(/500/);
    expect(s.fills).toEqual([]);
  });

  it('records an error string on network failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('connection refused'));
    await startMyFillsPolling(PUBKEY, INSTRUMENT, 60_000);
    const s = useMyFillsStore.getState();
    expect(s.error).toMatch(/connection refused/);
  });

  it('restarts the interval when called twice with different params', async () => {
    const fetchMock = mockFetchOnce(FILLS_RESPONSE);
    globalThis.fetch = fetchMock;
    await startMyFillsPolling(PUBKEY, 0, 60_000);
    await startMyFillsPolling(PUBKEY, 1, 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const lastUrl = fetchMock.mock.calls[1]![0] as string;
    expect(lastUrl).toContain('instrumentId=1');
  });

  it('the useMyFills hook auto-starts on mount with the connected wallet', async () => {
    globalThis.fetch = mockFetchOnce(FILLS_RESPONSE);
    renderHook(() => useMyFills(INSTRUMENT, 60_000));
    await waitFor(() => {
      expect(useMyFillsStore.getState().fills.length).toBe(2);
    });
  });
});
