export type StatusDotState = 'online' | 'offline' | 'connecting';

export interface StatusDotProps {
  state: StatusDotState;
  className?: string;
}

const STATE_CLASS: Record<StatusDotState, string> = {
  online: 'text-online',
  offline: 'text-offline',
  connecting: 'text-warn animate-pulse',
};

const STATE_GLYPH: Record<StatusDotState, string> = {
  online: '●',
  offline: '○',
  connecting: '◐',
};

export function StatusDot({ state, className }: StatusDotProps) {
  return (
    <span
      data-testid="status-dot"
      data-state={state}
      aria-label={state}
      className={['inline-block text-xs leading-none', STATE_CLASS[state], className ?? '']
        .filter(Boolean)
        .join(' ')}
    >
      {STATE_GLYPH[state]}
    </span>
  );
}
