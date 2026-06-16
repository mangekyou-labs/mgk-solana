'use client';

import { useEffect, useMemo } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';

export interface UseAutoConnectResult {
  connected: boolean;
  connecting: boolean;
  disconnecting: boolean;
  publicKey: ReturnType<typeof useWallet>['publicKey'];
  walletName: string | null;
  select: ReturnType<typeof useWallet>['select'];
  connect: ReturnType<typeof useWallet>['connect'];
  disconnect: ReturnType<typeof useWallet>['disconnect'];
}

export function useAutoConnect(): UseAutoConnectResult {
  const wallet = useWallet();

  const walletName = useMemo(
    () => wallet.wallet?.adapter.name ?? null,
    [wallet.wallet],
  );

  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    if (wallet.connecting) {
      console.debug('[useAutoConnect] connecting…', { walletName });
    }
    if (wallet.connected && wallet.publicKey) {
      console.debug('[useAutoConnect] connected', { walletName, pubkey: wallet.publicKey.toBase58() });
    }
  }, [wallet.connecting, wallet.connected, wallet.publicKey, walletName]);

  return {
    connected: wallet.connected,
    connecting: wallet.connecting,
    disconnecting: wallet.disconnecting,
    publicKey: wallet.publicKey,
    walletName,
    select: wallet.select,
    connect: wallet.connect,
    disconnect: wallet.disconnect,
  };
}
