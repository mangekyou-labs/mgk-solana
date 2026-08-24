import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import * as sdk from '@mgk/sdk';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { BatchTimeline } from './BatchTimeline';

// Mock PDA derivation: jsdom's crypto stack can't compute Solana PDA
// nonces (see memory note 'mgk-frontend: jsdom cannot compute PDA nonces'),
// so any test that exercises the Crank click handler must stub the derive
// functions. Tests that only render the component (no click) don't need this.
vi.mock('@mgk/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof sdk>();
  return {
    ...actual,
    deriveBatchPda: vi.fn(
      () => [new PublicKey('11111111111111111111111111111111'), 255] as const,
    ),
    deriveRegistryPda: vi.fn(
      () => [new PublicKey('11111111111111111111111111111112'), 254] as const,
    ),
  };
});

// --- Component (mocked hooks) ----------------------------------------

function makeBatchData(
  status: sdk.state.BatchStatus,
  overrides: Partial<{
    commitDeadlineSlot: bigint;
    revealDeadlineSlot: bigint;
    closeSlot: bigint;
  }> = {},
): import('@mgk/sdk').state.BatchState {
  return {
    batchId: 7n,
    status,
    commitDeadlineSlot: overrides.commitDeadlineSlot ?? 100_000n,
    revealDeadlineSlot: overrides.revealDeadlineSlot ?? 100_100n,
    closeSlot: overrides.closeSlot ?? 100_200n,
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
}

const PUBLIC_KEY = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

type HooksMockState = {
  data: import('@mgk/sdk').state.BatchState | null;
  currentBatchId: bigint | null;
  currentSlot: number | null;
  devtools: boolean;
  connected: boolean;
  publicKey: PublicKey | null;
  sendTransaction: ReturnType<typeof vi.fn>;
  confirmTransaction: ReturnType<typeof vi.fn>;
};

const mockState: HooksMockState = {
  data: null,
  currentBatchId: null,
  currentSlot: null,
  devtools: false,
  connected: false,
  publicKey: null,
  sendTransaction: vi.fn(),
  confirmTransaction: vi.fn(),
};

vi.mock('@/lib/stores/useBatchStore', () => ({
  useBatchPolling: () => ({
    data: mockState.data,
    currentBatchId: mockState.currentBatchId,
  }),
}));

vi.mock('@/lib/stores/useSlotPolling', () => ({
  useSlotPolling: () => ({
    slot: mockState.currentSlot,
  }),
}));

vi.mock('@/lib/hooks/useDevtools', () => ({
  useDevtools: () => mockState.devtools,
}));

vi.mock('@solana/wallet-adapter-react', () => ({
  useWallet: () => ({
    publicKey: mockState.publicKey,
    connected: mockState.connected,
    sendTransaction: mockState.sendTransaction,
  }),
  useConnection: () => ({
    connection: {
      confirmTransaction: mockState.confirmTransaction,
    },
  }),
}));

function resetMockState(overrides: Partial<HooksMockState> = {}) {
  mockState.data = null;
  mockState.currentBatchId = null;
  mockState.currentSlot = null;
  mockState.devtools = false;
  mockState.connected = false;
  mockState.publicKey = null;
  mockState.sendTransaction = vi.fn();
  mockState.confirmTransaction = vi.fn();
  Object.assign(mockState, overrides);
}

beforeEach(() => {
  resetMockState();
});
afterEach(() => {
  cleanup();
});

describe('<BatchTimeline />', () => {
  it('renders the no-data state when batch is null', () => {
    render(<BatchTimeline />);
    const root = screen.getByTestId('batch-timeline');
    expect(root).toHaveAttribute('data-state', 'no-data');
    expect(screen.getByText(/awaiting batch state/i)).toBeInTheDocument();
    expect(screen.queryByTestId('crank-button')).not.toBeInTheDocument();
  });

  it('renders the Collecting phase pill + countdown', () => {
    resetMockState({
      data: makeBatchData(sdk.state.BatchStatus.Committing, { commitDeadlineSlot: 100_000n }),
      currentBatchId: 7n,
      currentSlot: 99_750, // 250 slots × 0.4s = 100s → 00:01:40
    });
    render(<BatchTimeline />);
    const root = screen.getByTestId('batch-timeline');
    expect(root).toHaveAttribute('data-state', 'collecting');
    expect(screen.getByText(/Batch:\s*Collecting/i)).toBeInTheDocument();
    expect(screen.getByTestId('batch-countdown')).toHaveTextContent('00:01:40');
  });

  it('renders the Closed label for legacy reveal wire value', () => {
    resetMockState({
      data: makeBatchData(sdk.state.BatchStatus.Revealing, { revealDeadlineSlot: 100_100n }),
      currentBatchId: 7n,
      currentSlot: 100_050,
    });
    render(<BatchTimeline />);
    expect(screen.getByText(/Batch:\s*Closed/i)).toBeInTheDocument();
    expect(screen.getByTestId('batch-countdown')).toHaveTextContent('00:00:20');
  });

  it('shows "past deadline" indicator when slot > deadline', () => {
    resetMockState({
      data: makeBatchData(sdk.state.BatchStatus.Committing, { commitDeadlineSlot: 100_000n }),
      currentBatchId: 7n,
      currentSlot: 100_500,
    });
    render(<BatchTimeline />);
    expect(screen.getByTestId('batch-past-deadline')).toHaveTextContent(/collection closes\s*passed/i);
    expect(screen.getByTestId('batch-timeline')).toHaveAttribute('data-past-deadline', 'true');
  });

  it('shows the Crank button only with devtools=1 + connected + past deadline', () => {
    // All three conditions met.
    resetMockState({
      data: makeBatchData(sdk.state.BatchStatus.Committing, { commitDeadlineSlot: 100_000n }),
      currentBatchId: 7n,
      currentSlot: 100_500,
      devtools: true,
      connected: true,
      publicKey: PUBLIC_KEY,
    });
    mockState.sendTransaction.mockResolvedValue('mock-sig');
    mockState.confirmTransaction.mockResolvedValue(undefined);

    render(<BatchTimeline />);
    const btn = screen.getByTestId('crank-button');
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveTextContent(/^Crank$/);
  });

  it('hides the Crank button without ?devtools=1', () => {
    resetMockState({
      data: makeBatchData(sdk.state.BatchStatus.Committing, { commitDeadlineSlot: 100_000n }),
      currentBatchId: 7n,
      currentSlot: 100_500,
      connected: true,
      publicKey: PUBLIC_KEY,
    });
    render(<BatchTimeline />);
    expect(screen.queryByTestId('crank-button')).not.toBeInTheDocument();
  });

  it('hides the Crank button when not connected', () => {
    resetMockState({
      data: makeBatchData(sdk.state.BatchStatus.Committing, { commitDeadlineSlot: 100_000n }),
      currentBatchId: 7n,
      currentSlot: 100_500,
      devtools: true,
    });
    render(<BatchTimeline />);
    expect(screen.queryByTestId('crank-button')).not.toBeInTheDocument();
  });

  it('hides the Crank button when slot is not past the deadline', () => {
    resetMockState({
      data: makeBatchData(sdk.state.BatchStatus.Committing, { commitDeadlineSlot: 100_000n }),
      currentBatchId: 7n,
      currentSlot: 99_000,
      devtools: true,
      connected: true,
      publicKey: PUBLIC_KEY,
    });
    render(<BatchTimeline />);
    expect(screen.queryByTestId('crank-button')).not.toBeInTheDocument();
  });

  it('clicking Crank builds and sends a CloseCommitting transaction', async () => {
    resetMockState({
      data: makeBatchData(sdk.state.BatchStatus.Committing, { commitDeadlineSlot: 100_000n }),
      currentBatchId: 7n,
      currentSlot: 100_500,
      devtools: true,
      connected: true,
      publicKey: PUBLIC_KEY,
    });
    mockState.sendTransaction.mockResolvedValue('mock-sig');
    mockState.confirmTransaction.mockResolvedValue(undefined);

    render(<BatchTimeline />);
    fireEvent.click(screen.getByTestId('crank-button'));

    await waitFor(() => {
      expect(mockState.sendTransaction).toHaveBeenCalledTimes(1);
    });
    expect(mockState.confirmTransaction).toHaveBeenCalledWith('mock-sig', 'confirmed');

    const [tx, conn] = mockState.sendTransaction.mock.calls[0]!;
    expect(tx).toBeDefined();
    expect(conn).toBeDefined();
    // The instruction data is the CloseCommitting discriminator (1 byte = 6)
    const ix = tx.instructions[0];
    expect(ix.data[0]).toBe(6);
  });

  it('surfaces crank errors inline', async () => {
    resetMockState({
      data: makeBatchData(sdk.state.BatchStatus.Committing, { commitDeadlineSlot: 100_000n }),
      currentBatchId: 7n,
      currentSlot: 100_500,
      devtools: true,
      connected: true,
      publicKey: PUBLIC_KEY,
    });
    mockState.sendTransaction.mockRejectedValue(new Error('user rejected'));

    render(<BatchTimeline />);
    fireEvent.click(screen.getByTestId('crank-button'));

    await waitFor(() => {
      expect(screen.getByTestId('crank-error')).toHaveTextContent(/user rejected/i);
    });
  });
});
