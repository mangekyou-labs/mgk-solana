import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useOrderFormStore } from '@/lib/stores/useOrderFormStore';
import { useOrderFormWalletGuard } from './useOrderFormWalletGuard';

const WALLET_KEY = 'mgk-order-form-wallet';
const STORAGE_KEY = 'mgk-order-form';

let mockWallet: {
  publicKey: { toBase58: () => string } | null;
  connected: boolean;
};

vi.mock('@solana/wallet-adapter-react', () => ({
  useWallet: () => mockWallet,
}));

const PUBKEY_A = 'DdqGmK5uamYN5vmuZrzpQhKeehLdwtPLVJdhu5P2iJKC';
const PUBKEY_B = 'CVDFLCAjXhVWiPXH9nTCTpCgVzmDVoiPzNJYuccr1dqB';

function setStoreAwaitingReveal(publicKey: string) {
  useOrderFormStore.setState({
    instrumentId: 0,
    side: 'buy',
    price: 150_000_000n,
    qty: 1_000_000n,
    reduceOnly: false,
    batchId: 5n,
    salt: 12345n,
    hash: 'abc',
    status: 'awaiting_reveal',
  });
  // Persist the wallet key alongside so the guard sees a matching pair
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(WALLET_KEY, publicKey);
    window.localStorage.setItem(STORAGE_KEY, 'persisted');
  }
}

describe('useOrderFormWalletGuard', () => {
  beforeEach(() => {
    useOrderFormStore.setState({
      instrumentId: 0,
      side: 'buy',
      price: 0n,
      qty: 0n,
      reduceOnly: false,
      batchId: 0n,
      salt: 0n,
      hash: '',
      status: 'idle',
    });
    if (typeof window !== 'undefined') {
      window.localStorage.clear();
    }
    mockWallet = { publicKey: null, connected: false };
  });

  afterEach(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.clear();
    }
  });

  it('persists the current wallet pubkey to localStorage on connect', () => {
    mockWallet = { publicKey: { toBase58: () => PUBKEY_A }, connected: true };
    renderHook(() => useOrderFormWalletGuard());
    expect(window.localStorage.getItem(WALLET_KEY)).toBe(PUBKEY_A);
  });

  it('removes the persisted wallet key on disconnect', () => {
    window.localStorage.setItem(WALLET_KEY, PUBKEY_A);
    mockWallet = { publicKey: null, connected: false };
    renderHook(() => useOrderFormWalletGuard());
    expect(window.localStorage.getItem(WALLET_KEY)).toBeNull();
  });

  it('clears a stale `awaiting_reveal` on mount when the wallet changed', () => {
    setStoreAwaitingReveal(PUBKEY_A);
    expect(useOrderFormStore.getState().status).toBe('awaiting_reveal');
    expect(useOrderFormStore.getState().hash).toBe('abc');

    // Now the user reconnects with a different wallet.
    mockWallet = { publicKey: { toBase58: () => PUBKEY_B }, connected: true };
    renderHook(() => useOrderFormWalletGuard());

    const s = useOrderFormStore.getState();
    expect(s.status).toBe('idle');
    expect(s.hash).toBe('');
    expect(window.localStorage.getItem(WALLET_KEY)).toBe(PUBKEY_B);
  });

  it('clears the in-flight state when the wallet disconnects mid-flight', () => {
    mockWallet = { publicKey: { toBase58: () => PUBKEY_A }, connected: true };
    const { rerender } = renderHook(() => useOrderFormWalletGuard());
    setStoreAwaitingReveal(PUBKEY_A);

    act(() => {
      mockWallet = { publicKey: null, connected: false };
      rerender();
    });

    const s = useOrderFormStore.getState();
    expect(s.status).toBe('idle');
    expect(s.hash).toBe('');
    expect(window.localStorage.getItem(WALLET_KEY)).toBeNull();
  });

  it('clears the in-flight state when the wallet switches while awaiting_reveal', () => {
    mockWallet = { publicKey: { toBase58: () => PUBKEY_A }, connected: true };
    const { rerender } = renderHook(() => useOrderFormWalletGuard());
    setStoreAwaitingReveal(PUBKEY_A);

    act(() => {
      mockWallet = { publicKey: { toBase58: () => PUBKEY_B }, connected: true };
      rerender();
    });

    const s = useOrderFormStore.getState();
    expect(s.status).toBe('idle');
    expect(s.hash).toBe('');
  });

  it('does NOT clear the state on a no-op re-render with the same wallet', () => {
    mockWallet = { publicKey: { toBase58: () => PUBKEY_A }, connected: true };
    const { rerender } = renderHook(() => useOrderFormWalletGuard());
    setStoreAwaitingReveal(PUBKEY_A);

    act(() => {
      rerender();
    });

    const s = useOrderFormStore.getState();
    expect(s.status).toBe('awaiting_reveal');
    expect(s.hash).toBe('abc');
  });
});
