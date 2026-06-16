import type { ReactNode } from 'react';

export type PillTone = 'neutral' | 'warn' | 'info' | 'bull' | 'bear' | 'accent';

export interface PillProps {
  tone?: PillTone;
  children: ReactNode;
  className?: string;
}

const TONE_CLASS: Record<PillTone, string> = {
  neutral: 'bg-surface-2 text-text-muted border-border',
  warn: 'bg-surface-2 text-warn border-warn/40',
  info: 'bg-surface-2 text-info border-info/40',
  bull: 'bg-surface-2 text-bull border-bull/40',
  bear: 'bg-surface-2 text-bear border-bear/40',
  accent: 'bg-surface-2 text-accent border-accent/40',
};

export function Pill({ tone = 'neutral', children, className }: PillProps) {
  return (
    <span
      data-testid="pill"
      data-tone={tone}
      className={[
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider',
        TONE_CLASS[tone],
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </span>
  );
}
