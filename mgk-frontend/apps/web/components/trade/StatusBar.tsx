'use client';

import { useMemo } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';

import { Pill } from '@/components/common/Pill';
import { StatusDot } from '@/components/common/StatusDot';
import { useBatchPolling } from '@/lib/stores/useBatchStore';
import { useIndexerHealth } from '@/lib/stores/useIndexerHealthStore';
import { useSlotPolling } from '@/lib/stores/useSlotPolling';
import { truncatePubkey } from '@/lib/pubkey';
import {
  PHASE_LABEL,
  describeBatchPhase,
} from '@/lib/trade/batchDisplay';

export function StatusBar() {
  const { connected, publicKey } = useWallet();
  const { data, registry } = useBatchPolling(3000);
  const { slot: currentSlot } = useSlotPolling(1000);
  const indexerHealth = useIndexerHealth();

  const batchLabel = useMemo(() => {
    if (!data) return '—';

    const phaseLabel = PHASE_LABEL[data.status];
    const intent = describeBatchPhase(data.status, data, currentSlot, registry);

    return `Batch: ${phaseLabel} · ${intent.headline} · ${intent.detail}`;
  }, [data, currentSlot, registry]);

  const indexerPresentation = useMemo(() => {
    switch (indexerHealth.displayStatus) {
      case 'warming':
        return {
          dotState: 'connecting' as const,
          label: 'Indexer syncing',
        };
      case 'healthy':
        return {
          dotState: 'online' as const,
          label: 'Indexer live',
        };
      case 'reconnecting':
        return {
          dotState: 'connecting' as const,
          label: 'Indexer reconnecting',
        };
      case 'unreachable':
        return {
          dotState: 'offline' as const,
          label: 'Indexer unreachable',
        };
      case 'degraded': {
        const lagText = indexerHealth.slotLag != null ? ` · ${indexerHealth.slotLag} slots` : '';
        return {
          dotState: 'connecting' as const,
          label: `Indexer delayed${lagText}`,
        };
      }
      case 'critical': {
        const lagText = indexerHealth.slotLag != null ? ` · ${indexerHealth.slotLag} slots` : '';
        return {
          dotState: 'offline' as const,
          label: `Indexer critical${lagText}`,
        };
      }
      default:
        return {
          dotState: 'offline' as const,
          label: 'Indexer unavailable',
        };
    }
  }, [indexerHealth.displayStatus, indexerHealth.slotLag]);

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

      {/* Indexer health indicator — distinct from wallet connectivity */}
      <span className="flex items-center gap-1.5 ml-2" data-testid="status-indexer">
        <StatusDot state={indexerPresentation.dotState} data-testid="status-indexer-dot" />
        <span
          data-testid="status-indexer-label"
          className="text-text"
        >
          {indexerPresentation.label}
        </span>
      </span>

      <span data-testid="status-batch-label" className="ml-2">
        {batchLabel}
      </span>

      <span className="flex-1" />

      <span data-testid="status-wallet-label">{walletLabel}</span>
    </div>
  );
}
