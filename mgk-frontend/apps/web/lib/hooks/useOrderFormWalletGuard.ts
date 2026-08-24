'use client';

import { useEffect, useRef } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';

import { useOrderFormStore } from '@/lib/stores/useOrderFormStore';

const WALLET_KEY = 'mgk-order-form-wallet';

/**
 * Wallet-switch guard for the order form store.
 *
 * Three behaviours:
 *  1. **Wallet disconnects** while a PostOrder is in flight (`submitting`)
 *     — clear the store so a reconnect starts fresh.
 *  2. **Wallet switches to a different account** while submitting — clear
 *     the store. The new wallet should not inherit the old in-flight order.
 *  3. **Stale persisted wallet from a prior session** — on mount, if the
 *     persisted wallet pubkey doesn't match the current wallet, clear
 *     the store.
 *
 * Mount once at the page level (e.g. in `app/trade/page.tsx`).
 */
export function useOrderFormWalletGuard(): void {
  const { publicKey, connected } = useWallet();
  const status = useOrderFormStore((s) => s.status);
  const clear = useOrderFormStore((s) => s.clear);
  const lastPubkeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const currentKey = publicKey ? publicKey.toBase58() : null;
    const persistedKey = window.localStorage.getItem(WALLET_KEY);

    // (1) On mount, if the persisted wallet pubkey doesn't match the
    // currently-connected wallet (or no wallet is connected), the persisted
    // order is from a different user — wipe it.
    if (currentKey === null) {
      if (persistedKey !== null) {
        clear();
        window.localStorage.removeItem(WALLET_KEY);
      }
    } else if (persistedKey !== null && persistedKey !== currentKey) {
      clear();
    }

    // (2) Wallet disconnect mid-flight → clear.
    if (!connected && lastPubkeyRef.current !== null) {
      clear();
      window.localStorage.removeItem(WALLET_KEY);
    }

    // (3) Wallet switched to a different pubkey while a PostOrder is
    // in flight (the user closed Phantom on one account and reopened on
    // another without going through disconnect) → clear.
    if (
      currentKey !== null &&
      lastPubkeyRef.current !== null &&
      lastPubkeyRef.current !== currentKey &&
      status === 'submitting'
    ) {
      clear();
    }

    // Record the wallet we just saw so the next render can diff.
    lastPubkeyRef.current = currentKey;
  }, [publicKey, connected, status, clear]);

  // Persist the current wallet pubkey alongside the order form. This is
  // what (1) reads on the next page load.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (publicKey) {
      try {
        // `publicKey` is a web3.js PublicKey in production; in tests it
        // may be a stub with toBase58. Normalize to a base58 string for
        // storage so the next page load can diff against a real PublicKey.
        const value =
          typeof (publicKey as { toBase58?: () => string }).toBase58 === 'function'
            ? (publicKey as { toBase58: () => string }).toBase58()
            : String(publicKey);
        // Best-effort sanity check that it parses as a real Solana pubkey
        new PublicKey(value);
        window.localStorage.setItem(WALLET_KEY, value);
      } catch {
        // ignore invalid pubkey
      }
    } else {
      window.localStorage.removeItem(WALLET_KEY);
    }
  }, [publicKey]);
}
