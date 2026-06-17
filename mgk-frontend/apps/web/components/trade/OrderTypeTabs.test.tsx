import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OrderTypeTabs } from './OrderTypeTabs';

describe('OrderTypeTabs', () => {
  it('renders the Limit tab as active', () => {
    render(<OrderTypeTabs mode="limit" />);
    const el = screen.getByTestId('order-type-limit');
    expect(el).toBeInTheDocument();
    expect(el.dataset.active).toBe('true');
    expect(el).toHaveTextContent('Limit');
  });

  it('sets data-mode on the container', () => {
    render(<OrderTypeTabs mode="limit" />);
    expect(screen.getByTestId('order-type-tabs').dataset.mode).toBe('limit');
  });

  it('accepts a className', () => {
    const { container } = render(
      <OrderTypeTabs mode="limit" className="my-custom" />,
    );
    expect(container.firstChild).toHaveClass('my-custom');
  });
});
