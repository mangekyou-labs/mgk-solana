export interface OrderBookImbalanceProps {
  totalBidSize: bigint;
  totalAskSize: bigint;
  className?: string;
}

export function OrderBookImbalance({
  totalBidSize,
  totalAskSize,
  className,
}: OrderBookImbalanceProps) {
  const total = totalBidSize + totalAskSize;
  if (total === 0n) {
    return null;
  }

  const bidPct = Number((totalBidSize * 100n) / total);
  const askPct = 100 - bidPct;

  return (
    <div
      data-testid="orderbook-imbalance"
      data-bid-pct={bidPct}
      data-ask-pct={askPct}
      className={`flex gap-2 items-center px-2 py-1 ${className ?? ''}`}
    >
      <span
        data-testid="imbalance-bid-label"
        className="text-bull font-mono text-[10px] tabular-nums whitespace-nowrap w-10 text-right"
      >
        B {bidPct}%
      </span>
      <div className="relative flex-1 h-1.5 bg-surface-3 rounded-full overflow-hidden">
        <div
          data-testid="imbalance-bid-bar"
          className="absolute inset-y-0 left-0 bg-bull/60 rounded-full"
          style={{ width: `${bidPct}%` }}
        />
        <div
          data-testid="imbalance-ask-bar"
          className="absolute inset-y-0 right-0 bg-bear/60 rounded-full"
          style={{ width: `${askPct}%` }}
        />
      </div>
      <span
        data-testid="imbalance-ask-label"
        className="text-bear font-mono text-[10px] tabular-nums whitespace-nowrap w-10"
      >
        S {askPct}%
      </span>
    </div>
  );
}
