'use client';

import { useCallback, useState } from 'react';

import { ChartToolbar, type CandleResolution } from './ChartToolbar';
import { MgkTradeMarkers } from './MgkTradeMarkers';
import { TradingViewWidget, type TradingViewInterval } from './TradingViewWidget';
import { useIndexerWs } from '@/lib/chart/useIndexerWs';

export interface PriceChartProps {
  instrumentId?: number;
  className?: string;
}

const CHART_HEIGHT = 400;

const RESOLUTION_TO_TV_INTERVAL: Record<CandleResolution, TradingViewInterval> = {
  '1m': '1',
  '5m': '5',
  '15m': '15',
  '1h': '60',
  '4h': '240',
  '1d': 'D',
};

const TV_SYMBOL = 'BINANCE:SOLUSDT' as const;

export function PriceChart({ instrumentId = 0, className }: PriceChartProps) {
  const [resolution, setResolution] = useState<CandleResolution>('5m');
  const [viewMode, setViewMode] = useState<'chart' | 'market-info'>('chart');
  const { simpleMarkers, isConnected } = useIndexerWs(instrumentId);

  const handleResolution = useCallback((r: CandleResolution) => {
    setResolution(r);
  }, []);

  return (
    <div className={className} data-testid="price-chart" data-instrument-id={instrumentId}>
      <ChartToolbar
        resolution={resolution}
        isConnected={isConnected}
        onResolutionChange={handleResolution}
        onViewModeChange={setViewMode}
        viewMode={viewMode}
      />

      <div className="relative" style={{ height: CHART_HEIGHT }}>
        {viewMode === 'chart' ? (
          <>
            <TradingViewWidget
              symbol={TV_SYMBOL}
              interval={RESOLUTION_TO_TV_INTERVAL[resolution]}
            />
            <MgkTradeMarkers
              markers={simpleMarkers}
              containerHeight={CHART_HEIGHT}
            />
          </>
        ) : null}

        {viewMode === 'market-info' && (
          <div
            data-testid="market-info-placeholder"
            className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-bg/95 font-mono text-xs text-text-muted"
          >
            <div className="mb-2 text-text-faint">Market Info</div>
            <div className="flex gap-4">
              <span className="text-text-faint">24h Vol</span>
              <span>—</span>
            </div>
            <div className="flex gap-4">
              <span className="text-text-faint">OI</span>
              <span>—</span>
            </div>
            <div className="flex gap-4">
              <span className="text-text-faint">Funding</span>
              <span>—</span>
            </div>
            <div className="flex gap-4">
              <span className="text-text-faint">Mark</span>
              <span>—</span>
            </div>
            <div className="flex gap-4">
              <span className="text-text-faint">Oracle</span>
              <span>—</span>
            </div>
            <div className="mt-2 text-[10px] text-text-faint">
              Available when the indexer is live (M4)
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
