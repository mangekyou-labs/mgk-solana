import { renderHook } from '@testing-library/react';
import type { PublicKey } from '@solana/web3.js';
import { PublicKey as PublicKeyCtor } from '@solana/web3.js';
import { useWallet, type WalletContextState } from '@solana/wallet-adapter-react';
import { vi } from 'vitest';

import { useAutoConnect } from './useAutoConnect';

vi.mock('@solana/wallet-adapter-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/wallet-adapter-react')>();
  return {
    ...actual,
    useWallet: vi.fn(),
  };
});

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

const MOCK_PUBKEY = new PublicKeyCtor('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

describe('useAutoConnect', () => {
  it('re-exports the wallet context state when disconnected', () => {
    const state = mockWalletState();
    vi.mocked(useWallet).mockReturnValue(state);

    const { result } = renderHook(() => useAutoConnect());

    expect(result.current.connected).toBe(false);
    expect(result.current.connecting).toBe(false);
    expect(result.current.publicKey).toBeNull();
  });

  it('exposes the connected public key when the wallet is connected', () => {
    const state = mockWalletState({
      connected: true,
      publicKey: MOCK_PUBKEY as PublicKey,
    });
    vi.mocked(useWallet).mockReturnValue(state);

    const { result } = renderHook(() => useAutoConnect());

    expect(result.current.connected).toBe(true);
    expect(result.current.publicKey?.toBase58()).toBe(MOCK_PUBKEY.toBase58());
  });

  it('surfaces connecting state during the connect handshake', () => {
    const state = mockWalletState({ connecting: true });
    vi.mocked(useWallet).mockReturnValue(state);

    const { result } = renderHook(() => useAutoConnect());

    expect(result.current.connecting).toBe(true);
    expect(result.current.connected).toBe(false);
  });

  it('captures the wallet name when a wallet is selected', () => {
    const state = mockWalletState({
      wallet: {
        adapter: { name: 'Phantom' } as never,
        readyState: 'Installed' as never,
      },
    });
    vi.mocked(useWallet).mockReturnValue(state);

    const { result } = renderHook(() => useAutoConnect());

    expect(result.current.walletName).toBe('Phantom');
  });

  it('returns null wallet name when no wallet is selected', () => {
    const state = mockWalletState();
    vi.mocked(useWallet).mockReturnValue(state);

    const { result } = renderHook(() => useAutoConnect());

    expect(result.current.walletName).toBeNull();
  });
});
