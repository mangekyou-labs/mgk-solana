'use client';

export type MarginMode = 'cross';

export interface MarginModeTabsProps {
  mode: MarginMode;
  /** Called when the user clicks a tab (no-op in v1 — only Cross is supported). */
  onSelect?: (mode: MarginMode) => void;
  className?: string;
}

/**
 * Margin mode selector — "Cross" only in v1 (locked).
 * Rendered as a single active pill; dimensions match the Bulk reference
 * so adding "Isolated" later is a tab-count change, not a layout break.
 */
export function MarginModeTabs({
  mode,
  className,
}: MarginModeTabsProps) {
  return (
    <div
      data-testid="margin-mode-tabs"
      data-mode={mode}
      className={`flex ${className ?? ''}`}
    >
      <span
        data-testid="margin-mode-cross"
        data-active="true"
        className="flex-1 py-1 text-center text-[11px] font-medium uppercase tracking-wider rounded border border-border bg-surface-2 text-text"
      >
        Cross
      </span>
    </div>
  );
}
