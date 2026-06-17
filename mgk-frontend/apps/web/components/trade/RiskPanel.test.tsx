import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RiskPanel } from './RiskPanel';

describe('RiskPanel', () => {
  it('shows Liq Price, Leverage, and Free Collateral labels', () => {
    render(
      <RiskPanel
        liqPrice={null}
        notional={0n}
        freeCollateral={0n}
      />,
    );
    expect(screen.getByTestId('risk-row-liq-price')).toBeInTheDocument();
    expect(screen.getByTestId('risk-row-leverage')).toBeInTheDocument();
    expect(screen.getByTestId('risk-row-free-collateral')).toBeInTheDocument();
  });

  it('shows "—" when liqPrice is null', () => {
    render(
      <RiskPanel
        liqPrice={null}
        notional={0n}
        freeCollateral={0n}
      />,
    );
    expect(screen.getByTestId('risk-row-liq-price')).toHaveTextContent('—');
  });

  it('shows a scaled USD liq price when provided', () => {
    render(
      <RiskPanel
        liqPrice={150_000_000n}
        notional={0n}
        freeCollateral={0n}
      />,
    );
    expect(screen.getByTestId('risk-row-liq-price')).not.toHaveTextContent('—');
    expect(screen.getByTestId('risk-row-liq-price')).toHaveTextContent('150.00');
  });

  it('computes leverage from notional / freeCollateral', () => {
    render(
      <RiskPanel
        liqPrice={null}
        notional={1_000_000_000n}
        freeCollateral={100_000_000_000n}
      />,
    );
    expect(screen.getByTestId('risk-row-leverage')).toHaveTextContent('0.0x');
  });

  it('shows "—" for leverage when no notional', () => {
    render(
      <RiskPanel
        liqPrice={null}
        notional={0n}
        freeCollateral={100_000_000_000n}
      />,
    );
    expect(screen.getByTestId('risk-row-leverage')).toHaveTextContent('—');
  });

  it('shows lamports as SOL', () => {
    render(
      <RiskPanel
        liqPrice={null}
        notional={0n}
        freeCollateral={1_000_000_000n}
      />,
    );
    expect(screen.getByTestId('risk-row-free-collateral')).toHaveTextContent('1');
  });

  it('shows "—" for all values when loading', () => {
    render(
      <RiskPanel
        liqPrice={150_000_000n}
        notional={1_000_000_000n}
        freeCollateral={1_000_000_000n}
        loading
      />,
    );
    expect(screen.getByTestId('risk-row-liq-price')).toHaveTextContent('—');
    expect(screen.getByTestId('risk-row-leverage')).toHaveTextContent('—');
    expect(screen.getByTestId('risk-row-free-collateral')).toHaveTextContent('—');
  });

  it('renders the container with test id', () => {
    render(
      <RiskPanel
        liqPrice={null}
        notional={0n}
        freeCollateral={0n}
      />,
    );
    expect(screen.getByTestId('order-form-risk-panel')).toBeInTheDocument();
  });
});
