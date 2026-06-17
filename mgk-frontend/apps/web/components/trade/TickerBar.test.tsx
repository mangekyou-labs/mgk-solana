import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

import { TickerBar } from './TickerBar';
import { config } from '@/lib/config';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  cleanup();
});

function mockFetchBodies(bodies: unknown[]) {
  let i = 0;
  globalThis.fetch = vi.fn().mockImplementation(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => bodies[i++] ?? { binary: { encoding: 'base64', data: [] }, parsed: [] },
  })) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.useRealTimers();
});

describe('<TickerBar />', () => {
  it('renders three ticker cells (BTC, ETH, SOL)', async () => {
    mockFetchBodies([{ binary: { encoding: 'base64', data: [] }, parsed: [] }]);
    render(<TickerBar />);
    expect(screen.getByTestId('ticker-bar')).toBeInTheDocument();
    expect(screen.getByTestId('ticker-btc-usd')).toBeInTheDocument();
    expect(screen.getByTestId('ticker-eth-usd')).toBeInTheDocument();
    expect(screen.getByTestId('ticker-sol-usd')).toBeInTheDocument();
  });

  it('renders the loading dots before the first fetch completes', () => {
    mockFetchBodies([]); // never resolves within the test
    globalThis.fetch = vi.fn(
      () => new Promise(() => {}),
    ) as unknown as typeof fetch;
    render(<TickerBar />);
    expect(screen.getByTestId('ticker-btc-usd-loading')).toBeInTheDocument();
    expect(screen.getByTestId('ticker-eth-usd-loading')).toBeInTheDocument();
    expect(screen.getByTestId('ticker-sol-usd-loading')).toBeInTheDocument();
  });

  it('renders a price once the first fetch resolves', async () => {
    mockFetchBodies([
      {
        binary: { encoding: 'base64', data: [] },
        parsed: [
          { id: `0x${config.pythBtcFeedId}`, price: { price: '100000000', conf: '0', expo: -8, publish_time: 1 }, ema_price: { price: '0', conf: '0', expo: -8, publish_time: 0 } },
          { id: `0x${config.pythEthFeedId}`, price: { price: '200000000', conf: '0', expo: -8, publish_time: 1 }, ema_price: { price: '0', conf: '0', expo: -8, publish_time: 0 } },
          { id: `0x${config.pythSolFeedId}`, price: { price: '300000000', conf: '0', expo: -8, publish_time: 1 }, ema_price: { price: '0', conf: '0', expo: -8, publish_time: 0 } },
        ],
      },
    ]);
    render(<TickerBar />);
    await waitFor(() => {
      expect(screen.getByTestId('ticker-btc-usd')).toHaveTextContent('1.00');
    });
  });

  it('renders the error dash + warn tone when fetch fails', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch;
    render(<TickerBar />);
    await waitFor(() => {
      expect(screen.getByTestId('ticker-btc-usd-error')).toBeInTheDocument();
    });
  });

  it('has 32px (h-8) height on the bar', () => {
    mockFetchBodies([]);
    render(<TickerBar />);
    const bar = screen.getByTestId('ticker-bar');
    expect(bar.className).toContain('h-8');
  });

  it('shows the Pyth source label on the right', () => {
    mockFetchBodies([]);
    render(<TickerBar />);
    expect(screen.getByText(/Pyth/)).toBeInTheDocument();
  });
});
