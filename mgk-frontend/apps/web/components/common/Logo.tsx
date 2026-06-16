import type { CSSProperties } from 'react';

export interface LogoProps {
  iconSize?: number;
  className?: string;
}

const VIEWBOX = '0 0 80 32';
const DEFAULT_ICON_SIZE = 24;
const ICON_CX = 16;
const ICON_CY = 16;
const OUTER_R = 13;
const INNER_R = 1.6;
const COMMA_PATH = 'M 16 4 C 19 4 21 7 19 11 C 17 15 13 13 14 9 C 14.5 6 15 4.5 16 4 Z';

export function Logo({ iconSize = DEFAULT_ICON_SIZE, className }: LogoProps) {
  const style: CSSProperties = { color: 'var(--color-accent)' };
  return (
    <svg
      role="img"
      aria-label="mgk"
      viewBox={VIEWBOX}
      width={iconSize}
      height={iconSize}
      className={className}
      style={style}
    >
      <g data-token="accent" transform={`translate(${iconSize - 32} 0)`}>
        <circle cx={ICON_CX} cy={ICON_CY} r={OUTER_R} fill="none" stroke="currentColor" strokeWidth={1.25} />
        <g fill="currentColor">
          <path d={COMMA_PATH} />
          <path d={COMMA_PATH} transform={`rotate(120 ${ICON_CX} ${ICON_CY})`} />
          <path d={COMMA_PATH} transform={`rotate(240 ${ICON_CX} ${ICON_CY})`} />
        </g>
        <circle cx={ICON_CX} cy={ICON_CY} r={INNER_R} fill="currentColor" />
      </g>
      <text
        data-testid="mgk-wordmark"
        x={36}
        y={22}
        fill="currentColor"
        fontFamily="var(--font-sans)"
        fontWeight={700}
        fontSize={16}
        letterSpacing="0.06em"
      >
        mgk
      </text>
    </svg>
  );
}
