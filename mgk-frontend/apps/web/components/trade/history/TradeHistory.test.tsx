import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';

import { __resetMyFillsStore } from '@/lib/stores/useMyFillsStore';
import { TradeHistory } from './TradeHistory';

const PUBKEY = 'DdqGmK5uamYN5vmuZrzpQhKeehLdwtPLVJdhu5P2iJKC';

const FILLS_BODY = {
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
      ts_estimate: 1700000000400,
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
      ts_estimate: 1700000000800,
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

describe('TradeHistory', () => {
  beforeEach(() => {
    __resetMyFillsStore();
    globalThis.fetch = vi.fn();
    mockWallet = {
      publicKey: { toBase58: () => PUBKEY },
      connected: true,
    };
  });

  afterEach(() => {
    __resetMyFillsStore();
    vi.restoreAllMocks();
  });

  it('renders the disconnected state when wallet is not connected', () => {
    mockWallet = { publicKey: null, connected: false };
    render(<TradeHistory />);
    expect(screen.getByTestId('trade-history-disconnected')).toHaveTextContent(
      'Connect a wallet',
    );
  });

  it('renders the loading state on initial render', () => {
    globalThis.fetch = vi.fn().mockReturnValue(new Promise(() => {}));
    render(<TradeHistory />);
    expect(screen.getByTestId('trade-history-loading')).toBeInTheDocument();
  });

  it('renders the empty state when the user has no fills', async () => {
    globalThis.fetch = mockFetchOnce({ fills: [] });
    render(<TradeHistory />);
    await waitFor(() => {
      expect(screen.getByTestId('trade-history-empty')).toBeInTheDocument();
    });
    expect(screen.getByTestId('trade-history-empty')).toHaveTextContent(
      'You have no trades yet.',
    );
  });

  it('renders the error state when the indexer returns non-OK', async () => {
    globalThis.fetch = mockFetchOnce({ error: 'no' }, 500);
    render(<TradeHistory />);
    await waitFor(() => {
      expect(screen.getByTestId('trade-history-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('trade-history-error')).toHaveTextContent('500');
  });

  it('renders one row per fill with the right side/role', async () => {
    globalThis.fetch = mockFetchOnce(FILLS_BODY);
    render(<TradeHistory />);
    await waitFor(() => {
      expect(screen.getByTestId('trade-history')).toBeInTheDocument();
    });
    const rows = screen.getAllByTestId('trade-history-row');
    expect(rows).toHaveLength(2);
    const first = rows[0]!;
    expect(first.getAttribute('data-slot')).toBe('1001');
    expect(first.getAttribute('data-role')).toBe('taker');
    expect(within(first).getByTestId('trade-history-role')).toHaveTextContent('taker');
  });

  it('renders the explorer link for each fill', async () => {
    globalThis.fetch = mockFetchOnce(FILLS_BODY);
    render(<TradeHistory />);
    await waitFor(() => {
      expect(screen.getByTestId('trade-history')).toBeInTheDocument();
    });
    const links = screen.getAllByTestId('trade-history-tx-link');
    expect(links).toHaveLength(2);
    expect(links[0]?.getAttribute('href')).toContain('explorer.solana.com');
    expect(links[0]?.getAttribute('target')).toBe('_blank');
  });
});
