import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import type { PublicKey } from '@solana/web3.js';
import { PublicKey as PublicKeyCtor } from '@solana/web3.js';
import { useWallet, type WalletContextState } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';

import { WalletButton } from './WalletButton';

vi.mock('@solana/wallet-adapter-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/wallet-adapter-react')>();
  return {
    ...actual,
    useWallet: vi.fn(),
  };
});

vi.mock('@solana/wallet-adapter-react-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/wallet-adapter-react-ui')>();
  return {
    ...actual,
    useWalletModal: vi.fn(),
  };
});

const MOCK_PUBKEY = new PublicKeyCtor('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

function mockWalletState(overrides: Partial<WalletContextState> = {}): WalletContextState {
  return {
    autoConnect: true,
    wallets: [],
    wallet: null,
    publicKey: null,
    connecting: false,
    connected: false,
    disconnecting: false,
    select: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    sendTransaction: vi.fn().mockResolvedValue('mock-sig'),
    signTransaction: undefined,
    signAllTransactions: undefined,
    signMessage: undefined,
    signIn: undefined,
    ...overrides,
  };
}

function mockModal(overrides: Partial<ReturnType<typeof useWalletModal>> = {}): ReturnType<typeof useWalletModal> {
  return {
    visible: false,
    setVisible: vi.fn(),
    ...overrides,
  };
}

describe('WalletButton', () => {
  it('renders a "Select Wallet" label when disconnected', () => {
    vi.mocked(useWallet).mockReturnValue(mockWalletState());
    vi.mocked(useWalletModal).mockReturnValue(mockModal());

    render(<WalletButton />);

    expect(screen.getByRole('button', { name: /select wallet/i })).toBeInTheDocument();
  });

  it('opens the wallet modal when clicked while disconnected', async () => {
    const setVisible = vi.fn();
    vi.mocked(useWallet).mockReturnValue(mockWalletState());
    vi.mocked(useWalletModal).mockReturnValue(mockModal({ setVisible }));

    const user = userEvent.setup();
    render(<WalletButton />);

    await user.click(screen.getByRole('button', { name: /select wallet/i }));

    expect(setVisible).toHaveBeenCalledWith(true);
  });

  it('renders the truncated public key when connected', () => {
    vi.mocked(useWallet).mockReturnValue(
      mockWalletState({
        connected: true,
        publicKey: MOCK_PUBKEY as PublicKey,
      }),
    );
    vi.mocked(useWalletModal).mockReturnValue(mockModal());

    render(<WalletButton />);

    const button = screen.getByRole('button');
    const expected = `${MOCK_PUBKEY.toBase58().slice(0, 4)}…${MOCK_PUBKEY.toBase58().slice(-4)}`;
    expect(button).toHaveTextContent(expected);
  });

  it('disconnects the wallet when the connected button is clicked', async () => {
    const disconnect = vi.fn().mockResolvedValue(undefined);
    vi.mocked(useWallet).mockReturnValue(
      mockWalletState({
        connected: true,
        publicKey: MOCK_PUBKEY as PublicKey,
        disconnect,
      }),
    );
    vi.mocked(useWalletModal).mockReturnValue(mockModal());

    const user = userEvent.setup();
    render(<WalletButton />);

    await user.click(screen.getByRole('button'));

    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('shows a connecting affordance while the wallet is connecting', () => {
    vi.mocked(useWallet).mockReturnValue(mockWalletState({ connecting: true }));
    vi.mocked(useWalletModal).mockReturnValue(mockModal());

    render(<WalletButton />);

    const button = screen.getByRole('button');
    expect(button).toBeDisabled();
  });
});
