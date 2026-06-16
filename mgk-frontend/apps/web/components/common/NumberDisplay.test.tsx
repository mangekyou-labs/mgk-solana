import { render, screen } from '@testing-library/react';

import { NumberDisplay } from './NumberDisplay';

describe('NumberDisplay', () => {
  it('renders a plain number with tabular-nums font', () => {
    render(<NumberDisplay value={1234.56} />);
    const el = screen.getByTestId('number-display');
    expect(el).toHaveTextContent('1,234.56');
    expect(el.className).toMatch(/tabular-nums|font-mono/);
  });

  it('converts lamports (1e9 scale) to SOL by default', () => {
    render(<NumberDisplay value={1_500_000_000} kind="lamports" />);
    expect(screen.getByTestId('number-display')).toHaveTextContent('1.5');
  });

  it('converts scaled prices (1e6 scale) to USD by default', () => {
    render(<NumberDisplay value={150_400_000} kind="scaled-usd" />);
    expect(screen.getByTestId('number-display')).toHaveTextContent('150.40');
  });

  it('honors an explicit decimal override', () => {
    render(<NumberDisplay value={150.4} decimals={4} />);
    expect(screen.getByTestId('number-display')).toHaveTextContent('150.4000');
  });

  it('renders zero as a muted value', () => {
    render(<NumberDisplay value={0} />);
    const el = screen.getByTestId('number-display');
    expect(el).toHaveTextContent('0');
    expect(el).toHaveAttribute('data-muted', 'true');
  });
});
