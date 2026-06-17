'use client';

export type CandleResolution = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

export interface ChartToolbarProps {
  resolution: CandleResolution;
  isConnected: boolean;
  onResolutionChange: (r: CandleResolution) => void;
  onViewModeChange?: (mode: 'chart' | 'market-info') => void;
  viewMode?: 'chart' | 'market-info';
}

type ViewMode = 'chart' | 'market-info';

const TIMEFRAMES: { label: string; value: CandleResolution }[] = [
  { label: '1m', value: '1m' },
  { label: '5m', value: '5m' },
  { label: '15m', value: '15m' },
  { label: '1H', value: '1h' },
  { label: '4H', value: '4h' },
  { label: '1D', value: '1d' },
];

const VIEW_MODES: { label: string; value: ViewMode }[] = [
  { label: 'Chart', value: 'chart' },
  { label: 'Market Info', value: 'market-info' },
];

export function ChartToolbar({
  resolution,
  isConnected,
  onResolutionChange,
  onViewModeChange,
  viewMode = 'chart',
}: ChartToolbarProps) {
  return (
    <div
      data-testid="chart-toolbar"
      className="flex items-center gap-1.5 px-2 border-b border-border"
      style={{ height: 28 }}
    >
      {TIMEFRAMES.map((tf) => (
        <button
          key={tf.value}
          type="button"
          data-testid={`tf-${tf.value}`}
          data-active={resolution === tf.value ? 'true' : 'false'}
          onClick={() => onResolutionChange(tf.value)}
          className={[
            'px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider rounded transition-colors',
            resolution === tf.value
              ? 'bg-surface-3 text-text'
              : 'text-text-muted hover:text-text',
          ].join(' ')}
        >
          {tf.label}
        </button>
      ))}

      {/* Spacer between timeframes and the right-side controls */}
      <span className="flex-1" />

      {/* View mode tabs: Chart | Market Info */}
      {onViewModeChange && (
        <span className="flex items-center gap-0.5">
          {VIEW_MODES.map((vm, i) => (
            <span key={vm.value} className="flex items-center gap-0.5">
              {i > 0 && (
                <span className="text-border-strong text-[10px]">|</span>
              )}
              <button
                type="button"
                data-testid={`vm-${vm.value}`}
                data-active={viewMode === vm.value ? 'true' : 'false'}
                onClick={() => onViewModeChange(vm.value)}
                className={[
                  'px-1.5 py-0.5 text-[10px] font-mono rounded transition-colors',
                  viewMode === vm.value
                    ? 'text-text'
                    : 'text-text-faint hover:text-text-muted',
                ].join(' ')}
              >
                {vm.label}
              </button>
            </span>
          ))}
        </span>
      )}

      {/* Mark/Oracle toggle (UI only in v1 — keeper not yet online) */}
      <span className="flex items-center gap-0.5 ml-2">
        <button
          type="button"
          data-testid="toggle-mark"
          data-active="true"
          disabled
          title="Mark price (on-chain) — coming when keeper is online"
          className="px-1.5 py-0.5 text-[10px] font-mono rounded text-text cursor-not-allowed"
        >
          Mark
        </button>
        <span className="text-border-strong text-[10px]">|</span>
        <button
          type="button"
          data-testid="toggle-oracle"
          data-active="false"
          disabled
          title="Oracle price (Pyth) — coming when keeper is online"
          className="px-1.5 py-0.5 text-[10px] font-mono rounded text-text-faint cursor-not-allowed"
        >
          Oracle
        </button>
      </span>

      {/* Indicators button (disabled in v1) */}
      <button
        type="button"
        data-testid="btn-indicators"
        disabled
        title="Indicators (coming in v1.1)"
        className="ml-2 px-1.5 py-0.5 text-[10px] font-mono rounded text-text-faint cursor-not-allowed"
      >
        Indicators
      </button>

      {/* Indexer WS status: live (green) / off (warn) */}
      <span className="ml-2 flex items-center gap-1">
        <span
          data-testid="chart-ws-status"
          className="flex items-center gap-1 font-mono text-[10px]"
        >
          <span className={isConnected ? 'text-online' : 'text-offline'}>
            {isConnected ? '●' : '○'}
          </span>
          <span className={isConnected ? 'text-text-muted' : 'text-warn'}>
            {isConnected ? 'live' : 'off'}
          </span>
        </span>
      </span>
    </div>
  );
}
