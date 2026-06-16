'use client';

import { useCallback } from 'react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';

import { truncatePubkey } from '@/lib/pubkey';
import { useAutoConnect } from './useAutoConnect';

export function WalletButton() {
  const { connected, connecting, publicKey, disconnect } = useAutoConnect();
  const { setVisible } = useWalletModal();

  const onClick = useCallback(() => {
    if (connected) {
      void disconnect();
    } else {
      setVisible(true);
    }
  }, [connected, disconnect, setVisible]);

  const label = connecting
    ? 'Connecting…'
    : connected && publicKey
      ? truncatePubkey(publicKey)
      : 'Select Wallet';

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={connecting}
      data-state={connected ? 'connected' : connecting ? 'connecting' : 'disconnected'}
      className="inline-flex h-9 items-center justify-center rounded-md border border-border bg-surface-2 px-4 text-sm font-medium text-text transition-colors hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
    >
      {label}
    </button>
  );
}
