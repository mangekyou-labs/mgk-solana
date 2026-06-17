import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DepthRow, type LevelRow } from './DepthRow';

function row(overrides: Partial<LevelRow> = {}): LevelRow {
  return {
    level: {
      price: 0n,
      totalQty: 0n,
      orderCount: 1,
      firstOrderOffset: 0,
    },
    cumulative: 0n,
    barPct: 0,
    ...overrides,
  } as LevelRow;
}

describe('DepthRow', () => {
  it('renders price, size, and cumulative total columns', () => {
    const r = row({
      level: {
        price: 150_000_000n,
        totalQty: 5_000_000n,
        orderCount: 3,
        firstOrderOffset: 0,
      },
      cumulative: 12_000_000n,
      barPct: 50,
    });

    const { container } = render(<DepthRow row={r} side="bid" />);
    const el = container.firstElementChild as HTMLElement;

    expect(el.getAttribute('data-testid')).toBe('depth-row');
    expect(el.getAttribute('data-side')).toBe('bid');
  });

  it('sets the data-index attribute when provided', () => {
    const { container } = render(
      <DepthRow row={row()} side="ask" data-index={3} />,
    );
    expect(
      container.firstElementChild?.getAttribute('data-index'),
    ).toBe('3');
  });

  it('applies bull tone for bid side', () => {
    const r = row({
      level: { price: 100n, totalQty: 1n, orderCount: 1, firstOrderOffset: 0 },
    });
    const { container } = render(<DepthRow row={r} side="bid" />);
    const price = container.querySelector('[data-testid="depth-row-price"]');
    expect(price?.className).toContain('text-bull');
  });

  it('applies bear tone for ask side', () => {
    const r = row({
      level: { price: 100n, totalQty: 1n, orderCount: 1, firstOrderOffset: 0 },
    });
    const { container } = render(<DepthRow row={r} side="ask" />);
    const price = container.querySelector('[data-testid="depth-row-price"]');
    expect(price?.className).toContain('text-bear');
  });

  it('renders the depth bar with barPct width', () => {
    const r = row({ barPct: 42 });
    const { container } = render(<DepthRow row={r} side="bid" />);
    const bar = container.querySelector('[aria-hidden]') as HTMLElement;
    expect(bar).not.toBeNull();
    expect(bar.style.width).toBe('42%');
  });

  it('applies bull/10 background for bid side depth bar', () => {
    const r = row({ barPct: 30 });
    const { container } = render(<DepthRow row={r} side="bid" />);
    const bar = container.querySelector('[aria-hidden]') as HTMLElement;
    expect(bar.className).toContain('bg-bull/10');
  });

  it('applies bear/10 background for ask side depth bar', () => {
    const r = row({ barPct: 30 });
    const { container } = render(<DepthRow row={r} side="ask" />);
    const bar = container.querySelector('[aria-hidden]') as HTMLElement;
    expect(bar.className).toContain('bg-bear/10');
  });

  it('displays totalQty in the size column', () => {
    const r = row({
      level: {
        price: 150_000_000n,
        totalQty: 5_000_000n,
        orderCount: 1,
        firstOrderOffset: 0,
      },
    });
    const { container } = render(<DepthRow row={r} side="bid" />);
    const size = container.querySelector(
      '[data-testid="depth-row-size"]',
    );
    expect(size).toHaveTextContent('5');
  });

  it('displays cumulative in the total column', () => {
    const r = row({ cumulative: 12_000_000n });
    const { container } = render(<DepthRow row={r} side="bid" />);
    const total = container.querySelector(
      '[data-testid="depth-row-total"]',
    );
    expect(total).toHaveTextContent('12');
  });
});
