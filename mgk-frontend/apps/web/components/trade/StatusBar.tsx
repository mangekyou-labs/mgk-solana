'use client';

import { useMemo } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';

import { Pill } from '@/components/common/Pill';
import { StatusDot } from '@/components/common/StatusDot';
import { useBatchPolling } from '@/lib/stores/useBatchStore';
import { useSlotPolling } from '@/lib/stores/useSlotPolling';
import { truncatePubkey } from '@/lib/pubkey';
import {
  PHASE_LABEL,
  deriveDeadline,
  formatSlotDuration,
} from '@/lib/trade/batchDisplay';

export function StatusBar() {
  const { connected, publicKey } = useWallet();
  const { data } = useBatchPolling(3000);
  const { slot: currentSlot } = useSlotPolling(1000);

  const batchLabel = useMemo(() => {
    if (!data) return '—';

    const { deadline } = deriveDeadline(data.status, data, currentSlot);
    const phaseLabel = PHASE_LABEL[data.status];
    const countdown =
      deadline != null && currentSlot != null
        ? formatSlotDuration(Number(deadline) - currentSlot)
        : '—';

    return `Batch: ${phaseLabel} ${countdown}`;
  }, [data, currentSlot]);

  const connectionState = connected ? ('online' as const) : ('offline' as const);
  const walletLabel = connected && publicKey
    ? `Wallet: ${truncatePubkey(publicKey)}`
    : 'Wallet: Not Connected';

  return (
    <div
      data-testid="status-bar"
      className="sticky bottom-0 z-50 flex shrink-0 items-center gap-2 border-t border-border bg-surface-1 px-3 text-[10px] leading-6 h-6 font-mono text-text-muted"
    >
      <StatusDot state={connectionState} />
      <span
        data-testid="status-connection-label"
        className="text-text uppercase tracking-wider"
      >
        {connected ? 'Online' : 'Offline'}
      </span>

      <span data-testid="status-devnet-pill">
        <Pill tone="warn">Devnet</Pill>
      </span>

      <span data-testid="status-batch-label" className="ml-2">
        {batchLabel}
      </span>

      <span className="flex-1" />

      <span data-testid="status-wallet-label">{walletLabel}</span>
    </div>
  );
}
