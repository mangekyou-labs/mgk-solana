import { NumberDisplay } from './NumberDisplay';

export interface PnlDisplayProps {
  value: number;
  className?: string;
}

type Direction = 'bull' | 'bear' | 'flat';

const DIRECTION_CLASS: Record<Direction, string> = {
  bull: 'text-bull',
  bear: 'text-bear',
  flat: 'text-text-faint',
};

const DIRECTION_ARROW: Record<Direction, string> = {
  bull: '▲',
  bear: '▼',
  flat: '',
};

function directionFor(value: number): Direction {
  if (value > 0) return 'bull';
  if (value < 0) return 'bear';
  return 'flat';
}

export function PnlDisplay({ value, className }: PnlDisplayProps) {
  const direction = directionFor(value);
  const absValue = Math.abs(value);
  const sign = direction === 'bull' ? '+' : direction === 'bear' ? '−' : '';

  return (
    <span
      data-testid="pnl-display"
      data-direction={direction}
      className={['inline-flex items-center gap-1 font-mono tabular-nums', DIRECTION_CLASS[direction], className ?? '']
        .filter(Boolean)
        .join(' ')}
    >
      {direction !== 'flat' && <span aria-hidden="true">{DIRECTION_ARROW[direction]}</span>}
      <span>
        {sign}
        <NumberDisplay value={absValue} kind="plain" />
      </span>
    </span>
  );
}
