export type NumberKind = 'plain' | 'lamports' | 'scaled-usd' | 'scaled-base';

export interface NumberDisplayProps {
  value: number | bigint;
  kind?: NumberKind;
  decimals?: number;
  className?: string;
}

const KIND_SCALE: Record<NumberKind, number> = {
  plain: 1,
  lamports: 1_000_000_000,
  'scaled-usd': 1_000_000,
  'scaled-base': 1_000_000,
};

const KIND_DECIMALS: Record<NumberKind, number> = {
  plain: 2,
  lamports: 4,
  'scaled-usd': 2,
  'scaled-base': 6,
};

function toNumber(value: number | bigint): number {
  return typeof value === 'bigint' ? Number(value) : value;
}

export function NumberDisplay({
  value,
  kind = 'plain',
  decimals,
  className,
}: NumberDisplayProps) {
  const scale = KIND_SCALE[kind];
  const d = decimals ?? KIND_DECIMALS[kind];
  const numeric = toNumber(value) / scale;
  const isMuted = toNumber(value) === 0;
  const display = numeric.toLocaleString('en-US', {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });

  return (
    <span
      data-testid="number-display"
      data-muted={isMuted ? 'true' : 'false'}
      className={['font-mono tabular-nums', isMuted ? 'text-text-faint' : 'text-text', className ?? '']
        .filter(Boolean)
        .join(' ')}
    >
      {display}
    </span>
  );
}
