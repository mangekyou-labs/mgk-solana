import { PublicKey } from '@solana/web3.js';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import * as sdk from '@mgk/sdk';

import { Positions, computeLiqPrice } from './Positions';

type PortfolioState = sdk.state.PortfolioState;
type Position = sdk.state.Position;

const USER_PK = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    instrumentId: 1,
    qty: 0n,
    entryVwap: 0n,
    ...overrides,
  };
}

function makePortfolio(positions: Position[], overrides: Partial<PortfolioState> = {}): PortfolioState {
  const padded: Position[] = [
    ...positions,
    ...Array.from({ length: 32 - positions.length }, () => makePosition()),
  ];
  return {
    user: USER_PK,
    equity: 1_500_000_000n,
    principal: 1_000_000_000n,
    pnl: 500_000_000n,
    im: 300_000_000n,
    mm: 200_000_000n,
    freeCollateral: 1_200_000_000n,
    health: 1_300_000_000n,
    positionsLen: positions.length,
    positions: padded,
    lastFundingCheckpoint: new Array(32).fill(0n),
    lastBatchId: 0n,
    lastSlot: 0n,
    bump: 0,
    ...overrides,
  };
}

describe('computeLiqPrice', () => {
  it('returns null for a flat (zero qty) position', () => {
    expect(computeLiqPrice(0n, 50_000_000n, 1_000_000_000n, 200_000_000n)).toBeNull();
  });

  it('long: liq below entry when mm < principal (room above mm)', () => {
    // qty=1000 base units, entry=50_000_000 lamports/base, principal=1 SOL, mm=0.2 SOL
    // delta = 0.2 - 1.0 = -0.8 SOL = -800_000_000 lamports
    // price_change = -800_000_000 / 1000 = -800_000
    // liq = 50_000_000 - 800_000 = 49_200_000
    const liq = computeLiqPrice(1000n, 50_000_000n, 1_000_000_000n, 200_000_000n);
    expect(liq).toBe(49_200_000n);
  });

  it('short: liq above entry (negative qty reverses the sign)', () => {
    // qty=-1000 (short 1000 base units), entry=50_000_000, principal=1 SOL, mm=0.2 SOL
    // delta = -800_000_000
    // price_change = -800_000_000 / -1000 = +800_000
    // liq = 50_000_000 + 800_000 = 50_800_000
    const liq = computeLiqPrice(-1000n, 50_000_000n, 1_000_000_000n, 200_000_000n);
    expect(liq).toBe(50_800_000n);
  });

  it('returns a value at or above entry for a short, below for a long', () => {
    const long = computeLiqPrice(1000n, 50_000_000n, 1_000_000_000n, 300_000_000n);
    const short = computeLiqPrice(-1000n, 50_000_000n, 1_000_000_000n, 300_000_000n);
    expect(long!).toBeLessThan(50_000_000n);
    expect(short!).toBeGreaterThan(50_000_000n);
  });
});

describe('Positions', () => {
  it('renders the empty state when data is null', () => {
    render(<Positions data={null} />);
    const root = screen.getByTestId('positions');
    expect(root).toHaveAttribute('data-state', 'empty');
    expect(screen.getByText(/no open positions/i)).toBeInTheDocument();
  });

  it('renders the empty state when positionsLen is 0', () => {
    render(<Positions data={makePortfolio([])} />);
    expect(screen.getByTestId('positions')).toHaveAttribute('data-state', 'empty');
  });

  it('renders the loading state when loading=true', () => {
    render(<Positions data={null} loading />);
    expect(screen.getByTestId('positions')).toHaveAttribute('data-state', 'loading');
  });

  it('keeps existing rows visible while a background refresh is loading', () => {
    const p = makePortfolio([
      makePosition({ instrumentId: 1, qty: 1000n, entryVwap: 50_000_000n }),
    ]);
    render(<Positions data={p} loading />);
    const root = screen.getByTestId('positions');
    expect(root).toHaveAttribute('data-state', 'ready');
    expect(root).toHaveAttribute('data-refreshing', 'true');
    expect(screen.getByTestId('position-row')).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });

  it('renders a row per position', () => {
    const p = makePortfolio([
      makePosition({ instrumentId: 1, qty: 1000n, entryVwap: 50_000_000n }),
      makePosition({ instrumentId: 2, qty: -500n, entryVwap: 3_000_000_000n }),
    ]);
    render(<Positions data={p} />);
    const rows = screen.getAllByTestId('position-row');
    expect(rows).toHaveLength(2);
    expect(screen.getByTestId('positions-count')).toHaveTextContent('2');
  });

  it('marks long positions with the Long pill + bull tone', () => {
    const p = makePortfolio([
      makePosition({ instrumentId: 1, qty: 1000n, entryVwap: 50_000_000n }),
    ]);
    render(<Positions data={p} />);
    const row = screen.getByTestId('position-row');
    expect(row).toHaveAttribute('data-side', 'long');
    const pill = row.querySelector('[data-testid="pill"]');
    expect(pill).toHaveTextContent(/long/i);
    expect(pill).toHaveAttribute('data-tone', 'bull');
  });

  it('marks short positions with the Short pill + bear tone', () => {
    const p = makePortfolio([
      makePosition({ instrumentId: 1, qty: -1000n, entryVwap: 50_000_000n }),
    ]);
    render(<Positions data={p} />);
    const row = screen.getByTestId('position-row');
    expect(row).toHaveAttribute('data-side', 'short');
    const pill = row.querySelector('[data-testid="pill"]');
    expect(pill).toHaveTextContent(/short/i);
    expect(pill).toHaveAttribute('data-tone', 'bear');
  });

  it('hides PnL when no mark price is supplied (shows "—")', () => {
    const p = makePortfolio([
      makePosition({ instrumentId: 1, qty: 1000n, entryVwap: 50_000_000n }),
    ]);
    render(<Positions data={p} />);
    const pnlCell = screen.getByTestId('position-pnl');
    expect(pnlCell.textContent).toContain('—');
  });

  it('shows the computed PnL when a mark price is supplied', () => {
    // long 1000 base units @ entry 50_000_000, mark 60_000_000
    // pnl_lamports = 1000 * (60_000_000 - 50_000_000) = 1e10
    // → display 10.0000 SOL
    const p = makePortfolio([
      makePosition({ instrumentId: 1, qty: 1000n, entryVwap: 50_000_000n }),
    ]);
    const marks = { 1: 60_000_000n };
    render(<Positions data={p} markPrices={marks} />);
    const pnlCell = screen.getByTestId('position-pnl');
    expect(pnlCell.textContent).toMatch(/10\.0000/);
  });

  it('shows a negative PnL when mark < entry for a long', () => {
    // long 1000 base units @ entry 50_000_000, mark 40_000_000
    // pnl_lamports = 1000 * (40_000_000 - 50_000_000) = -1e10
    // → display −10.0000 SOL
    const p = makePortfolio([
      makePosition({ instrumentId: 1, qty: 1000n, entryVwap: 50_000_000n }),
    ]);
    const marks = { 1: 40_000_000n };
    render(<Positions data={p} markPrices={marks} />);
    const pnlCell = screen.getByTestId('position-pnl');
    expect(pnlCell.textContent).toMatch(/-10\.0000/);
  });

  it('displays "n/a" when the computed liq price is negative', () => {
    // Use qty=1 so the per-unit loss exceeds the entry: liq = 50M - 100M = -50M
    const p = makePortfolio(
      [makePosition({ instrumentId: 1, qty: 1n, entryVwap: 50_000_000n })],
      { principal: 100_000_000n, mm: 0n },
    );
    render(<Positions data={p} />);
    const liqCell = screen.getByTestId('position-liq');
    expect(liqCell.textContent).toMatch(/n\/a/);
  });

  it('displays a positive liq price when computed value is positive', () => {
    // principal=0.2 SOL, mm=0.3 SOL, qty=1000, entry=50_000_000
    // delta = 0.1 SOL = 100_000_000
    // price_change = 100_000_000 / 1000 = 100_000
    // liq = 50_100_000 → display "50.10"
    const p = makePortfolio(
      [makePosition({ instrumentId: 1, qty: 1000n, entryVwap: 50_000_000n })],
      { principal: 200_000_000n, mm: 300_000_000n },
    );
    render(<Positions data={p} />);
    const liqCell = screen.getByTestId('position-liq');
    expect(liqCell.textContent).toMatch(/50\.10/);
  });

  it('applies the optional className', () => {
    const { container } = render(<Positions data={null} className="custom-positions" />);
    expect(container.firstChild).toHaveClass('custom-positions');
  });
});
