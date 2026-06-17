import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';

import {
  TradingViewWidget,
  __resetTradingViewScriptLoader,
} from './TradingViewWidget';
import type { TradingViewWidgetInstance, TradingViewChart } from '@/global';

interface MockChart {
  setResolution: ReturnType<typeof vi.fn>;
  setSymbol: ReturnType<typeof vi.fn>;
  resolution: ReturnType<typeof vi.fn>;
  symbol: ReturnType<typeof vi.fn>;
}

interface InstallResult {
  widgetCtor: ReturnType<typeof vi.fn>;
  widgetInstances: TradingViewWidgetInstance[];
  removeSpy: ReturnType<typeof vi.fn>;
  onChartReadySpy: ReturnType<typeof vi.fn>;
  chart: MockChart;
}

function installMockTradingView(): InstallResult {
  const widgetInstances: TradingViewWidgetInstance[] = [];
  const chart: MockChart = {
    setResolution: vi.fn().mockResolvedValue(undefined),
    setSymbol: vi.fn().mockResolvedValue(undefined),
    resolution: vi.fn().mockReturnValue('5'),
    symbol: vi.fn().mockReturnValue('BINANCE:SOLUSDT'),
  };
  const onChartReadySpy = vi.fn((cb: (chart: TradingViewChart) => void) => {
    cb(chart as unknown as TradingViewChart);
  });
  const removeSpy = vi.fn();

  const widgetCtor = vi.fn(() => {
    const instance: TradingViewWidgetInstance = {
      onChartReady: onChartReadySpy as TradingViewWidgetInstance['onChartReady'],
      remove: removeSpy,
      activeChart: () => chart as unknown as TradingViewChart,
    };
    widgetInstances.push(instance);
    return instance;
  });

  Object.defineProperty(window, 'TradingView', {
    value: { widget: widgetCtor },
    writable: true,
    configurable: true,
  });

  return { widgetCtor, widgetInstances, removeSpy, onChartReadySpy, chart };
}

async function flushMicrotasks() {
  // React effects + Promise microtasks must settle before assertions.
  await act(async () => {
    await Promise.resolve();
  });
}

describe('TradingViewWidget', () => {
  beforeEach(() => {
    __resetTradingViewScriptLoader();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    Object.defineProperty(window, 'TradingView', {
      value: undefined,
      writable: true,
      configurable: true,
    });
  });

  it('renders a container with the widget testid', async () => {
    installMockTradingView();
    const { getByTestId } = render(<TradingViewWidget />);
    await flushMicrotasks();
    const el = getByTestId('tradingview-widget');
    expect(el).toBeInTheDocument();
    expect(el.dataset.symbol).toBe('BINANCE:SOLUSDT');
    expect(el.dataset.interval).toBe('5');
  });

  it('uses custom symbol and interval when provided', async () => {
    const { widgetCtor } = installMockTradingView();
    render(<TradingViewWidget symbol="BINANCE:ETHUSDT" interval="60" />);
    await flushMicrotasks();
    expect(widgetCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'BINANCE:ETHUSDT',
        interval: '60',
      }),
    );
  });

  it('configures the dark theme with Sharingan-adjacent bg and grid colors', async () => {
    const { widgetCtor } = installMockTradingView();
    render(<TradingViewWidget />);
    await flushMicrotasks();
    expect(widgetCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        theme: 'dark',
        backgroundColor: '#0a0a0a',
        gridColor: '#1f1f1f',
        toolbar_bg: '#0a0a0a',
        hide_top_toolbar: true,
      }),
    );
  });

  it('invokes onChartReady with the active chart when the widget reports ready', async () => {
    const { chart, onChartReadySpy } = installMockTradingView();
    const onReady = vi.fn();
    render(<TradingViewWidget onChartReady={onReady} />);
    await waitFor(() => expect(onChartReadySpy).toHaveBeenCalledTimes(1));
    expect(onReady).toHaveBeenCalledWith(chart);
  });

  it('cleans up the widget instance on unmount', async () => {
    const { removeSpy } = installMockTradingView();
    const { unmount } = render(<TradingViewWidget />);
    await flushMicrotasks();
    expect(removeSpy).not.toHaveBeenCalled();
    unmount();
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  it('does not throw when remove() throws (widget already torn down)', async () => {
    const { removeSpy } = installMockTradingView();
    removeSpy.mockImplementation(() => {
      throw new Error('already removed');
    });
    const { unmount } = render(<TradingViewWidget />);
    await flushMicrotasks();
    expect(() => unmount()).not.toThrow();
  });

  it('does not re-create the widget on symbol or interval prop changes', async () => {
    const { widgetCtor } = installMockTradingView();
    const { rerender } = render(<TradingViewWidget symbol="BINANCE:SOLUSDT" interval="5" />);
    await flushMicrotasks();
    expect(widgetCtor).toHaveBeenCalledTimes(1);
    rerender(<TradingViewWidget symbol="BINANCE:SOLUSDT" interval="15" />);
    rerender(<TradingViewWidget symbol="BINANCE:ETHUSDT" interval="60" />);
    await flushMicrotasks();
    expect(widgetCtor).toHaveBeenCalledTimes(1);
  });

  it('applies symbol/interval changes via the active chart after ready', async () => {
    const { chart } = installMockTradingView();
    const { rerender } = render(<TradingViewWidget symbol="BINANCE:SOLUSDT" interval="5" />);
    await flushMicrotasks();
    // On initial mount, the widget is constructed with these values;
    // setSymbol/setResolution are only called on subsequent prop changes.
    expect(chart.setSymbol).not.toHaveBeenCalled();
    expect(chart.setResolution).not.toHaveBeenCalled();

    rerender(<TradingViewWidget symbol="BINANCE:SOLUSDT" interval="15" />);
    await waitFor(() => expect(chart.setResolution).toHaveBeenLastCalledWith('15'));

    rerender(<TradingViewWidget symbol="BINANCE:ETHUSDT" interval="60" />);
    await waitFor(() => expect(chart.setSymbol).toHaveBeenLastCalledWith('BINANCE:ETHUSDT'));
    await waitFor(() => expect(chart.setResolution).toHaveBeenLastCalledWith('60'));
  });
});
