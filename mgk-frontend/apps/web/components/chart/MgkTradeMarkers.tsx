'use client';

import { useMemo } from 'react';

/**
 * A single trade marker with price and side. Price is already divided by
 * 1e6 (USD-scaled) by useIndexerWs.
 */
export interface MgkMarker {
  price: number;
  side: 'buy' | 'sell';
}

export interface MgkTradeMarkersProps {
  markers: MgkMarker[];
  containerHeight: number;
  /** Padding top/bottom as fraction of the price range (0.08 = 8%). */
  paddingFraction?: number;
  maxVisible?: number;
}

const MARKER_SIZE = 10;
const PADDING_RIGHT = 4;

/**
 * Renders mgk trade markers as colored triangles on the right edge of
 * the chart container. Markers are positioned vertically based on their
 * price relative to the visible range. Does not need the chart's
 * internal coordinate system — position is estimated from the marker
 * prices themselves.
 */
export function MgkTradeMarkers({
  markers,
  containerHeight,
  paddingFraction = 0.08,
  maxVisible = 30,
}: MgkTradeMarkersProps) {
  const visible = useMemo(() => markers.slice(-maxVisible), [markers, maxVisible]);

  const bounds = useMemo(() => {
    if (visible.length === 0) return null;
    let lo = Infinity;
    let hi = -Infinity;
    for (const m of visible) {
      if (m.price < lo) lo = m.price;
      if (m.price > hi) hi = m.price;
    }
    if (lo === hi) {
      lo -= 1;
      hi += 1;
    }
    const pad = (hi - lo) * paddingFraction;
    return { lo: lo - pad, hi: hi + pad, range: hi - lo + 2 * pad };
  }, [visible, paddingFraction]);

  if (!bounds || visible.length === 0) return null;

  const innerH = containerHeight - MARKER_SIZE;

  return (
    <div
      data-testid="mgk-trade-markers"
      className="absolute top-0 right-0 pointer-events-none z-10"
      style={{ height: containerHeight, width: MARKER_SIZE + PADDING_RIGHT }}
    >
      {visible.map((m, i) => {
        const y = innerH * (1 - (m.price - bounds.lo) / bounds.range);
        const color = m.side === 'buy' ? '#22c55e' : '#dc2626';
        const char = m.side === 'buy' ? '▲' : '▼';
        return (
          <span
            key={i}
            className="absolute right-0 text-[10px] leading-none opacity-80"
            style={{
              top: Math.max(0, Math.min(innerH, Math.round(y))),
              color,
            }}
            title={`${m.side === 'buy' ? 'Buy' : 'Sell'} @ ${m.price.toFixed(2)}`}
          >
            {char}
          </span>
        );
      })}
    </div>
  );
}
