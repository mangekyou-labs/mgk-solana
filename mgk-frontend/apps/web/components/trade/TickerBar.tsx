'use client';

import { useEffect, useState } from 'react';

import { Pill, type PillTone } from '@/components/common/Pill';
import { usePythPrices, type PythFeedState } from '@/lib/stores/usePythPriceStore';
import { config } from '@/lib/config';

type Direction = 'up' | 'down' | 'flat';

interface TickerEntryProps {
  symbol: string;
  state: PythFeedState;
}

/**
 * A single ticker strip cell: symbol + price + tick-direction arrow.
 *
 * The arrow reflects the tick-to-tick price direction (vs the previous
 * successful fetch), not a true 24h change. The 24h change is deferred
 * to M4 (indexer will compute it from candle history).
 */
function TickerEntry({ symbol, state }: TickerEntryProps) {
  const [previousPrice, setPreviousPrice] = useState<bigint | null>(null);
  const [direction, setDirection] = useState<Direction>('flat');

  // Compute direction against the previous price. We intentionally
  // close over the previousPrice state at the time this effect was
  // queued (not the latest), so consecutive fetches can be diffed
  // deterministically — even if React re-renders between dispatches.
  //
  // The `react-hooks/set-state-in-effect` rule warns about setState in
  // effects, but the alternative (deriving direction from previousPrice
  // state in render) would flicker to 'flat' between the previous
  // fetch's render and the next fetch's effect. This pattern is the
  // standard fix for "diff against previous async update" — the
  // dependency suppression below is intentional.
  /* eslint-disable react-hooks/exhaustive-deps, react-hooks/set-state-in-effect */
  useEffect(() => {
    if (state.data) {
      if (previousPrice != null) {
        if (state.data.price > previousPrice) setDirection('up');
        else if (state.data.price < previousPrice) setDirection('down');
        else setDirection('flat');
      }
      setPreviousPrice(state.data.price);
    }
  }, [state.data]);
  /* eslint-enable react-hooks/exhaustive-deps, react-hooks/set-state-in-effect */

  const tone: PillTone =
    direction === 'up' ? 'bull' : direction === 'down' ? 'bear' : 'neutral';

  const arrow =
    direction === 'up' ? '▲' : direction === 'down' ? '▼' : '—';

  return (
    <div
      className="flex items-center gap-1.5"
      data-testid={`ticker-${symbol.toLowerCase()}`}
      data-direction={direction}
    >
      <span className="text-[11px] font-medium uppercase tracking-wider text-text-muted">
        {symbol}
      </span>
      {state.error ? (
        <span
          className="font-mono text-xs text-warn"
          data-testid={`ticker-${symbol.toLowerCase()}-error`}
          title={state.error}
        >
          —
        </span>
      ) : state.data ? (
        <span className="font-mono text-xs tabular-nums text-text">
          <PriceText value={state.data.price} />
        </span>
      ) : (
        <span
          className="font-mono text-xs text-text-faint"
          data-testid={`ticker-${symbol.toLowerCase()}-loading`}
        >
          …
        </span>
      )}
      <Pill tone={tone} data-testid={`ticker-${symbol.toLowerCase()}-pill`}>
        {arrow}
      </Pill>
    </div>
  );
}

function PriceText({ value }: { value: bigint }) {
  // Inline formatting to avoid a NumberDisplay import cycle in this
  // tiny component. The Pyth price is normalized to 1e6.
  // We render "$XXX.XX" with grouping. v1 keeps it simple — no
  // abbreviation, no sub-cent precision.
  const intPart = value / 1_000_000n;
  const fracPart = value % 1_000_000n;
  const intStr = intPart.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fracStr = fracPart.toString().padStart(6, '0').slice(0, 2);
  return (
    <>
      ${intStr}.{fracStr}
    </>
  );
}

/**
 * TickerBar — the 32px strip at the top of the trade page (above the
 * page header). Shows BTC-USD, ETH-USD, SOL-USD with tick-direction
 * arrows. Non-clickable in v1 (design decision — the ticker is for
 * context, not navigation).
 */
export function TickerBar() {
  const feedIds = [
    config.pythBtcFeedId,
    config.pythEthFeedId,
    config.pythSolFeedId,
  ];
  const [btc, eth, sol] = usePythPrices(feedIds, { intervalMs: 10_000 });

  return (
    <div
      data-testid="ticker-bar"
      className="flex h-8 shrink-0 items-center gap-4 border-b border-border bg-surface-1 px-4"
    >
      <TickerEntry symbol="BTC-USD" state={btc} />
      <TickerEntry symbol="ETH-USD" state={eth} />
      <TickerEntry symbol="SOL-USD" state={sol} />
      <span className="ml-auto text-[10px] uppercase tracking-wider text-text-faint">
        Pyth
      </span>
    </div>
  );
}
