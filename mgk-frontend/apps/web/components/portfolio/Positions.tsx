'use client';

import * as sdk from '@mgk/sdk';
import { NumberDisplay } from '@/components/common/NumberDisplay';
import { Pill, type PillTone } from '@/components/common/Pill';

type PortfolioState = sdk.state.PortfolioState;
type Position = sdk.state.Position;

export interface PositionsProps {
  data: PortfolioState | null;
  /** Per-instrument mark price (raw, scaled 1e6). When omitted, PnL is hidden. */
  markPrices?: Record<number, bigint>;
  loading?: boolean;
  className?: string;
}

/**
 * Compute the liquidation price for a single position from the global mm
 * + principal. V1 approximation: assumes the global mm is attributable to
 * this position (in reality mm is a sum across positions; a per-position
 * liq price needs a per-position margin breakdown the on-chain state
 * doesn't expose today).
 *
 * Unit math (from on-chain: `notional = qty * price`, with notional in
 * lamports and `equity`/`principal`/`mm` in lamports):
 *   collateral_lamports = qty * price  (raw, in lamports)
 *   At liq: equity = mm  →  principal + qty * (liq - entry) = mm
 *   ⇒ liq = entry + (mm - principal) / qty
 */
export function computeLiqPrice(
  qty: bigint,
  entryVwap: bigint,
  principal: bigint,
  mm: bigint,
): bigint | null {
  if (qty === 0n) return null;
  const delta = mm - principal;
  return entryVwap + delta / qty;
}

function sideOf(qty: bigint): 'long' | 'short' | 'flat' {
  if (qty > 0n) return 'long';
  if (qty < 0n) return 'short';
  return 'flat';
}

const SIDE_TONE: Record<'long' | 'short' | 'flat', PillTone> = {
  long: 'bull',
  short: 'bear',
  flat: 'neutral',
};

const SIDE_LABEL: Record<'long' | 'short' | 'flat', string> = {
  long: 'Long',
  short: 'Short',
  flat: 'Flat',
};

export function Positions({
  data,
  markPrices,
  loading,
  className,
}: PositionsProps) {
  if (loading) {
    return (
      <section
        data-testid="positions"
        data-state="loading"
        className={['rounded-md border border-border bg-surface-1 p-4', className ?? '']
          .filter(Boolean)
          .join(' ')}
      >
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-muted">
          Positions
        </h3>
        <p className="mt-2 text-text-faint">Loading…</p>
      </section>
    );
  }

  if (!data || data.positionsLen === 0) {
    return (
      <section
        data-testid="positions"
        data-state="empty"
        className={['rounded-md border border-border bg-surface-1 p-4', className ?? '']
          .filter(Boolean)
          .join(' ')}
      >
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-muted">
          Positions
        </h3>
        <p className="mt-2 text-text-faint">You have no open positions yet.</p>
      </section>
    );
  }

  const rows: Position[] = data.positions.slice(0, data.positionsLen);

  return (
    <section
      data-testid="positions"
      data-state="ready"
      className={['rounded-md border border-border bg-surface-1', className ?? '']
        .filter(Boolean)
        .join(' ')}
    >
      <header className="flex items-center justify-between border-b border-border px-4 py-2">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-muted">
          Positions
        </h3>
        <span
          data-testid="positions-count"
          className="text-text-faint text-[11px] tabular-nums"
        >
          {data.positionsLen}
        </span>
      </header>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-text-faint uppercase tracking-wider text-[10px]">
            <th className="px-4 py-2 text-left font-normal">Side</th>
            <th className="px-2 py-2 text-right font-normal">Size</th>
            <th className="px-2 py-2 text-right font-normal">Entry</th>
            <th className="px-2 py-2 text-right font-normal">PnL</th>
            <th className="px-4 py-2 text-right font-normal">Liq. Price</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p, i) => (
            <PositionRow
              key={`${p.instrumentId}-${i}`}
              position={p}
              principal={data.principal}
              mm={data.mm}
              markPrice={markPrices?.[p.instrumentId] ?? null}
            />
          ))}
        </tbody>
      </table>
    </section>
  );
}

function PositionRow({
  position,
  principal,
  mm,
  markPrice,
}: {
  position: Position;
  principal: bigint;
  mm: bigint;
  markPrice: bigint | null;
}) {
  const side = sideOf(position.qty);
  const liq = computeLiqPrice(position.qty, position.entryVwap, principal, mm);
  const pnlLamports =
    markPrice !== null ? position.qty * (markPrice - position.entryVwap) : null;

  return (
    <tr
      data-testid="position-row"
      data-instrument={position.instrumentId}
      data-side={side}
      className="border-t border-border"
    >
      <td className="px-4 py-2">
        <Pill tone={SIDE_TONE[side]}>{SIDE_LABEL[side]}</Pill>
      </td>
      <td className="px-2 py-2 text-right font-mono tabular-nums">
        <NumberDisplay value={position.qty} kind="scaled-base" />
      </td>
      <td className="px-2 py-2 text-right font-mono tabular-nums">
        <NumberDisplay value={position.entryVwap} kind="scaled-usd" />
      </td>
      <td className="px-2 py-2 text-right" data-testid="position-pnl">
        {pnlLamports === null ? (
          <span className="text-text-faint">—</span>
        ) : (
          <NumberDisplay
            value={Number(pnlLamports) / 1_000_000_000}
            kind="plain"
            decimals={4}
          />
        )}
      </td>
      <td className="px-4 py-2 text-right font-mono tabular-nums" data-testid="position-liq">
        {liq === null ? (
          <span className="text-text-faint">—</span>
        ) : liq < 0n ? (
          <span className="text-text-faint">n/a</span>
        ) : (
          <NumberDisplay value={liq} kind="scaled-usd" />
        )}
      </td>
    </tr>
  );
}
