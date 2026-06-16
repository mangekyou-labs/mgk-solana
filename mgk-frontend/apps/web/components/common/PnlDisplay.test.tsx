import { render, screen } from '@testing-library/react';

import { PnlDisplay } from './PnlDisplay';

describe('PnlDisplay', () => {
  it('renders a positive value with green color and ▲ arrow (color + shape, not color alone)', () => {
    render(<PnlDisplay value={12.34} />);
    const el = screen.getByTestId('pnl-display');
    expect(el).toHaveAttribute('data-direction', 'bull');
    expect(el).toHaveTextContent('+');
    expect(el).toHaveTextContent('12.34');
    expect(el).toHaveTextContent('▲');
  });

  it('renders a negative value with red color and ▼ arrow', () => {
    render(<PnlDisplay value={-7.5} />);
    const el = screen.getByTestId('pnl-display');
    expect(el).toHaveAttribute('data-direction', 'bear');
    expect(el).toHaveTextContent('−');
    expect(el).toHaveTextContent('7.50');
    expect(el).toHaveTextContent('▼');
  });

  it('renders zero with a muted appearance and no arrow', () => {
    render(<PnlDisplay value={0} />);
    const el = screen.getByTestId('pnl-display');
    expect(el).toHaveAttribute('data-direction', 'flat');
    expect(el).toHaveTextContent('0.00');
    expect(el).not.toHaveTextContent('▲');
    expect(el).not.toHaveTextContent('▼');
  });
});
