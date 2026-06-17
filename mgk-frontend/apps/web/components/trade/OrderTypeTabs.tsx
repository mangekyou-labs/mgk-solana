'use client';

export type OrderMode = 'limit';

export interface OrderTypeTabsProps {
  mode: OrderMode;
  /** Called when the user clicks a tab (no-op in v1 — only Limit is supported). */
  onSelect?: (mode: OrderMode) => void;
  className?: string;
}

/**
 * Order type selector — "Limit" only in v1 (locked).
 * Rendered as a single active pill so adding "Market" / "Pro" later
 * is a tab-count change, not a layout break.
 */
export function OrderTypeTabs({
  mode,
  className,
}: OrderTypeTabsProps) {
  return (
    <div
      data-testid="order-type-tabs"
      data-mode={mode}
      className={`flex ${className ?? ''}`}
    >
      <span
        data-testid="order-type-limit"
        data-active="true"
        className="flex-1 py-1 text-center text-[11px] font-medium uppercase tracking-wider rounded border border-border bg-surface-2 text-text"
      >
        Limit
      </span>
    </div>
  );
}
