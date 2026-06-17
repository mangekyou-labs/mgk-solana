'use client';

import { useMemo } from 'react';

import { Pill } from '@/components/common/Pill';
import { NumberDisplay } from '@/components/common/NumberDisplay';
import { useBookTopN } from '@/lib/stores/useBookStore';
import { useBatchPolling } from '@/lib/stores/useBatchStore';
import { useMarketStatePolling } from '@/lib/stores/useMarketStateStore';
import { useSlotPolling } from '@/lib/stores/useSlotPolling';
import {
  PHASE_LABEL,
  PHASE_TONE,
  deriveDeadline,
  formatSlotDuration,
} from '@/lib/trade/batchDisplay';

/**
 * MarketHeader — the 48px strip between the page header and the
 * 3-column body. Shows: market selector, last price (book midpoint in
 * v1), and a stats row (Last / Oracle / 24h Volume / Open Interest /
 * Batch phase + countdown).
 *
 * Drift from plan:
 * - "Last" is the book midpoint (best bid + best ask) / 2, with a "Mid"
 *   badge. There is no on-chain "last trade" PDA in v1; the on-chain
 *   mgk matcher just clears, no fill history is kept.
 * - "Oracle" shows "—" with a tooltip — the deployed `percolator-oracle`
 *   has no initialized data account on devnet yet (the keeper bot is
 *   not running). T5+ will fill this in when a real oracle is wired.
 * - "24h Vol" and "OI" are now sourced from the indexer's
 *   `market_state` table via `useMarketStatePolling` (M7 T7.3). When
 *   the indexer is offline or the market is not yet registered, the
 *   slots fall back to "—" with a tooltip pointing at the indexer.
 */
export function MarketHeader() {
  const { bids, asks } = useBookTopN(0);
  const { data: batchData } = useBatchPolling(3000);
  const { slot: currentSlot } = useSlotPolling(1000);
  const marketState = useMarketStatePolling(0, 5000);

  // Book midpoint: (best bid + best ask) / 2. Best bid is max, best
  // ask is min. Empty book → null.
  const midpoint = useMemo(() => {
    const bestBid = bids[0]?.price;
    const bestAsk = asks[0]?.price;
    if (bestBid == null || bestAsk == null) return null;
    return (bestBid + bestAsk) / 2n;
  }, [bids, asks]);

  const phasePill = useMemo(() => {
    if (!batchData) return null;
    return {
      label: PHASE_LABEL[batchData.status],
      tone: PHASE_TONE[batchData.status],
    };
  }, [batchData]);

  const countdown = useMemo(() => {
    if (!batchData) return '—';
    const { deadline } = deriveDeadline(batchData.status, batchData, currentSlot);
    if (deadline == null || currentSlot == null) return '—';
    return formatSlotDuration(Number(deadline) - currentSlot);
  }, [batchData, currentSlot]);

  // OI = long + short. Indexer hasn't run yet → null.
  const oi = marketState.data
    ? marketState.data.open_interest_long + marketState.data.open_interest_short
    : null;
  const volume24h = marketState.data?.volume_24h ?? null;
  const indexerLive = marketState.isPolling && marketState.data != null;

  return (
    <div
      data-testid="market-header"
      className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-surface-1 px-4"
    >
      {/* Market selector (v1: SOL-USD Perp only — no dropdown) */}
      <button
        type="button"
        data-testid="market-selector"
        className="flex items-center gap-1.5 rounded border border-border bg-surface-2 px-2 py-1 text-xs font-medium uppercase tracking-wider text-text hover:bg-surface-3"
        disabled
        title="Multi-market support is post-v1"
      >
        <span className="text-accent" aria-hidden="true">
          ★
        </span>
        SOL-USD Perp
      </button>

      {/* Last price + Mid badge */}
      <div className="flex items-baseline gap-2" data-testid="last-price-block">
        {midpoint != null ? (
          <>
            <span className="font-mono text-lg font-semibold tabular-nums text-text">
              <NumberDisplay value={midpoint} kind="scaled-usd" decimals={2} />
            </span>
            <Pill tone="neutral">Mid</Pill>
          </>
        ) : (
          <>
            <span
              className="font-mono text-lg text-text-faint"
              data-testid="last-price-empty"
            >
              —
            </span>
            <span className="text-[10px] uppercase tracking-wider text-text-faint">
              awaiting first fill
            </span>
          </>
        )}
      </div>

      {/* Stats row separator */}
      <span className="h-5 w-px bg-border" aria-hidden="true" />

      {/* Last = midpoint (we don't track a separate "Last" trade) */}
      <Stat
        label="Last"
        value={midpoint != null ? <NumberDisplay value={midpoint} kind="scaled-usd" decimals={2} /> : '—'}
        tooltip="Book midpoint (best bid + best ask) / 2"
      />

      <Stat
        label="Oracle"
        value="—"
        tooltip="On-chain percolator-oracle is deployed but the keeper bot is not yet running. M5 will fill this in."
      />

      <Stat
        label="24h Vol"
        value={
          volume24h != null ? (
            <NumberDisplay value={volume24h} kind="scaled-base" decimals={2} />
          ) : (
            '—'
          )
        }
        tooltip={
          indexerLive
            ? `From indexer /api/markets/0/state (sum of candles_1m over the last 24h, recomputed every 60s).`
            : 'Available when the indexer is live (M4). Start it with `pnpm -F indexer dev`.'
        }
      />

      <Stat
        label="OI"
        value={
          oi != null ? (
            <NumberDisplay value={oi} kind="scaled-base" decimals={2} />
          ) : (
            '—'
          )
        }
        tooltip={
          indexerLive
            ? `From indexer /api/markets/0/state. Long ${marketState.data?.open_interest_long.toLocaleString()} + Short ${marketState.data?.open_interest_short.toLocaleString()}.`
            : 'Available when the indexer is live (M4). Start it with `pnpm -F indexer dev`.'
        }
      />

      <span className="h-5 w-px bg-border" aria-hidden="true" />

      {/* Batch phase + countdown */}
      {phasePill ? (
        <div className="flex items-center gap-2" data-testid="market-header-batch">
          <Pill tone={phasePill.tone}>Batch: {phasePill.label}</Pill>
          <span
            className="font-mono text-xs tabular-nums text-text"
            data-testid="market-header-countdown"
          >
            {countdown}
          </span>
        </div>
      ) : (
        <Pill tone="neutral">Batch: —</Pill>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tooltip,
}: {
  label: string;
  value: React.ReactNode;
  tooltip?: string;
}) {
  return (
    <div
      className="flex flex-col leading-tight"
      data-testid={`stat-${label.toLowerCase().replace(/\s+/g, '-')}`}
      title={tooltip}
    >
      <span className="text-[10px] uppercase tracking-wider text-text-faint">
        {label}
      </span>
      <span className="font-mono text-xs tabular-nums text-text">{value}</span>
    </div>
  );
}
