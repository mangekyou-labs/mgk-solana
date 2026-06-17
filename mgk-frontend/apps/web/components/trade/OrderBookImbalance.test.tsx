import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { OrderBookImbalance } from './OrderBookImbalance';

describe('OrderBookImbalance', () => {
  it('returns null when both sizes are zero', () => {
    const { container } = render(
      <OrderBookImbalance totalBidSize={0n} totalAskSize={0n} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders B%/S% labels and progress bar when sizes are non-zero', () => {
    render(<OrderBookImbalance totalBidSize={600n} totalAskSize={400n} />);
    const imbal = screen.getByTestId('orderbook-imbalance');
    expect(imbal.getAttribute('data-bid-pct')).toBe('60');
    expect(imbal.getAttribute('data-ask-pct')).toBe('40');
    expect(screen.getByTestId('imbalance-bid-label')).toHaveTextContent('B 60%');
    expect(screen.getByTestId('imbalance-ask-label')).toHaveTextContent('S 40%');
  });

  it('shows 100% bid when ask size is zero', () => {
    render(<OrderBookImbalance totalBidSize={500n} totalAskSize={0n} />);
    const imbal = screen.getByTestId('orderbook-imbalance');
    expect(imbal.getAttribute('data-bid-pct')).toBe('100');
    expect(imbal.getAttribute('data-ask-pct')).toBe('0');
  });

  it('shows 100% ask when bid size is zero', () => {
    render(<OrderBookImbalance totalBidSize={0n} totalAskSize={300n} />);
    const imbal = screen.getByTestId('orderbook-imbalance');
    expect(imbal.getAttribute('data-bid-pct')).toBe('0');
    expect(imbal.getAttribute('data-ask-pct')).toBe('100');
  });

  it('applies className to the root', () => {
    render(
      <OrderBookImbalance
        totalBidSize={1n}
        totalAskSize={1n}
        className="custom-class"
      />,
    );
    expect(screen.getByTestId('orderbook-imbalance')).toHaveClass('custom-class');
  });

  it('handles integer division correctly (75% / 25%)', () => {
    render(<OrderBookImbalance totalBidSize={3n} totalAskSize={1n} />);
    const imbal = screen.getByTestId('orderbook-imbalance');
    // 3/4 = 75%, 1/4 = 25%
    expect(imbal.getAttribute('data-bid-pct')).toBe('75');
    expect(imbal.getAttribute('data-ask-pct')).toBe('25');
  });
});
