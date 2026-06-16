import { render, screen } from '@testing-library/react';

import { Pill } from './Pill';

describe('Pill', () => {
  it('renders its children as the label', () => {
    render(<Pill tone="warn">Devnet</Pill>);
    expect(screen.getByText('Devnet')).toBeInTheDocument();
  });

  it('exposes a data-tone attribute for tone styling', () => {
    render(<Pill tone="info">Committing</Pill>);
    expect(screen.getByTestId('pill')).toHaveAttribute('data-tone', 'info');
  });

  it('defaults to a neutral tone when none is provided', () => {
    render(<Pill>Default</Pill>);
    expect(screen.getByTestId('pill')).toHaveAttribute('data-tone', 'neutral');
  });

  it('renders a rounded pill shape', () => {
    render(<Pill tone="bear">Short</Pill>);
    const pill = screen.getByTestId('pill');
    expect(pill.className).toMatch(/rounded-full/);
  });
});
