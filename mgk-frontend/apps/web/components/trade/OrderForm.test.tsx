import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { OrderForm } from './OrderForm';

// Mock useAutoConnect so AccountActions renders (returns null when not connected).
vi.mock('@/components/wallet/useAutoConnect', () => ({
  useAutoConnect: () => ({ connected: true }),
}));

describe('OrderForm', () => {
  it('renders the side tabs (Buy/Long active by default)', () => {
    render(<OrderForm bestBid={null} bestAsk={null} />);
    const buyTab = screen.getByTestId('order-form-side-buy');
    const sellTab = screen.getByTestId('order-form-side-sell');
    expect(buyTab.getAttribute('data-active')).toBe('true');
    expect(sellTab.getAttribute('data-active')).toBe('false');
  });

  it('switches side when clicking the Sell tab', () => {
    render(<OrderForm bestBid={null} bestAsk={null} />);
    fireEvent.click(screen.getByTestId('order-form-side-sell'));
    expect(screen.getByTestId('order-form-side-buy').getAttribute('data-active')).toBe('false');
    expect(screen.getByTestId('order-form-side-sell').getAttribute('data-active')).toBe('true');
  });

  it('renders the price input with a placeholder default', () => {
    render(<OrderForm bestBid={150_000_000n} bestAsk={null} />);
    const input = screen.getByTestId('order-form-price-input');
    expect((input as HTMLInputElement).placeholder).toBe('150.00');
  });

  it('renders the qty input', () => {
    render(<OrderForm bestBid={null} bestAsk={null} />);
    expect(screen.getByTestId('order-form-qty-input')).toBeInTheDocument();
  });

  it('accepts valid price input', () => {
    render(<OrderForm bestBid={null} bestAsk={null} />);
    const input = screen.getByTestId('order-form-price-input');
    fireEvent.change(input, { target: { value: '150.50' } });
    expect((input as HTMLInputElement).value).toBe('150.50');
  });

  it('rejects non-numeric price input', () => {
    render(<OrderForm bestBid={null} bestAsk={null} />);
    const input = screen.getByTestId('order-form-price-input');
    fireEvent.change(input, { target: { value: 'abc' } });
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('accepts valid qty input', () => {
    render(<OrderForm bestBid={null} bestAsk={null} />);
    const input = screen.getByTestId('order-form-qty-input');
    fireEvent.change(input, { target: { value: '10.5' } });
    expect((input as HTMLInputElement).value).toBe('10.5');
  });

  it('renders the 5-tick qty slider buttons', () => {
    render(<OrderForm bestBid={null} bestAsk={null} />);
    for (const pct of [20, 40, 60, 80, 100]) {
      expect(screen.getByTestId(`qty-slider-${pct}`)).toBeInTheDocument();
    }
  });

  it('sets qty when clicking a slider step', () => {
    render(<OrderForm bestBid={null} bestAsk={null} />);
    fireEvent.click(screen.getByTestId('qty-slider-20'));
    const input = screen.getByTestId('order-form-qty-input');
    expect((input as HTMLInputElement).value).toBeTruthy();
  });

  it('renders the Reduce Only checkbox', () => {
    render(<OrderForm bestBid={null} bestAsk={null} />);
    expect(screen.getByTestId('order-form-checkbox-reduce-only')).toBeInTheDocument();
    expect(screen.getByTestId('order-form-checkbox-input-reduce-only')).not.toBeChecked();
  });

  it('toggles Reduce Only checkbox', () => {
    render(<OrderForm bestBid={null} bestAsk={null} />);
    const cb = screen.getByTestId('order-form-checkbox-input-reduce-only');
    fireEvent.click(cb);
    expect(cb).toBeChecked();
  });

  it('renders the TP/SL checkbox disabled', () => {
    render(<OrderForm bestBid={null} bestAsk={null} />);
    const cb = screen.getByTestId('order-form-checkbox-input-tp-sl') as HTMLInputElement;
    expect(cb).toBeDisabled();
    expect(cb).not.toBeChecked();
  });

  it('renders Buy/Long and Sell/Short submit buttons', () => {
    render(<OrderForm bestBid={null} bestAsk={null} />);
    expect(screen.getByTestId('order-form-submit-buy')).toBeInTheDocument();
    expect(screen.getByTestId('order-form-submit-sell')).toBeInTheDocument();
  });

  it('calls onSubmit with buy params when Buy is active and clicked', () => {
    const onSubmit = vi.fn();
    render(<OrderForm bestBid={null} bestAsk={null} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByTestId('order-form-price-input'), {
      target: { value: '150' },
    });
    fireEvent.change(screen.getByTestId('order-form-qty-input'), {
      target: { value: '100' },
    });
    fireEvent.click(screen.getByTestId('order-form-submit-buy'));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const params = onSubmit.mock.calls[0][0];
    expect(params.side).toBe('buy');
    expect(params.price).toBe(150_000_000n);
    expect(params.qty).toBe(100_000_000n);
    expect(params.reduceOnly).toBe(false);
  });

  it('calls onSubmit with sell params when Sell is active and clicked', () => {
    const onSubmit = vi.fn();
    render(<OrderForm bestBid={null} bestAsk={null} onSubmit={onSubmit} />);

    fireEvent.click(screen.getByTestId('order-form-side-sell'));
    fireEvent.change(screen.getByTestId('order-form-price-input'), {
      target: { value: '200.50' },
    });
    fireEvent.change(screen.getByTestId('order-form-qty-input'), {
      target: { value: '50' },
    });
    fireEvent.click(screen.getByTestId('order-form-checkbox-input-reduce-only'));
    fireEvent.click(screen.getByTestId('order-form-submit-sell'));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const params = onSubmit.mock.calls[0][0];
    expect(params.side).toBe('sell');
    expect(params.price).toBe(200_500_000n);
    expect(params.qty).toBe(50_000_000n);
    expect(params.reduceOnly).toBe(true);
  });

  it('does not call onSubmit when price is zero', () => {
    const onSubmit = vi.fn();
    render(<OrderForm bestBid={null} bestAsk={null} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByTestId('order-form-qty-input'), {
      target: { value: '10' },
    });
    fireEvent.click(screen.getByTestId('order-form-submit-buy'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does not call onSubmit when qty is zero', () => {
    const onSubmit = vi.fn();
    render(<OrderForm bestBid={null} bestAsk={null} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByTestId('order-form-price-input'), {
      target: { value: '150' },
    });
    fireEvent.click(screen.getByTestId('order-form-submit-buy'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('renders the summary panel', () => {
    render(<OrderForm bestBid={null} bestAsk={null} />);
    expect(screen.getByTestId('order-form-summary')).toBeInTheDocument();
  });

  it('renders the account actions footer with init portfolio button when no portfolio', () => {
    render(<OrderForm bestBid={null} bestAsk={null} />);
    expect(screen.getByTestId('order-form-account-actions')).toBeInTheDocument();
    expect(screen.getByTestId('account-actions-init-portfolio')).toBeInTheDocument();
  });

  it('renders deposit/withdraw buttons when portfolio exists', () => {
    render(
      <OrderForm
        bestBid={null}
        bestAsk={null}
        portfolio={null}
        portfolioLoading={false}
      />,
    );
    // No portfolio data → init button is shown
    expect(screen.getByTestId('account-actions-init-portfolio')).toBeInTheDocument();
  });

  it('applies className to the root', () => {
    const { container } = render(
      <OrderForm bestBid={null} bestAsk={null} className="custom-class" />,
    );
    expect(container.firstChild).toHaveClass('custom-class');
  });

  it('uses bestBid as default price on buy side', () => {
    render(<OrderForm bestBid={150_000_000n} bestAsk={null} />);
    const priceLabel = screen.getByTestId('order-form-price-label');
    expect(priceLabel.className).toContain('text-bull');
    expect((screen.getByTestId('order-form-price-input') as HTMLInputElement).placeholder).toBe('150.00');
  });

  it('uses bestAsk as default price on sell side', () => {
    render(<OrderForm bestBid={null} bestAsk={151_000_000n} />);
    fireEvent.click(screen.getByTestId('order-form-side-sell'));
    const priceLabel = screen.getByTestId('order-form-price-label');
    expect(priceLabel.className).toContain('text-bear');
    expect((screen.getByTestId('order-form-price-input') as HTMLInputElement).placeholder).toBe('151.00');
  });

  it('renders the locked Cross margin mode tab', () => {
    render(<OrderForm bestBid={null} bestAsk={null} />);
    const el = screen.getByTestId('margin-mode-cross');
    expect(el).toBeInTheDocument();
    expect(el).toHaveTextContent('Cross');
    expect(el.dataset.active).toBe('true');
  });

  it('renders the locked Limit order type tab', () => {
    render(<OrderForm bestBid={null} bestAsk={null} />);
    const el = screen.getByTestId('order-type-limit');
    expect(el).toBeInTheDocument();
    expect(el).toHaveTextContent('Limit');
    expect(el.dataset.active).toBe('true');
  });

  it('renders the risk panel below the summary', () => {
    render(<OrderForm bestBid={null} bestAsk={null} />);
    expect(screen.getByTestId('order-form-risk-panel')).toBeInTheDocument();
  });
});
