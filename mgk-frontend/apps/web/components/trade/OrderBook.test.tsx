import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import * as sdk from '@mgk/sdk';

import { OrderBook } from './OrderBook';

type BookLevel = sdk.state.BookLevel;

function level(
  price: bigint,
  totalQty: bigint,
  orderCount = 1,
): BookLevel {
  return { price, totalQty, orderCount, firstOrderOffset: 0 };
}

describe('OrderBook', () => {
  it('renders the empty state when no levels are present', () => {
    render(<OrderBook bids={[]} asks={[]} />);
    expect(screen.getByTestId('orderbook-empty')).toHaveTextContent(
      /no resting orders/i,
    );
  });

  it('renders asks in price-DESC order visually (best ask at the bottom)', () => {
    // Source: asks sorted ASC (best first): [100, 101, 102]
    // Display: top-to-bottom [102, 101, 100] → best at the bottom
    const asks = [level(100n, 1n), level(101n, 2n), level(102n, 3n)];
    render(<OrderBook bids={[]} asks={asks} />);
    const askRows = screen.getAllByTestId('depth-row');
    const askOnly = askRows.filter(
      (r) => r.getAttribute('data-side') === 'ask',
    );
    expect(askOnly.map((r) => r.getAttribute('data-index'))).toEqual([
      '2',
      '1',
      '0',
    ]);
  });

  it('renders bids in price-DESC order (best bid at the top)', () => {
    const bids = [level(99n, 5n), level(98n, 4n), level(97n, 3n)];
    render(<OrderBook bids={bids} asks={[]} />);
    const bidRows = screen
      .getAllByTestId('depth-row')
      .filter((r) => r.getAttribute('data-side') === 'bid');
    expect(bidRows.map((r) => r.getAttribute('data-index'))).toEqual([
      '0',
      '1',
      '2',
    ]);
  });

  it('computes cumulative size correctly (ask side)', () => {
    // Quantities in scaled-base (1e6 raw = 1 displayed). Cumulative
    // walks from best ask (asks[0]) outward: 1, 1+2=3, 1+2+3=6.
    const asks = [
      level(100n, 1_000_000n),
      level(101n, 2_000_000n),
      level(102n, 3_000_000n),
    ];
    render(<OrderBook bids={[]} asks={asks} />);
    const asksContainer = screen.getByTestId('orderbook-asks');
    const totals = within(asksContainer).getAllByTestId('depth-row-total');
    // Display order: [102/3, 101/2, 100/1] (top-to-bottom)
    // Cumulative displayed: [6, 3, 1]
    expect(totals[0]).toHaveTextContent('6');
    expect(totals[1]).toHaveTextContent('3');
    expect(totals[2]).toHaveTextContent('1');
  });

  it('computes cumulative size correctly (bid side)', () => {
    const bids = [
      level(99n, 5_000_000n),
      level(98n, 4_000_000n),
      level(97n, 3_000_000n),
    ];
    render(<OrderBook bids={bids} asks={[]} />);
    const bidsContainer = screen.getByTestId('orderbook-bids');
    const totals = within(bidsContainer).getAllByTestId('depth-row-total');
    // Display order: [99/5, 98/4, 97/3]
    // Cumulative: [5, 9, 12]
    expect(totals[0]).toHaveTextContent('5');
    expect(totals[1]).toHaveTextContent('9');
    expect(totals[2]).toHaveTextContent('12');
  });

  it('computes spread = bestAsk - bestBid and shows bps percentage', () => {
    const bids = [level(99n, 5n)];
    const asks = [level(101n, 3n)];
    render(<OrderBook bids={bids} asks={asks} />);
    const spread = screen.getByTestId('orderbook-spread');
    expect(spread.getAttribute('data-spread')).toBe('2');
    // 2 / 99 * 100 ≈ 2.0202 → 2.02%
    expect(spread.getAttribute('data-spread-bps')).toBe('2.02');
  });

  it('hides the spread row when one side is empty', () => {
    const { container } = render(<OrderBook bids={[level(99n, 5n)]} asks={[]} />);
    expect(container.querySelector('[data-testid="orderbook-spread"]')).toBeNull();
  });

  it('sets bar width proportional to size relative to max size in the book', () => {
    const bids = [level(99n, 1n), level(98n, 4n), level(97n, 2n)]; // max=4
    const asks = [level(101n, 1n)];
    render(<OrderBook bids={bids} asks={asks} />);
    const bidRow = screen
      .getAllByTestId('depth-row')
      .find(
        (r) =>
          r.getAttribute('data-side') === 'bid' &&
          r.getAttribute('data-index') === '0',
      );
    // 1n / 4n = 25%
    const bar = bidRow?.querySelector('[aria-hidden]') as HTMLElement | null;
    expect(bar?.style.width).toBe('25%');
  });

  it('applies the className prop to the root', () => {
    const { container } = render(
      <OrderBook bids={[level(99n, 1n)]} asks={[level(101n, 1n)]} className="custom-class" />,
    );
    expect(container.firstChild).toHaveClass('custom-class');
  });

  it('flags data-has-bids / data-has-asks for styling hooks', () => {
    render(<OrderBook bids={[level(99n, 1n)]} asks={[]} />);
    const ob = screen.getByTestId('orderbook');
    expect(ob.getAttribute('data-has-bids')).toBe('true');
    expect(ob.getAttribute('data-has-asks')).toBe('false');
  });

  it('renders the imbalance bar with correct B%/S% totals', () => {
    const bids = [level(99n, 7n), level(98n, 3n)];
    const asks = [level(101n, 5n), level(102n, 5n)];
    render(<OrderBook bids={bids} asks={asks} />);
    const imbal = screen.getByTestId('orderbook-imbalance');
    // totalBid=10, totalAsk=10 → 50%/50%
    expect(imbal.getAttribute('data-bid-pct')).toBe('50');
    expect(imbal.getAttribute('data-ask-pct')).toBe('50');
    expect(screen.getByTestId('imbalance-bid-label')).toHaveTextContent('B 50%');
    expect(screen.getByTestId('imbalance-ask-label')).toHaveTextContent('S 50%');
  });

  it('computes imbalance ratios for uneven sides', () => {
    const bids = [level(99n, 60n)];
    const asks = [level(101n, 40n)];
    render(<OrderBook bids={bids} asks={asks} />);
    const imbal = screen.getByTestId('orderbook-imbalance');
    expect(imbal.getAttribute('data-bid-pct')).toBe('60');
    expect(imbal.getAttribute('data-ask-pct')).toBe('40');
  });

  it('shows 100% bid when no asks are present', () => {
    render(<OrderBook bids={[level(99n, 5n)]} asks={[]} />);
    const imbal = screen.getByTestId('orderbook-imbalance');
    expect(imbal.getAttribute('data-bid-pct')).toBe('100');
    expect(imbal.getAttribute('data-ask-pct')).toBe('0');
  });
});
