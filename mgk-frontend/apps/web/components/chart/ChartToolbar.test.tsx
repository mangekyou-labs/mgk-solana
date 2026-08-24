import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ChartToolbar } from './ChartToolbar';

describe('ChartToolbar', () => {
  const defaultProps = {
    resolution: '5m' as const,
    isConnected: true,
    onResolutionChange: () => {},
    onViewModeChange: () => {},
    viewMode: 'chart' as const,
  };

  // ── timeframe buttons ════════════════════════════════════════════

  it('renders all 6 timeframe buttons', () => {
    render(<ChartToolbar {...defaultProps} />);
    for (const tf of ['1m', '5m', '15m', '1h', '4h', '1d']) {
      expect(screen.getByTestId(`tf-${tf}`)).toBeDefined();
    }
  });

  it('marks the active resolution button', () => {
    render(<ChartToolbar {...defaultProps} resolution="1h" />);
    expect(screen.getByTestId('tf-1h').getAttribute('data-active')).toBe('true');
    expect(screen.getByTestId('tf-5m').getAttribute('data-active')).toBe('false');
  });

  // ── view mode buttons ════════════════════════════════════════════

  it('renders Chart | Market Info view mode buttons when onViewModeChange is provided', () => {
    render(<ChartToolbar {...defaultProps} />);
    expect(screen.getByTestId('vm-chart')).toBeDefined();
    expect(screen.getByTestId('vm-market-info')).toBeDefined();
  });

  it('does not render view mode buttons when onViewModeChange is omitted', () => {
    const { onViewModeChange: _, ...rest } = defaultProps; // eslint-disable-line @typescript-eslint/no-unused-vars
    render(<ChartToolbar {...rest} />);
    expect(screen.queryByTestId('vm-chart')).toBeNull();
    expect(screen.queryByTestId('vm-market-info')).toBeNull();
  });

  // ── WS status badge ══════════════════════════════════════════════

  it('shows ● live in green when connected', () => {
    render(<ChartToolbar {...defaultProps} isConnected />);
    const el = screen.getByTestId('chart-ws-status');
    expect(el.textContent).toContain('live');
    // The dot is a child span
    const dot = el.querySelector('span');
    expect(dot?.className).toContain('text-online');
  });

  it('shows ○ off in warn/orange when disconnected', () => {
    render(<ChartToolbar {...defaultProps} isConnected={false} />);
    const el = screen.getByTestId('chart-ws-status');
    expect(el.textContent).toContain('off');
    // "off" label uses warn color
    const spans = el.querySelectorAll('span');
    expect(spans.length).toBeGreaterThanOrEqual(2);
    // The dot should be in the offline color (red)
    expect(spans[0]?.className).toContain('text-offline');
    // The label should be in warn color (orange)
    expect(spans[1]?.className).toContain('text-warn');
  });

  // ── disabled buttons ═════════════════════════════════════════════

  it('renders disabled Indicators button', () => {
    render(<ChartToolbar {...defaultProps} />);
    const btn = screen.getByTestId('btn-indicators');
    expect(btn).toBeDefined();
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders disabled Mark/Oracle toggle buttons', () => {
    render(<ChartToolbar {...defaultProps} />);
    const mark = screen.getByTestId('toggle-mark');
    const oracle = screen.getByTestId('toggle-oracle');
    expect(mark).toBeDefined();
    expect(oracle).toBeDefined();
    expect((mark as HTMLButtonElement).disabled).toBe(true);
    expect((oracle as HTMLButtonElement).disabled).toBe(true);
  });

  // ── data-testid root ═════════════════════════════════════════════

  it('renders with chart-toolbar data-testid', () => {
    render(<ChartToolbar {...defaultProps} />);
    expect(screen.getByTestId('chart-toolbar')).toBeDefined();
  });
});
