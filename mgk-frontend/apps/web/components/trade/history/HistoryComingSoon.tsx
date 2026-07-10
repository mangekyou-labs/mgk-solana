'use client';

import type { ReactNode } from 'react';

export interface HistoryComingSoonProps {
  /** testid root, e.g. 'order-history' → renders `data-testid="order-history-coming-soon"`. */
  testId: string;
  /** Tab title, e.g. 'Order History'. */
  title: string;
  /** One-line description of what this tab will eventually show. */
  description: string;
  /** Bullets describing the data sources the indexer would need to capture. */
  requiredSources: string[];
  /** Free-form children rendered above the empty state (e.g. filters). */
  actions?: ReactNode;
  className?: string;
}

/**
 * Placeholder for the four history tabs that the indexer does not yet capture:
 * Order, Funding, Position, Account. Renders a clear "coming soon" empty state
 * that explains the data the indexer would need to populate the tab. Lives in
 * its own component so we can swap in a real implementation later without
 * touching the BottomTabs tab router.
 */
export function HistoryComingSoon({
  testId,
  title,
  description,
  requiredSources,
  actions,
  className,
}: HistoryComingSoonProps) {
  return (
    <div
      data-testid={`${testId}-coming-soon`}
      data-history-tab={testId}
      className={`flex flex-col gap-3 px-4 py-6 font-mono text-xs ${className ?? ''}`}
    >
      <div className="flex items-center justify-between">
        <h3
          data-testid={`${testId}-coming-soon-title`}
          className="text-text-muted text-[11px] font-medium uppercase tracking-wider"
        >
          {title}
        </h3>
        <span
          data-testid={`${testId}-coming-soon-badge`}
          className="text-warn rounded-full border border-warn/40 bg-surface-2 px-2 py-0.5 text-[10px] uppercase tracking-wider"
        >
          Coming soon
        </span>
      </div>
      {actions}
      <p
        data-testid={`${testId}-coming-soon-description`}
        className="text-text-muted text-xs leading-relaxed"
      >
        {description}
      </p>
      <div className="flex flex-col gap-1">
        <div className="text-text-faint text-[10px] uppercase tracking-wider">
          Required indexer data
        </div>
        <ul
          data-testid={`${testId}-coming-soon-sources`}
          className="text-text-muted flex flex-col gap-0.5 pl-4 text-[11px]"
          style={{ listStyle: 'disc' }}
        >
          {requiredSources.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      </div>
      <p className="text-text-faint text-[10px] leading-relaxed">
        Tracked as G6 in <code className="text-text-muted">docs/ai/planning/2026-06-16-feature-mgk-frontend.md</code>.
        Trade History is wired today via the indexer&apos;s <code className="text-text-muted">/api/users/:pubkey/fills</code> route.
      </p>
    </div>
  );
}
