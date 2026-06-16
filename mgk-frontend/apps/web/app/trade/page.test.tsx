import { render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';

import TradePage from './page';

vi.mock('@solana/wallet-adapter-react', () => ({
  useWallet: vi.fn(),
}));

vi.mock('@solana/wallet-adapter-react-ui', () => ({
  useWalletModal: vi.fn(() => ({ visible: false, setVisible: vi.fn() })),
}));

const MOCK_PUBKEY = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const EXPECTED_SHORT = `${MOCK_PUBKEY.toBase58().slice(0, 4)}…${MOCK_PUBKEY.toBase58().slice(-4)}`;

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

  it('prompts the user to connect a wallet when disconnected', async () => {
    await mockUseWallet();
    render(<TradePage />);
    expect(screen.getByTestId('trade-greeting')).toHaveTextContent(/connect a wallet/i);
  });

  it('greets the connected wallet by its short pubkey', async () => {
    await mockUseWallet({ connected: true, publicKey: MOCK_PUBKEY });
    render(<TradePage />);
    expect(screen.getByTestId('trade-greeting')).toHaveTextContent(`Hello ${EXPECTED_SHORT}`);
  });

  it('renders a placeholder subtitle that names the milestone state', async () => {
    await mockUseWallet();
    render(<TradePage />);
    expect(screen.getByTestId('trade-subtitle')).toBeInTheDocument();
  });
});
