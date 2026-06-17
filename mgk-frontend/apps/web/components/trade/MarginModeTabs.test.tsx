import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MarginModeTabs } from './MarginModeTabs';

describe('MarginModeTabs', () => {
  it('renders the Cross tab as active', () => {
    render(<MarginModeTabs mode="cross" />);
    const el = screen.getByTestId('margin-mode-cross');
    expect(el).toBeInTheDocument();
    expect(el.dataset.active).toBe('true');
    expect(el).toHaveTextContent('Cross');
  });

  it('sets data-mode on the container', () => {
    render(<MarginModeTabs mode="cross" />);
    expect(screen.getByTestId('margin-mode-tabs').dataset.mode).toBe('cross');
  });

  it('accepts a className', () => {
    const { container } = render(
      <MarginModeTabs mode="cross" className="my-custom" />,
    );
    expect(container.firstChild).toHaveClass('my-custom');
  });
});
