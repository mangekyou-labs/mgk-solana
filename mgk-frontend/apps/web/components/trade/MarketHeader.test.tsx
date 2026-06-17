import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as sdk from '@mgk/sdk';
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
  currentBatchId: null as bigint | null,
  currentSlot: null as number | null,
};

vi.mock('@/lib/stores/useBookStore', () => ({
  useBookTopN: () => mockState.book,
}));

vi.mock('@/lib/stores/useBatchStore', () => ({
  useBatchPolling: () => ({
    data: mockState.batch,
    currentBatchId: mockState.currentBatchId,
  }),
}));

vi.mock('@/lib/stores/useSlotPolling', () => ({
  useSlotPolling: () => ({ slot: mockState.currentSlot }),
}));

function resetMockState() {
  mockState.book = { bids: [], asks: [], loading: false, error: null };
  mockState.batch = null;
  mockState.currentBatchId = null;
  mockState.currentSlot = null;
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
    expect(oracle.title).toMatch(/keeper/i);
    expect(vol.title).toMatch(/indexer/i);
  });

  it('shows Batch: — when there is no batch data', () => {
    render(<MarketHeader />);
    expect(screen.getByText(/Batch:\s*—/)).toBeInTheDocument();
  });

  it('shows the phase pill + countdown when batch is loaded', () => {
    mockState.batch = {
      batchId: 1n,
      status: sdk.state.BatchStatus.Committing,
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
    };
    mockState.currentSlot = 99_500; // 500 slots × 0.4s = 200s = 00:03:20
    render(<MarketHeader />);
    expect(screen.getByTestId('market-header-batch')).toHaveTextContent(
      /Batch:\s*Committing/i,
    );
    expect(screen.getByTestId('market-header-countdown')).toHaveTextContent(
      '00:03:20',
    );
  });

  it('shows past deadline for the countdown when currentSlot > deadline', () => {
    mockState.batch = {
      batchId: 1n,
      status: sdk.state.BatchStatus.Committing,
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
    };
    mockState.currentSlot = 100_500;
    render(<MarketHeader />);
    expect(screen.getByTestId('market-header-countdown')).toHaveTextContent(
      /past deadline/i,
    );
  });
});
