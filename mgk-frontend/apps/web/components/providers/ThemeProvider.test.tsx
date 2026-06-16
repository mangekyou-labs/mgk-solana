import { render, screen } from '@testing-library/react';

import { ThemeProvider } from './ThemeProvider';

describe('ThemeProvider', () => {
  it('renders its children', () => {
    render(
      <ThemeProvider>
        <span data-testid="child">child</span>
      </ThemeProvider>,
    );

    expect(screen.getByTestId('child')).toBeInTheDocument();
  });

  it('sets data-theme="dark" on its wrapper element', () => {
    render(
      <ThemeProvider>
        <span>child</span>
      </ThemeProvider>,
    );

    const wrapper = screen.getByTestId('theme-provider-root');
    expect(wrapper).toHaveAttribute('data-theme', 'dark');
  });

  it('applies a class so globals.css can target the theme root', () => {
    render(
      <ThemeProvider>
        <span>child</span>
      </ThemeProvider>,
    );

    const wrapper = screen.getByTestId('theme-provider-root');
    expect(wrapper).toHaveClass('mgk-theme-root');
  });
});
