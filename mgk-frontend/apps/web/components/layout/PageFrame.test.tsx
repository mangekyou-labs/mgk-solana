import { render, screen } from '@testing-library/react';

import { PageFrame } from './PageFrame';

describe('PageFrame', () => {
  it('renders its children', () => {
    render(
      <PageFrame>
        <span data-testid="child">child</span>
      </PageFrame>,
    );
    expect(screen.getByTestId('child')).toBeInTheDocument();
  });

  it('constrains content to a max-width container', () => {
    render(<PageFrame>content</PageFrame>);
    const frame = screen.getByTestId('page-frame');
    expect(frame.className).toMatch(/max-w-/);
  });

  it('uses the bg-surface background token (dark surface)', () => {
    render(<PageFrame>content</PageFrame>);
    const frame = screen.getByTestId('page-frame');
    expect(frame.className).toMatch(/bg-bg|bg-surface/);
  });

  it('contains vertical scroll to itself (not the window)', () => {
    render(<PageFrame>content</PageFrame>);
    const frame = screen.getByTestId('page-frame');
    expect(frame.className).toMatch(/overflow-y-auto/);
  });
});
