import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as sdk from '@mgk/sdk';
import { PublicKey } from '@solana/web3.js';
import { cleanup, render, screen } from '@testing-library/react';

import { MarketHeader } from './MarketHeader';

// --- mocks ---

type BookState = {
  bids: { price: bigint; totalQty: bigint; orderCount: number }[];
  asks: { price: bigint; totalQty: bigint; orderCount: number }[];
  loading: boolean;
  error: string | null;
};

type BatchState = sdk.state.BatchState | null;

const mockState = {
  book: {
    bids: [] as BookState['bids'],
    asks: [] as BookState['asks'],
    loading: false,
    error: null as string | null,
  } satisfies BookState,
  batch: null as BatchState,
  registry: null as sdk.state.RegistryState | null,
  currentBatchId: null as bigint | null,
  currentSlot: null as number | null,
  marketState: {
    data: null as {
      instrument_id: number;
      last_price: number;
      mark_price: number;
      open_interest_long: number;
      open_interest_short: number;
      funding_rate: number;
      volume_24h: number;
      updated_ts: number;
    } | null,
    isPolling: true,
  },
  health: {
    status: 'healthy' as 'warming' | 'healthy' | 'degraded' | 'critical',
    slotLag: 0 as number | null,
  },
};

vi.mock('@/lib/stores/useBookStore', () => ({
  useBookTopN: () => mockState.book,
}));

vi.mock('@/lib/stores/useBatchStore', () => ({
  useBatchPolling: () => ({
    data: mockState.batch,
    registry: mockState.registry,
    currentBatchId: mockState.currentBatchId,
  }),
}));

vi.mock('@/lib/stores/useSlotPolling', () => ({
  useSlotPolling: () => ({ slot: mockState.currentSlot }),
}));

vi.mock('@/lib/stores/useMarketStateStore', () => ({
  useMarketStatePolling: () => mockState.marketState,
}));

vi.mock('@/lib/stores/useIndexerHealthStore', () => ({
  useIndexerHealth: () => mockState.health,
}));

function resetMockState() {
  mockState.book = { bids: [], asks: [], loading: false, error: null };
  mockState.batch = null;
  mockState.registry = null;
  mockState.currentBatchId = null;
  mockState.currentSlot = null;
  mockState.marketState = { data: null, isPolling: true };
  mockState.health = { status: 'healthy', slotLag: 0 };
}

beforeEach(resetMockState);
afterEach(() => {
  cleanup();
});

describe('<MarketHeader />', () => {
  it('renders the market selector with SOL-USD Perp', () => {
    render(<MarketHeader />);
    const sel = screen.getByTestId('market-selector');
    expect(sel).toHaveTextContent(/SOL-USD Perp/i);
    expect(sel).toBeDisabled();
  });

  it('shows the empty state when there is no book data', () => {
    render(<MarketHeader />);
    expect(screen.getByTestId('last-price-empty')).toHaveTextContent('—');
    expect(screen.getByText(/awaiting first fill/i)).toBeInTheDocument();
  });

  it('shows the book midpoint with a Mid badge when both sides have a level', () => {
    mockState.book = {
      bids: [{ price: 150_000_000n, totalQty: 1_000_000n, orderCount: 1 }],
      asks: [{ price: 150_500_000n, totalQty: 1_000_000n, orderCount: 1 }],
      loading: false,
      error: null,
    };
    render(<MarketHeader />);
    // midpoint = (150_000_000 + 150_500_000) / 2 = 150_250_000 (1e6 scale = 150.25)
    expect(screen.getByTestId('last-price-block')).toHaveTextContent(/150\.25/);
    expect(screen.getByTestId('last-price-block')).toHaveTextContent(/Mid/i);
  });

  it('does not present a midpoint when the book is crossed', () => {
    mockState.book = {
      bids: [{ price: 76_550_000n, totalQty: 10_000n, orderCount: 1 }],
      asks: [{ price: 100_000n, totalQty: 200_000n, orderCount: 1 }],
      loading: false,
      error: null,
    };
    render(<MarketHeader />);
    expect(screen.getByTestId('last-price-empty')).toHaveTextContent('—');
    expect(screen.getByTestId('last-price-crossed')).toHaveTextContent(
      'book crossed',
    );
    expect(screen.getByTestId('stat-last')).toHaveTextContent('—');
    expect(screen.getByTestId('stat-last').title).toMatch(/crossed/i);
  });

  it('shows the Last stat matching the midpoint', () => {
    mockState.book = {
      bids: [{ price: 150_000_000n, totalQty: 1_000_000n, orderCount: 1 }],
      asks: [{ price: 150_500_000n, totalQty: 1_000_000n, orderCount: 1 }],
      loading: false,
      error: null,
    };
    render(<MarketHeader />);
    const last = screen.getByTestId('stat-last');
    expect(last).toHaveTextContent(/150\.25/);
  });

  it('shows Oracle / 24h Vol / OI as em-dash with tooltips', () => {
    render(<MarketHeader />);
    const oracle = screen.getByTestId('stat-oracle');
    const vol = screen.getByTestId('stat-24h-vol');
    const oi = screen.getByTestId('stat-oi');
    expect(oracle).toHaveTextContent('—');
    expect(vol).toHaveTextContent('—');
    expect(oi).toHaveTextContent('—');
    expect(oracle.title).toMatch(/not surfaced/i);
    expect(vol.title).toMatch(/indexer/i);
  });

  it('shows Batch: — when there is no batch data', () => {
    render(<MarketHeader />);
    expect(screen.getByText(/Batch:\s*—/)).toBeInTheDocument();
  });

  it('explains that orders are open before the DFBA close slot', () => {
    mockState.batch = {
      batchId: 1n,
      status: sdk.state.BatchStatus.Collecting,
      commitDeadlineSlot: 100_000n,
      revealDeadlineSlot: 100_100n,
      closeSlot: 100_200n,
      shuffleSeed: 0n,
      clearingPrice: 0n,
      totalCommitments: 0,
      totalRevealed: 0,
      totalSettled: 0,
      totalVolume: 0n,
      totalNotional: 0n,
      slashedDeposits: 0n,
      bump: 255,
      bidClearingPrice: 0n,
      askClearingPrice: 0n,
      matchedBidQty: 0n,
      matchedAskQty: 0n,
      markValid: false,
      liqPaused: true,
    };
    mockState.currentSlot = 99_500; // 500 slots × 0.4s = 200s = 00:03:20
    render(<MarketHeader />);
    expect(screen.getByTestId('market-header-batch')).toHaveTextContent(
      /Batch:\s*Collecting/i,
    );
    expect(screen.getByTestId('market-header-intent')).toHaveTextContent(
      'Orders open · Dual auction in 00:03:20',
    );
  });

  it('explains that an eligible batch is waiting for the keeper', () => {
    mockState.batch = {
      batchId: 1n,
      status: sdk.state.BatchStatus.Collecting,
      commitDeadlineSlot: 100_000n,
      revealDeadlineSlot: 100_100n,
      closeSlot: 100_200n,
      shuffleSeed: 0n,
      clearingPrice: 0n,
      totalCommitments: 0,
      totalRevealed: 0,
      totalSettled: 0,
      totalVolume: 0n,
      totalNotional: 0n,
      slashedDeposits: 0n,
      bump: 255,
      bidClearingPrice: 0n,
      askClearingPrice: 0n,
      matchedBidQty: 0n,
      matchedAskQty: 0n,
      markValid: false,
      liqPaused: true,
    };
    mockState.currentSlot = 100_500;
    render(<MarketHeader />);
    expect(screen.getByTestId('market-header-intent')).toHaveTextContent(
      'Ready to clear · Waiting for keeper',
    );
    expect(screen.getByTestId('market-header-batch')).not.toHaveTextContent(
      /past deadline/i,
    );
  });

  it('explains that an expired batch still needs minimum flow', () => {
    mockState.batch = {
      batchId: 1n,
      status: sdk.state.BatchStatus.Collecting,
      commitDeadlineSlot: 100_000n,
      revealDeadlineSlot: 100_100n,
      closeSlot: 100_200n,
      shuffleSeed: 0n,
      clearingPrice: 0n,
      totalCommitments: 0,
      totalRevealed: 0,
      totalSettled: 0,
      totalVolume: 0n,
      totalNotional: 0n,
      slashedDeposits: 0n,
      bump: 255,
      bidClearingPrice: 0n,
      askClearingPrice: 0n,
      matchedBidQty: 0n,
      matchedAskQty: 0n,
      markValid: false,
      liqPaused: true,
    };
    mockState.registry = {
      governance: PublicKey.default,
      pauseFlags: 0,
      batchIdCounter: 2n,
      baseDeposit: 10_000_000n,
      nMin: 1,
      tMinSlots: 4n,
      tMaxSlots: 400n,
      tRevealSlots: 50n,
      instrumentCount: 1,
      volatilityMultiplier: 10_000,
      bump: 255,
    };
    mockState.currentSlot = 100_500;
    render(<MarketHeader />);
    expect(screen.getByTestId('market-header-intent')).toHaveTextContent(
      'Orders open · Waiting for minimum flow (0/1)',
    );
  });

  it('renders cached 24h volume and OI without stale indicator when healthy', () => {
    mockState.marketState = {
      data: {
        instrument_id: 0,
        last_price: 150_000_000,
        mark_price: 150_000_000,
        open_interest_long: 10_000_000,
        open_interest_short: 10_000_000,
        funding_rate: 0,
        volume_24h: 50_000_000,
        updated_ts: Date.now(),
      },
      isPolling: true,
    };
    mockState.health = { status: 'healthy', slotLag: 0 };
    render(<MarketHeader />);

    const volStat = screen.getByTestId('stat-24h-vol');
    expect(volStat).toHaveTextContent('50.00');
    expect(volStat).not.toHaveTextContent(/stale/i);

    const oiStat = screen.getByTestId('stat-oi');
    expect(oiStat).toHaveTextContent('20.00');
    expect(oiStat).not.toHaveTextContent(/stale/i);
  });

  it('renders cached 24h volume and OI WITH visible stale indicator when degraded', () => {
    mockState.marketState = {
      data: {
        instrument_id: 0,
        last_price: 150_000_000,
        mark_price: 150_000_000,
        open_interest_long: 10_000_000,
        open_interest_short: 10_000_000,
        funding_rate: 0,
        volume_24h: 50_000_000,
        updated_ts: Date.now(),
      },
      isPolling: true,
    };
    mockState.health = { status: 'degraded', slotLag: 25 };
    render(<MarketHeader />);

    const volStat = screen.getByTestId('stat-24h-vol');
    expect(volStat).toHaveTextContent('50.00');
    expect(volStat).toHaveTextContent(/stale/i);
    expect(volStat.getAttribute('title')).toContain('stale');

    const oiStat = screen.getByTestId('stat-oi');
    expect(oiStat).toHaveTextContent('20.00');
    expect(oiStat).toHaveTextContent(/stale/i);
    expect(oiStat.getAttribute('title')).toContain('stale');
  });

  it('renders cached 24h volume and OI WITH visible stale indicator when critical', () => {
    mockState.marketState = {
      data: {
        instrument_id: 0,
        last_price: 150_000_000,
        mark_price: 150_000_000,
        open_interest_long: 10_000_000,
        open_interest_short: 10_000_000,
        funding_rate: 0,
        volume_24h: 50_000_000,
        updated_ts: Date.now() - 120_000, // 2 min ago
      },
      isPolling: true,
    };
    mockState.health = { status: 'critical', slotLag: 60 };
    render(<MarketHeader />);

    const volStat = screen.getByTestId('stat-24h-vol');
    expect(volStat).toHaveTextContent('50.00');
    expect(volStat).toHaveTextContent(/stale/i);

    const oiStat = screen.getByTestId('stat-oi');
    expect(oiStat).toHaveTextContent('20.00');
    expect(oiStat).toHaveTextContent(/stale/i);
  });

  it('shows as-of timestamp when indexer is stale and data has been loaded', () => {
    const twoMinAgo = Date.now() - 120_000;
    mockState.marketState = {
      data: {
        instrument_id: 0,
        last_price: 150_000_000,
        mark_price: 150_000_000,
        open_interest_long: 10_000_000,
        open_interest_short: 10_000_000,
        funding_rate: 0,
        volume_24h: 50_000_000,
        updated_ts: twoMinAgo,
      },
      isPolling: true,
    };
    mockState.health = { status: 'degraded', slotLag: 15 };
    render(<MarketHeader />);

    const volStat = screen.getByTestId('stat-24h-vol');
    expect(volStat).toHaveTextContent(/as of/);

    const oiStat = screen.getByTestId('stat-oi');
    expect(oiStat).toHaveTextContent(/as of/);
  });

  it('does not show as-of timestamp when indexer is healthy', () => {
    mockState.marketState = {
      data: {
        instrument_id: 0,
        last_price: 150_000_000,
        mark_price: 150_000_000,
        open_interest_long: 10_000_000,
        open_interest_short: 10_000_000,
        funding_rate: 0,
        volume_24h: 50_000_000,
        updated_ts: Date.now(),
      },
      isPolling: true,
    };
    mockState.health = { status: 'healthy', slotLag: 0 };
    render(<MarketHeader />);

    expect(screen.getByTestId('stat-24h-vol')).not.toHaveTextContent(/as of/);
    expect(screen.getByTestId('stat-oi')).not.toHaveTextContent(/as of/);
  });

  it('shows em-dash for OI/volume when no data has ever loaded', () => {
    mockState.marketState = { data: null, isPolling: true };
    mockState.health = { status: 'warming', slotLag: null };
    render(<MarketHeader />);

    // "—" indicates never-loaded, not stale
    expect(screen.getByTestId('stat-24h-vol')).toHaveTextContent('—');
    expect(screen.getByTestId('stat-oi')).toHaveTextContent('—');
    // No stale indicator when never loaded
    expect(screen.queryByTestId('stat-stale-24h-vol')).not.toBeInTheDocument();
    expect(screen.queryByTestId('stat-stale-oi')).not.toBeInTheDocument();
  });
});
