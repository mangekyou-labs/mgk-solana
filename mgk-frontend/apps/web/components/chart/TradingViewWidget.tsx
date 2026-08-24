'use client';

import { useEffect, useId, useRef, useState } from 'react';

import type { TradingViewChart, TradingViewWidgetInstance } from '@/global';

let tvScriptLoadingPromise: Promise<void> | null = null;

/**
 * Loads the TradingView widget script exactly once across the app. The
 * free Advanced Chart widget ships a single `tv.js` bundle that exposes
 * `new window.TradingView.widget(config)` — no API key, no GitHub
 * approval, TradingView handles all the data + indicators + drawing
 * tools. We only need a custom data feed if we want to overlay our own
 * on-chain fills (v1.1 follow-up).
 */
function loadTradingViewScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (window.TradingView) return Promise.resolve();
  if (tvScriptLoadingPromise) return tvScriptLoadingPromise;

  tvScriptLoadingPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      'script[data-tv-script="loaded"]',
    );
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () =>
        reject(new Error('TradingView script failed to load')),
      );
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://s3.tradingview.com/tv.js';
    script.async = true;
    script.dataset.tvScript = 'loaded';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('TradingView script failed to load'));
    document.head.appendChild(script);
  });

  return tvScriptLoadingPromise;
}

/**
 * Subset of TradingView interval strings the widget understands. Kept
 * in sync with `ChartToolbar`'s `TIMEFRAMES`.
 */
export type TradingViewInterval = '1' | '5' | '15' | '60' | '240' | 'D';

export interface TradingViewWidgetProps {
  symbol?: string;
  interval?: TradingViewInterval;
  className?: string;
  onChartReady?: (chart: TradingViewChart) => void;
  onError?: (message: string) => void;
}

/**
 * Default TradingView Advanced Chart widget. Dark theme tuned to the
 * Sharingan palette (`--color-bg` → `#0a0a0a`, `--color-border` →
 * `#1f1f1f`). Candles are TradingView's defaults (green/red — close
 * enough to our bull/bear). Symbol is `BINANCE:SOLUSDT` because the
 * free widget ships with TradingView's own data feed; on-chain price
 * comes from the indexer + oracle and is shown elsewhere in the UI.
 */
export function TradingViewWidget({
  symbol = 'BINANCE:SOLUSDT',
  interval = '5',
  className,
  onChartReady,
  onError,
}: TradingViewWidgetProps) {
  const containerId = useId();
  const widgetRef = useRef<TradingViewWidgetInstance | null>(null);
  const onChartReadyRef = useRef(onChartReady);
  const onErrorRef = useRef(onError);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [scriptError, setScriptError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  // Keep the latest callback refs current across renders. Doing this in
  // an effect (rather than during render) avoids the React 19 "cannot
  // access refs during render" rule.
  useEffect(() => {
    onChartReadyRef.current = onChartReady;
  }, [onChartReady]);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  // Mount the widget ONCE per container. Symbol/interval are captured
  // from the initial render; subsequent prop changes flow through the
  // dedicated prop effect below. Re-creating the widget on every
  // prop change would tear down user-selected indicators and drawings.
  // `retryNonce` is the exception: a failed script load must remount.
  /* eslint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    let cancelled = false;

    loadTradingViewScript()
      .then(() => {
        if (cancelled) return;
        if (!window.TradingView) {
          const msg = 'TradingView global not available after script load';
          setScriptError(msg);
          setPhase('error');
          onErrorRef.current?.(msg);
          return;
        }
        const widget = new window.TradingView.widget({
          symbol,
          interval,
          container_id: `tv-${containerId}`,
          autosize: true,
          timezone: 'Etc/UTC',
          theme: 'dark',
          style: '1',
          locale: 'en',
          toolbar_bg: '#0a0a0a',
          enable_publishing: false,
          // Our ChartToolbar owns timeframe + view-mode; hide TV's redundant
          // top toolbar so the UI has a single source of truth.
          hide_top_toolbar: true,
          hide_legend: false,
          save_image: false,
          backgroundColor: '#0a0a0a',
          gridColor: '#1f1f1f',
          allow_symbol_change: false,
          details: false,
          hotlist: false,
          calendar: false,
        });
        widgetRef.current = widget;
        setPhase('ready');

        if (onChartReadyRef.current) {
          widget.onChartReady?.((chart) => onChartReadyRef.current?.(chart));
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Unknown error';
        setScriptError(message);
        setPhase('error');
        onErrorRef.current?.(message);
      });

    return () => {
      cancelled = true;
      const w = widgetRef.current;
      if (w?.remove) {
        try {
          w.remove();
        } catch {
          // Widget may already be torn down by parent.
        }
      }
      widgetRef.current = null;
    };
  }, [containerId, retryNonce]);

  // React to symbol/interval prop changes without re-mounting the widget.
  // On initial mount, widgetRef.current is null (script is still loading),
  // so this is a no-op; once the widget reports ready, the first
  // setSymbol/setResolution are applied here. After mount, every change to
  // the props pushes through to the active chart.
  useEffect(() => {
    const w = widgetRef.current;
    if (!w) return;
    w.onChartReady?.((chart) => {
      if (!chart) return;
      void chart.setResolution(interval);
      void chart.setSymbol(symbol);
    });
  }, [symbol, interval]);
  /* eslint-enable react-hooks/exhaustive-deps */

  return (
    <div
      className={className}
      data-testid="tradingview-widget"
      data-symbol={symbol}
      data-interval={interval}
    >
      {phase === 'loading' ? (
        <div
          data-testid="tradingview-loading"
          className="text-text-muted font-mono text-xs p-4"
        >
          Loading chart…
        </div>
      ) : null}
      {phase === 'error' && scriptError ? (
        <div
          data-testid="tradingview-error"
          className="text-warn font-mono text-xs p-4"
        >
          <div>{scriptError}</div>
          <button
            type="button"
            data-testid="tradingview-retry"
            className="mt-3 border border-border px-3 py-1 text-text"
            onClick={() => {
              resetTradingViewScriptLoader();
              setScriptError(null);
              setPhase('loading');
              setRetryNonce((n) => n + 1);
            }}
          >
            Retry
          </button>
        </div>
      ) : null}
      <div id={`tv-${containerId}`} style={{ height: 400, width: '100%' }} />
    </div>
  );
}

/** Drop a failed or in-flight tv.js load so Retry can fetch again. */
export function resetTradingViewScriptLoader(): void {
  tvScriptLoadingPromise = null;
  if (typeof document === 'undefined') return;
  document
    .querySelectorAll('script[data-tv-script="loaded"]')
    .forEach((el) => el.remove());
}

/** Test-only: reset the in-flight script loader. */
export function __resetTradingViewScriptLoader(): void {
  resetTradingViewScriptLoader();
}
