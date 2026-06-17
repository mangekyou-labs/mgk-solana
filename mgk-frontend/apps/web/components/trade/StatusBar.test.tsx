import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as sdk from '@mgk/sdk';

import { StatusBar } from './StatusBar';

vi.mock('@solana/wallet-adapter-react', () => {
  let walletState: {
    connected: boolean;
    publicKey: { toBase58(): string } | null;
  } = { connected: false, publicKey: null };

  return {
    useWallet: () => walletState,
    useConnection: () => ({ connection: { getMultipleAccountsInfo: vi.fn() } }),
    __setWalletState: (s: typeof walletState) => {
      walletState = s;
    },
  };
});

const walletAdapter = vi.mocked(
  (await import('@solana/wallet-adapter-react')) as Record<string, unknown>,
);

vi.mock('@/lib/stores/useBatchStore', () => {
  let batchState: {
    data: sdk.state.BatchState | null;
    currentBatchId: bigint | null;
  } = { data: null, currentBatchId: null };

  return {
    useBatchStore: {
      getState: () => ({ data: batchState.data }),
    },
    useBatchPolling: () => batchState,
    __setBatchState: (s: typeof batchState) => {
      batchState = s;
    },
  };
});

const batchStoreModule = await vi.importMock<Record<string, unknown>>(
  '@/lib/stores/useBatchStore',
);

vi.mock('@/lib/stores/useSlotPolling', () => {
  let slotState = { slot: null as number | null };

  return {
    useSlotStore: { getState: () => slotState },
    useSlotPolling: () => slotState,
    __setSlotState: (s: typeof slotState) => {
      slotState = s;
    },
  };
});

const slotModule = await vi.importMock<Record<string, unknown>>(
  '@/lib/stores/useSlotPolling',
);

const setWalletModule = walletAdapter as unknown as {
  __setWalletState: (s: { connected: boolean; publicKey: { toBase58(): string } | null }) => void;
};
const setBatchModule = batchStoreModule as unknown as {
  __setBatchState: (s: { data: sdk.state.BatchState | null; currentBatchId: bigint | null }) => void;
};
const setSlotModule = slotModule as unknown as {
  __setSlotState: (s: { slot: number | null }) => void;
};

function setWallet(connected: boolean) {
  setWalletModule.__setWalletState({
    connected,
    publicKey: connected
      ? { toBase58: () => 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }
      : null,
  });
}

function setBatch(overrides: Partial<sdk.state.BatchState> = {}) {
  const base: sdk.state.BatchState = {
    batchId: 1n,
    status: sdk.state.BatchStatus.Committing,
    commitDeadlineSlot: 1000n,
    revealDeadlineSlot: 2000n,
    closeSlot: 0n,
    shuffleSeed: 0n,
    clearingPrice: 0n,
    totalCommitments: 0,
    totalRevealed: 0,
    totalSettled: 0,
    totalVolume: 0n,
    totalNotional: 0n,
    slashedDeposits: 0n,
    bump: 255,
    ...overrides,
  };
  setBatchModule.__setBatchState({
    data: base,
    currentBatchId: 1n,
  });
}

function setSlot(slot: number | null) {
  setSlotModule.__setSlotState({ slot });
}

describe('StatusBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setWallet(false);
    setBatchModule.__setBatchState({
      data: null,
      currentBatchId: null,
    });
    setSlot(null);
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the 24px sticky bar', () => {
    render(<StatusBar />);
    const bar = screen.getByTestId('status-bar');
    expect(bar).toBeInTheDocument();
    expect(bar).toHaveClass('h-6');
    expect(bar).toHaveClass('sticky');
    expect(bar).toHaveClass('bottom-0');
  });

  it('shows offline dot and Offline label when wallet is not connected', () => {
    render(<StatusBar />);
    const dot = screen.getByTestId('status-dot');
    expect(dot.getAttribute('data-state')).toBe('offline');
    expect(screen.getByTestId('status-connection-label')).toHaveTextContent(
      'Offline',
    );
  });

  it('shows online dot and Online label when wallet is connected', () => {
    setWallet(true);
    render(<StatusBar />);
    const dot = screen.getByTestId('status-dot');
    expect(dot.getAttribute('data-state')).toBe('online');
    expect(screen.getByTestId('status-connection-label')).toHaveTextContent(
      'Online',
    );
  });

  it('renders the Devnet pill with warn tone', () => {
    render(<StatusBar />);
    const wrapper = screen.getByTestId('status-devnet-pill');
    const pill = within(wrapper).getByTestId('pill');
    expect(pill).toHaveTextContent('Devnet');
    expect(pill.getAttribute('data-tone')).toBe('warn');
  });

  it('shows "Wallet: Not Connected" when disconnected', () => {
    render(<StatusBar />);
    expect(screen.getByTestId('status-wallet-label')).toHaveTextContent(
      'Wallet: Not Connected',
    );
  });

  it('shows truncated pubkey when connected', () => {
    setWallet(true);
    render(<StatusBar />);
    expect(screen.getByTestId('status-wallet-label')).toHaveTextContent(
      'Wallet: EPjF…Dt1v',
    );
  });

  it('shows "Batch: —" when no batch data is available', () => {
    render(<StatusBar />);
    expect(screen.getByTestId('status-batch-label')).toHaveTextContent('—');
  });

  it('shows batch phase + countdown when data is loaded', () => {
    setBatch({ status: sdk.state.BatchStatus.Committing, commitDeadlineSlot: 1000n });
    setSlot(800);
    render(<StatusBar />);
    expect(screen.getByTestId('status-batch-label')).toHaveTextContent(
      'Committing',
    );
    expect(screen.getByTestId('status-batch-label')).toHaveTextContent('01:20');
  });

  it('shows Settled phase without a countdown', () => {
    setBatch({ status: sdk.state.BatchStatus.Settled });
    setSlot(null);
    render(<StatusBar />);
    expect(screen.getByTestId('status-batch-label')).toHaveTextContent(
      'Batch: Settled',
    );
    expect(screen.getByTestId('status-batch-label')).toHaveTextContent('—');
  });

  it('shows "past deadline" when current slot exceeds the deadline', () => {
    setBatch({ status: sdk.state.BatchStatus.Committing, commitDeadlineSlot: 1000n });
    setSlot(1500);
    render(<StatusBar />);
    expect(screen.getByTestId('status-batch-label')).toHaveTextContent(
      'past deadline',
    );
  });
});
