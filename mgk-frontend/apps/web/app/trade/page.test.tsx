import { render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { Connection } from '@solana/web3.js';

import TradePage from './page';


vi.mock('@solana/wallet-adapter-react', () => ({
  useWallet: vi.fn(),
  useConnection: vi.fn(() => ({
    connection: new Connection('http://localhost:8899'),
  })),
}));

vi.mock('@solana/wallet-adapter-react-ui', () => ({
  useWalletModal: vi.fn(() => ({ visible: false, setVisible: vi.fn() })),
}));

function mockWallet(overrides: Record<string, unknown> = {}) {
  return {
    autoConnect: false,
    wallets: [],
    wallet: null,
    publicKey: null,
    connecting: false,
    connected: false,
    disconnecting: false,
    select: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    sendTransaction: vi.fn(),
    ...overrides,
  };
}

async function mockUseWallet(overrides: Record<string, unknown> = {}) {
  const { useWallet } = await import('@solana/wallet-adapter-react');
  vi.mocked(useWallet).mockReturnValue(mockWallet(overrides) as never);
}

describe('app/trade page', () => {
  it('renders the page frame', async () => {
    await mockUseWallet();
    render(<TradePage />);
    expect(screen.getByTestId('page-frame')).toBeInTheDocument();
  });

  it('renders the market header', async () => {
    await mockUseWallet();
    render(<TradePage />);
    expect(screen.getByTestId('market-header')).toBeInTheDocument();
  });

  it('renders the 3-column trade body', async () => {
    await mockUseWallet();
    render(<TradePage />);
    expect(screen.getByTestId('trade-body')).toBeInTheDocument();
    expect(screen.getByTestId('chart-section')).toBeInTheDocument();
    expect(screen.getByTestId('orderbook-section')).toBeInTheDocument();
    expect(screen.getByTestId('orderform-section')).toBeInTheDocument();
  });

  it('renders the bottom tabs', async () => {
    await mockUseWallet();
    render(<TradePage />);
    expect(screen.getByTestId('bottom-tabs')).toBeInTheDocument();
  });
});
