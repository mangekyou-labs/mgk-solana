import { PublicKey } from '@solana/web3.js';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import * as sdk from '@mgk/sdk';

import { Balances } from './Balances';

type PortfolioState = sdk.state.PortfolioState;

const USER_PK = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

function makePortfolio(overrides: Partial<PortfolioState> = {}): PortfolioState {
  return {
    user: USER_PK,
    equity: 1_500_000_000n,
    principal: 1_000_000_000n,
    pnl: 500_000_000n,
    im: 300_000_000n,
    mm: 200_000_000n,
    freeCollateral: 1_200_000_000n,
    health: 1_300_000_000n,
    positionsLen: 0,
    positions: [],
    lastFundingCheckpoint: new Array(32).fill(0n),
    lastBatchId: 0n,
    lastSlot: 0n,
    bump: 0,
    ...overrides,
  };
}

describe('Balances', () => {
  it('renders the empty state when data is null', () => {
    render(<Balances data={null} />);
    const root = screen.getByTestId('balances');
    expect(root).toHaveAttribute('data-state', 'empty');
    expect(screen.getByText(/No portfolio yet/)).toBeInTheDocument();
  });

  it('renders the loading state when loading=true', () => {
    render(<Balances data={null} loading />);
    const root = screen.getByTestId('balances');
    expect(root).toHaveAttribute('data-state', 'loading');
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('renders all five balance rows when data is present', () => {
    render(<Balances data={makePortfolio()} />);
    const root = screen.getByTestId('balances');
    expect(root).toHaveAttribute('data-state', 'ready');
    expect(screen.getByTestId('balances-equity')).toBeInTheDocument();
    expect(screen.getByTestId('balances-free')).toBeInTheDocument();
    expect(screen.getByTestId('balances-locked')).toBeInTheDocument();
    expect(screen.getByTestId('balances-pnl')).toBeInTheDocument();
    expect(screen.getByTestId('balances-mm')).toBeInTheDocument();
  });

  it('computes locked collateral as equity - freeCollateral', () => {
    // equity=1500, free=1200 → locked=300 (im)
    render(
      <Balances
        data={makePortfolio({ equity: 1_500_000_000n, freeCollateral: 1_200_000_000n })}
      />,
    );
    const locked = screen.getByTestId('balances-locked');
    // 300_000_000 lamports = 0.3000 SOL with 4 decimals
    expect(locked.textContent).toMatch(/0\.3000/);
  });

  it('displays equity in SOL with 4 decimals', () => {
    render(<Balances data={makePortfolio({ equity: 1_500_000_000n })} />);
    const equity = screen.getByTestId('balances-equity');
    // 1.5 SOL
    expect(equity.textContent).toMatch(/1\.5000/);
  });

  it('shows a positive PnL with the bull color + up arrow', () => {
    render(<Balances data={makePortfolio({ pnl: 500_000_000n })} />);
    const pnl = screen.getByTestId('balances-pnl').querySelector('[data-testid="pnl-display"]');
    expect(pnl).toHaveAttribute('data-direction', 'bull');
    expect(pnl?.textContent).toMatch(/▲/);
  });

  it('shows a negative PnL with the bear color + down arrow', () => {
    render(<Balances data={makePortfolio({ pnl: -500_000_000n })} />);
    const pnl = screen.getByTestId('balances-pnl').querySelector('[data-testid="pnl-display"]');
    expect(pnl).toHaveAttribute('data-direction', 'bear');
    expect(pnl?.textContent).toMatch(/▼/);
  });

  it('applies the optional className', () => {
    const { container } = render(<Balances data={null} className="custom-balances" />);
    expect(container.firstChild).toHaveClass('custom-balances');
  });
});
