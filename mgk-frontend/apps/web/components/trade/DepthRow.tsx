import type * as sdk from '@mgk/sdk';

import { NumberDisplay } from '@/components/common/NumberDisplay';

type BookLevel = sdk.state.BookLevel;

export interface LevelRow {
  level: BookLevel;
  cumulative: bigint;
  barPct: number;
}

export function DepthRow({
  row,
  side,
  'data-index': dataIndex,
}: {
  row: LevelRow;
  side: 'bid' | 'ask';
  'data-index'?: number;
}) {
  const tone = side === 'bid' ? 'bull' : 'bear';
  const barTone = side === 'bid' ? 'bg-bull/10' : 'bg-bear/10';

  return (
    <div
      data-testid="depth-row"
      data-side={side}
      data-index={dataIndex}
      className="hover:bg-surface-2 relative grid grid-cols-3 px-2 py-0.5"
    >
      <div
        aria-hidden
        className={`absolute inset-y-0 right-0 ${barTone}`}
        style={{ width: `${row.barPct}%` }}
      />
      <div data-testid="depth-row-price" className={`text-${tone} relative`}>
        <NumberDisplay value={row.level.price} kind="scaled-usd" />
      </div>
      <div data-testid="depth-row-size" className="text-text relative text-right">
        <NumberDisplay value={row.level.totalQty} kind="scaled-base" />
      </div>
      <div data-testid="depth-row-total" className="text-text-muted relative text-right">
        <NumberDisplay value={row.cumulative} kind="scaled-base" />
      </div>
    </div>
  );
}
