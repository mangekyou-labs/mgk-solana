import { render, screen } from '@testing-library/react';

import { Logo } from './Logo';

describe('Logo', () => {
  it('renders the "mgk" wordmark', () => {
    render(<Logo />);
    expect(screen.getByTestId('mgk-wordmark')).toHaveTextContent('mgk');
  });

  it('renders the mangekyo mark as an inline SVG', () => {
    const { container } = render(<Logo />);
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
    expect(svg?.getAttribute('role')).toBe('img');
    expect(svg?.getAttribute('aria-label')).toBe('mgk');
  });

  it('scales the icon to the requested size', () => {
    const { container } = render(<Logo iconSize={32} />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('width', '32');
    expect(svg).toHaveAttribute('height', '32');
  });

  it('uses accent (Sharingan red) for the mark and wordmark', () => {
    const { container } = render(<Logo />);
    const accent = container.querySelector('[data-token="accent"]');
    expect(accent).toBeInTheDocument();
  });
});
