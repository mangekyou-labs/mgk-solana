export interface SkeletonProps {
  className?: string;
  /** Width in px or Tailwind class like "w-24" */
  width?: string;
  /** Height in px or Tailwind class like "h-4" */
  height?: string;
}

export function Skeleton({ className = '', width = 'w-full', height = 'h-4' }: SkeletonProps) {
  return (
    <div
      data-testid="skeleton"
      className={`animate-pulse rounded bg-surface-3 ${width} ${height} ${className}`}
    />
  );
}

export function SkeletonRow({ cols = 3, className = '' }: { cols?: number; className?: string }) {
  return (
    <div className={`flex gap-3 px-3 py-2 ${className}`}>
      {Array.from({ length: cols }, (_, i) => (
        <Skeleton key={i} height="h-3" width={i === 0 ? 'w-24' : 'flex-1'} />
      ))}
    </div>
  );
}

export function ChartSkeleton() {
  return (
    <div
      data-testid="chart-skeleton"
      className="flex flex-col border-b border-border"
    >
      <div className="flex items-center gap-1 px-2 border-b border-border" style={{ height: 28 }}>
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} height="h-4" width="w-8" />
        ))}
      </div>
      <div
        className="flex items-center justify-center bg-bg font-mono text-xs text-text-faint"
        style={{ height: 400 }}
      >
        Loading chart…
      </div>
    </div>
  );
}
