'use client';

import { useMemo } from 'react';
import * as sdk from '@mgk/sdk';

import { NumberDisplay } from '@/components/common/NumberDisplay';
import { DepthRow, type LevelRow } from './DepthRow';
import { OrderBookImbalance } from './OrderBookImbalance';

type BookLevel = sdk.state.BookLevel;

export interface OrderBookProps {
  bids: BookLevel[];
  asks: BookLevel[];
  className?: string;
}

export function OrderBook({ bids, asks, className }: OrderBookProps) {
  const { bidRows, askRows, totalBidSize, totalAskSize } = useMemo(() => {
    const buildRows = (levels: BookLevel[]): { rows: LevelRow[]; total: bigint } => {
      let cum = 0n;
      let total = 0n;
      const rows: LevelRow[] = [];
      for (const level of levels) {
        cum += level.totalQty;
        total += level.totalQty;
        rows.push({ level, cumulative: cum, barPct: 0 });
      }
      return { rows, total };
    };
    const { rows: bidRows, total: totalBidSize } = buildRows(bids);
    const { rows: askRows, total: totalAskSize } = buildRows(asks);
    const maxSize =
      bidRows.reduce(
        (m, r) => (r.level.totalQty > m ? r.level.totalQty : m),
        0n,
      ) ||
      askRows.reduce(
        (m, r) => (r.level.totalQty > m ? r.level.totalQty : m),
        0n,
      );
    for (const r of bidRows) {
      r.barPct = maxSize > 0n ? Number((r.level.totalQty * 100n) / maxSize) : 0;
    }
    for (const r of askRows) {
      r.barPct = maxSize > 0n ? Number((r.level.totalQty * 100n) / maxSize) : 0;
    }
    return { bidRows, askRows, totalBidSize, totalAskSize };
  }, [bids, asks]);

  const isEmpty = bids.length === 0 && asks.length === 0;

  if (isEmpty) {
    return (
      <div
        data-testid="orderbook-empty"
        className={`text-text-faint px-4 py-8 text-center font-mono text-xs ${className ?? ''}`}
      >
        No resting orders.
      </div>
    );
  }

  // Asks sorted ASC by price; for display we want best ask at the BOTTOM
  // (closest to the spread). Reverse the source array so the best ask is
  // the last row, and let flex-col lay them out top-to-bottom as
  // [ask_high … ask_best].
  const displayAsks = [...askRows].reverse();

  return (
    <div
      data-testid="orderbook"
      data-has-bids={bids.length > 0 ? 'true' : 'false'}
      data-has-asks={asks.length > 0 ? 'true' : 'false'}
      className={`flex flex-col font-mono text-xs ${className ?? ''}`}
    >
      <Header />
      <div data-testid="orderbook-asks" className="flex flex-col">
        {displayAsks.map((r, i) => (
          <DepthRow key={`ask-${i}`} row={r} side="ask" data-index={displayAsks.length - 1 - i} />
        ))}
      </div>
      <Spread
        bestBid={bids[0]?.price ?? null}
        bestAsk={asks[0]?.price ?? null}
      />
      <div data-testid="orderbook-bids" className="flex flex-col">
        {bidRows.map((r, i) => (
          <DepthRow key={`bid-${i}`} row={r} side="bid" data-index={i} />
        ))}
      </div>
      <OrderBookImbalance
        totalBidSize={totalBidSize}
        totalAskSize={totalAskSize}
      />
    </div>
  );
}

function Header() {
  return (
    <div
      data-testid="orderbook-header"
      className="text-text-faint grid grid-cols-3 border-b border-border px-2 py-1 text-[10px] uppercase tracking-wider"
    >
      <div>Price</div>
      <div className="text-right">Size</div>
      <div className="text-right">Total</div>
    </div>
  );
}

function Spread({
  bestBid,
  bestAsk,
}: {
  bestBid: bigint | null;
  bestAsk: bigint | null;
}) {
  if (bestBid === null || bestAsk === null) return null;
  const spread = bestAsk - bestBid;
  const spreadBps = bestBid > 0n ? Number((spread * 10000n) / bestBid) / 100 : 0;
  return (
    <div
      data-testid="orderbook-spread"
      data-spread={spread.toString()}
      data-spread-bps={spreadBps.toFixed(2)}
      className="text-text-muted grid grid-cols-3 border-y border-border bg-surface-1 px-2 py-1"
    >
      <div className="col-span-3 flex justify-between">
        <span>Spread</span>
        <span>
          <NumberDisplay value={spread} kind="scaled-usd" /> ({spreadBps.toFixed(2)}%)
        </span>
      </div>
    </div>
  );
}
