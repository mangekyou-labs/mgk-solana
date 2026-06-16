import { render, screen } from '@testing-library/react';

import { StatusDot } from './StatusDot';

describe('StatusDot', () => {
  it('renders an online dot with a filled marker', () => {
    render(<StatusDot state="online" />);
    const dot = screen.getByTestId('status-dot');
    expect(dot).toHaveAttribute('data-state', 'online');
    expect(dot).toHaveTextContent('●');
  });

  it('renders an offline dot with a hollow marker (color + shape, not color alone)', () => {
    render(<StatusDot state="offline" />);
    const dot = screen.getByTestId('status-dot');
    expect(dot).toHaveAttribute('data-state', 'offline');
    expect(dot).toHaveTextContent('○');
  });

  it('renders a connecting dot with a pulsing animation class', () => {
    render(<StatusDot state="connecting" />);
    const dot = screen.getByTestId('status-dot');
    expect(dot).toHaveAttribute('data-state', 'connecting');
    expect(dot.className).toMatch(/animate-pulse/);
  });
});
