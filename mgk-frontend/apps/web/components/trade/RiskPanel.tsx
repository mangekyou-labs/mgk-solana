'use client';

import { NumberDisplay } from '@/components/common/NumberDisplay';

export interface RiskPanelProps {
  /** Per-position liquidation price (scaled 1e6). null → "—" */
  liqPrice: bigint | null;
  /** Position notional in USD (scaled 1e6). */
  notional: bigint;
  /** Free collateral in lamports. */
  freeCollateral: bigint;
  /** Whether portfolio data is loaded. When false, shows "—". */
  loading?: boolean;
  className?: string;
}

/**
 * Risk metrics strip below the order form summary.
 * Shows Liq. Price, Leverage (notional / freeCollateral), and
 * Margin Usage (im / equity). Falls back to "—" when values
 * aren't available (disconnected / no portfolio / no position).
 */
export function RiskPanel({
  liqPrice,
  notional,
  freeCollateral,
  loading = false,
  className,
}: RiskPanelProps) {
  const leverage =
    notional > 0n && freeCollateral > 0n
      ? Number(notional) / Number(freeCollateral)
      : null;

  return (
    <div
      data-testid="order-form-risk-panel"
      className={`flex flex-col gap-0.5 text-text-muted text-[10px] border-t border-border pt-2 ${className ?? ''}`}
    >
      <RiskRow
        label="Liq Price"
        value={
          liqPrice !== null && !loading ? (
            <NumberDisplay value={liqPrice} kind="scaled-usd" />
          ) : undefined
        }
        muted={liqPrice === null || loading}
      />
      <RiskRow
        label="Leverage"
        value={
          leverage !== null && !loading
            ? `${leverage.toFixed(1)}x`
            : undefined
        }
        muted={leverage === null || loading}
      />
      <RiskRow
        label="Free Collateral"
        value={
          !loading ? (
            <NumberDisplay value={freeCollateral} kind="lamports" />
          ) : undefined
        }
        muted={loading}
      />
    </div>
  );
}

function RiskRow({
  label,
  value,
  muted,
}: {
  label: string;
  value?: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <div
      data-testid={`risk-row-${label.toLowerCase().replace(/[\s.]+/g, '-')}`}
      className={`flex justify-between ${muted ? 'text-text-faint' : ''}`}
    >
      <span>{label}</span>
      <span>{value ?? '—'}</span>
    </div>
  );
}
