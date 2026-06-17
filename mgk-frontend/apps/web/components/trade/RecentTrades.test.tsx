import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { formatTradeTime, RecentTrades, type Trade } from './RecentTrades';

function trade(overrides: Partial<Trade> = {}): Trade {
  return {
    id: 't1',
    timestamp: Date.UTC(2026, 5, 17, 14, 30, 45),
    price: 150_500_000n,
    qty: 1_000_000n,
    side: 'buy',
    ...overrides,
  };
}

describe('RecentTrades', () => {
  it('renders the empty state when no trades are present', () => {
    render(<RecentTrades trades={[]} />);
    expect(screen.getByTestId('recent-trades-empty')).toHaveTextContent(
      /no trades yet/i,
    );
    expect(screen.queryByTestId('recent-trades-rows')).toBeNull();
  });

  it('renders the header row (Time / Price / Size / Side)', () => {
    render(<RecentTrades trades={[]} />);
    const header = screen.getByTestId('recent-trades-header');
    expect(header).toHaveTextContent(/time/i);
    expect(header).toHaveTextContent(/price/i);
    expect(header).toHaveTextContent(/size/i);
    expect(header).toHaveTextContent(/side/i);
  });

  it('renders one row per trade, in the order provided', () => {
    const trades = [
      trade({ id: 'a', side: 'buy' }),
      trade({ id: 'b', side: 'sell' }),
      trade({ id: 'c', side: 'buy' }),
    ];
    render(<RecentTrades trades={trades} />);
    const rows = within(screen.getByTestId('recent-trades-rows')).getAllByTestId(
      'recent-trades-row',
    );
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.getAttribute('data-side'))).toEqual([
      'buy',
      'sell',
      'buy',
    ]);
  });

  it('limits rendered rows to maxRows (3 of 5)', () => {
    const trades = [
      trade({ id: 'a' }),
      trade({ id: 'b' }),
      trade({ id: 'c' }),
      trade({ id: 'd' }),
      trade({ id: 'e' }),
    ];
    render(<RecentTrades trades={trades} maxRows={3} />);
    const ob = screen.getByTestId('recent-trades');
    expect(ob.getAttribute('data-count')).toBe('3');
    const rows = within(screen.getByTestId('recent-trades-rows')).getAllByTestId(
      'recent-trades-row',
    );
    expect(rows).toHaveLength(3);
  });

  it('flags the buy side with text-bull and the sell side with text-bear', () => {
    const trades = [trade({ id: 'a', side: 'buy' }), trade({ id: 'b', side: 'sell' })];
    render(<RecentTrades trades={trades} />);
    const rows = within(screen.getByTestId('recent-trades-rows')).getAllByTestId(
      'recent-trades-row',
    );
    const priceA = within(rows[0]!).getByTestId('recent-trades-price');
    const priceB = within(rows[1]!).getByTestId('recent-trades-price');
    expect(priceA.className).toContain('text-bull');
    expect(priceB.className).toContain('text-bear');
  });

  it('applies the className prop to the root', () => {
    const { container } = render(
      <RecentTrades trades={[]} className="custom-class" />,
    );
    expect(container.firstChild).toHaveClass('custom-class');
  });

  it('sets min-height of 22px per the Bulk.Trade row-height spec', () => {
    const trades = [trade({ id: 'a' })];
    render(<RecentTrades trades={trades} />);
    const row = screen.getByTestId('recent-trades-row');
    expect(row.style.minHeight).toBe('22px');
  });
});

describe('formatTradeTime', () => {
  it('formats a timestamp as HH:MM:SS in local time', () => {
    const ms = new Date(2026, 5, 17, 9, 5, 3).getTime();
    const out = formatTradeTime(ms);
    expect(out).toBe('09:05:03');
  });

  it('zero-pads single-digit hours, minutes, and seconds', () => {
    const ms = new Date(2026, 0, 1, 0, 0, 0).getTime();
    expect(formatTradeTime(ms)).toBe('00:00:00');
    const ms2 = new Date(2026, 0, 1, 1, 2, 3).getTime();
    expect(formatTradeTime(ms2)).toBe('01:02:03');
  });
});
