declare global {
  interface Window {
    TradingView?: {
      readonly version?: string;
      widget: new (config: TradingViewWidgetConfig) => TradingViewWidgetInstance;
    };
  }
}

export interface TradingViewWidgetConfig {
  symbol?: string;
  interval?: string;
  container_id: string;
  autosize?: boolean;
  timezone?: string;
  theme?: 'light' | 'dark';
  style?: string;
  locale?: string;
  toolbar_bg?: string;
  enable_publishing?: boolean;
  hide_top_toolbar?: boolean;
  hide_legend?: boolean;
  save_image?: boolean;
  backgroundColor?: string;
  gridColor?: string;
  studies?: string[];
  width?: number | string;
  height?: number | string;
  withdateranges?: boolean;
  hide_side_toolbar?: boolean;
  allow_symbol_change?: boolean;
  details?: boolean;
  hotlist?: boolean;
  calendar?: boolean;
  watchlist?: string[];
}

export interface TradingViewWidgetInstance {
  onChartReady?: (cb: (chart: TradingViewChart) => void) => void;
  remove?: () => void;
  activeChart?: () => TradingViewChart | null;
}

export interface TradingViewChart {
  setResolution: (interval: string) => Promise<unknown>;
  setSymbol: (symbol: string) => Promise<unknown>;
  resolution: () => string;
  symbol: () => string;
}

export {};
