'use client';

import { NumberDisplay } from '@/components/common/NumberDisplay';

export interface Trade {
  /** Stable id for React key + future REST dedupe. */
  id: string;
  /** Trade time, milliseconds since epoch. */
  timestamp: number;
  /** Fill price, scaled 1e6 (UI/USD). */
  price: bigint;
  /** Fill qty, scaled 1e6 (UI/base units). */
  qty: bigint;
  /** Taker side: 'buy' = aggressor bought, 'sell' = aggressor sold. */
  side: 'buy' | 'sell';
}

export interface RecentTradesProps {
  trades: Trade[];
  className?: string;
  /** Render at most this many rows. Default 50. */
  maxRows?: number;
}

const SIDE_CLASS = {
  buy: 'text-bull',
  sell: 'text-bear',
} as const;

const SIDE_LABEL = {
  buy: 'Buy',
  sell: 'Sell',
} as const;

/** Format a timestamp as HH:MM:SS in local time. Exported for testability. */
export function formatTradeTime(ms: number): string {
  const d = new Date(ms);
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  const ss = d.getSeconds().toString().padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function RecentTrades({ trades, className, maxRows = 50 }: RecentTradesProps) {
  const rows = trades.slice(0, maxRows);
  const isEmpty = rows.length === 0;

  return (
    <div
      data-testid="recent-trades"
      data-count={rows.length}
      className={`flex flex-col font-mono text-xs ${className ?? ''}`}
    >
      <Header />
      {isEmpty ? (
        <div
          data-testid="recent-trades-empty"
          className="text-text-faint px-4 py-8 text-center"
        >
          No trades yet.
        </div>
      ) : (
        <div data-testid="recent-trades-rows" className="flex flex-col">
          {rows.map((t) => (
            <Row key={t.id} trade={t} />
          ))}
        </div>
      )}
    </div>
  );
}

function Header() {
  return (
    <div
      data-testid="recent-trades-header"
      className="text-text-faint grid grid-cols-[1fr_1fr_1fr_60px] border-b border-border px-2 py-1 text-[10px] uppercase tracking-wider"
    >
      <div>Time</div>
      <div className="text-right">Price</div>
      <div className="text-right">Size</div>
      <div className="text-right">Side</div>
    </div>
  );
}

function Row({ trade }: { trade: Trade }) {
  return (
    <div
      data-testid="recent-trades-row"
      data-side={trade.side}
      className="hover:bg-surface-2 grid grid-cols-[1fr_1fr_1fr_60px] items-center px-2 py-0.5"
      style={{ minHeight: '22px' }}
    >
      <div
        data-testid="recent-trades-time"
        data-timestamp={trade.timestamp}
        className="text-text-muted"
      >
        {formatTradeTime(trade.timestamp)}
      </div>
      <div
        data-testid="recent-trades-price"
        className={`${SIDE_CLASS[trade.side]} text-right`}
      >
        <NumberDisplay value={trade.price} kind="scaled-usd" />
      </div>
      <div
        data-testid="recent-trades-size"
        className="text-text text-right"
      >
        <NumberDisplay value={trade.qty} kind="scaled-base" />
      </div>
      <div
        data-testid="recent-trades-side"
        data-side={trade.side}
        className={`${SIDE_CLASS[trade.side]} text-right text-[10px] uppercase`}
      >
        {SIDE_LABEL[trade.side]}
      </div>
    </div>
  );
}
