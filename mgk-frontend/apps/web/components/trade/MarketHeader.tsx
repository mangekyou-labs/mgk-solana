'use client';

import { useMemo } from 'react';

import { Pill } from '@/components/common/Pill';
import { NumberDisplay } from '@/components/common/NumberDisplay';
import { useBookTopN } from '@/lib/stores/useBookStore';
import { useBatchPolling } from '@/lib/stores/useBatchStore';
import { useIndexerHealth } from '@/lib/stores/useIndexerHealthStore';
import { useMarketStatePolling } from '@/lib/stores/useMarketStateStore';
import { useSlotPolling } from '@/lib/stores/useSlotPolling';
import {
  PHASE_LABEL,
  PHASE_TONE,
  describeBatchPhase,
} from '@/lib/trade/batchDisplay';

function formatAsOf(ts: number | null): string {
  if (ts === null) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

export function MarketHeader() {
  const { bids, asks } = useBookTopN(0);
  const { data: batchData, registry } = useBatchPolling(3000);
  const { slot: currentSlot } = useSlotPolling(1000);
  const marketState = useMarketStatePolling(0, 5000);
  const indexerHealth = useIndexerHealth();
  const isIndexerStale = indexerHealth.status === 'degraded' || indexerHealth.status === 'critical';

  // Book midpoint: (best bid + best ask) / 2. Best bid is max, best
  // ask is min. Empty book → null.
  const { midpoint, bookCrossed } = useMemo(() => {
    const bestBid = bids[0]?.price;
    const bestAsk = asks[0]?.price;
    if (bestBid == null || bestAsk == null) {
      return { midpoint: null, bookCrossed: false };
    }
    if (bestBid > bestAsk) {
      return { midpoint: null, bookCrossed: true };
    }
    return { midpoint: (bestBid + bestAsk) / 2n, bookCrossed: false };
  }, [bids, asks]);

  const phasePresentation = useMemo(() => {
    if (!batchData) return null;
    return {
      label: PHASE_LABEL[batchData.status],
      tone: PHASE_TONE[batchData.status],
      intent: describeBatchPhase(batchData.status, batchData, currentSlot, registry),
    };
  }, [batchData, currentSlot, registry]);

  // OI = long + short. Indexer hasn't run yet → null.
  const oi = marketState.data
    ? marketState.data.open_interest_long + marketState.data.open_interest_short
    : null;
  const volume24h = marketState.data?.volume_24h ?? null;
  const indexerLive = marketState.isPolling && marketState.data != null;

  // As-of timestamp from market state
  const asOfTs = marketState.data?.updated_ts ?? null;
  const asOfLabel = isIndexerStale && asOfTs ? formatAsOf(asOfTs) : null;

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
            {bookCrossed ? (
              <span
                className="text-[10px] uppercase tracking-wider text-text-faint"
                data-testid="last-price-crossed"
              >
                book crossed
              </span>
            ) : (
              <span className="text-[10px] uppercase tracking-wider text-text-faint">
                awaiting first fill
              </span>
            )}
          </>
        )}
      </div>

      {/* Stats row separator */}
      <span className="h-5 w-px bg-border" aria-hidden="true" />

      {/* Last = midpoint (we don't track a separate "Last" trade) */}
      <Stat
        label="Last"
        value={midpoint != null ? <NumberDisplay value={midpoint} kind="scaled-usd" decimals={2} /> : '—'}
        tooltip={
          bookCrossed
            ? 'Book is crossed; midpoint is unavailable until the next clear.'
            : 'Book midpoint (best bid + best ask) / 2'
        }
      />

      <Stat
        label="Oracle"
        value="—"
        tooltip="The on-chain oracle feed is deployed, but its value is not surfaced in the v1 header yet."
      />

      <Stat
        label="24h Vol"
        isStale={isIndexerStale && volume24h != null}
        asOf={asOfLabel}
        value={
          volume24h != null ? (
            <NumberDisplay value={volume24h} kind="scaled-base" decimals={2} />
          ) : (
            '—'
          )
        }
        tooltip={
          isIndexerStale && volume24h != null
            ? 'Indexer is delayed / offline; displayed 24h volume is cached and may be stale.'
            : indexerLive
              ? `From indexer /api/markets/0/state (sum of candles_1m over the last 24h, recomputed every 60s).`
              : 'Available when the indexer is live (M4). Start it with `pnpm -F indexer dev`.'
        }
      />

      <Stat
        label="OI"
        isStale={isIndexerStale && oi != null}
        asOf={asOfLabel}
        value={
          oi != null ? (
            <NumberDisplay value={oi} kind="scaled-base" decimals={2} />
          ) : (
            '—'
          )
        }
        tooltip={
          isIndexerStale && oi != null
            ? 'Indexer is delayed / offline; displayed open interest is cached and may be stale.'
            : indexerLive
              ? `From indexer /api/markets/0/state. Long ${marketState.data?.open_interest_long.toLocaleString()} + Short ${marketState.data?.open_interest_short.toLocaleString()}.`
              : 'Available when the indexer is live (M4). Start it with `pnpm -F indexer dev`.'
        }
      />

      <span className="h-5 w-px bg-border" aria-hidden="true" />

      {/* Batch phase + countdown */}
      {phasePresentation ? (
        <div className="flex min-w-0 items-center gap-2" data-testid="market-header-batch">
          <Pill tone={phasePresentation.tone}>Batch: {phasePresentation.label}</Pill>
          <span
            className="flex min-w-0 items-center gap-1 whitespace-nowrap font-mono text-[11px]"
            data-testid="market-header-intent"
            title={`${phasePresentation.intent.headline} · ${phasePresentation.intent.detail}`}
          >
            <span className="text-text">{phasePresentation.intent.headline}</span>
            <span className="text-text-faint" aria-hidden="true">{' · '}</span>
            <span className="truncate text-text-muted">
              {phasePresentation.intent.detail}
            </span>
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
  isStale,
  asOf,
}: {
  label: string;
  value: React.ReactNode;
  tooltip?: string;
  isStale?: boolean;
  asOf?: string | null;
}) {
  return (
    <div
      className="flex flex-col leading-tight"
      data-testid={`stat-${label.toLowerCase().replace(/\s+/g, '-')}`}
      title={tooltip}
    >
      <span className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-text-faint">
        <span>{label}</span>
        {isStale ? (
          <span
            data-testid={`stat-stale-${label.toLowerCase().replace(/\s+/g, '-')}`}
            className="text-warn text-[9px] font-mono lowercase tracking-normal"
            title="Indexer data is stale"
          >
            (stale)
          </span>
        ) : null}
      </span>
      <span className="font-mono text-xs tabular-nums text-text">
        {value}
        {asOf ? (
          <span
            data-testid={`stat-asof-${label.toLowerCase().replace(/\s+/g, '-')}`}
            className="ml-1 text-[9px] text-text-faint font-mono"
          >
            as of {asOf}
          </span>
        ) : null}
      </span>
    </div>
  );
}
