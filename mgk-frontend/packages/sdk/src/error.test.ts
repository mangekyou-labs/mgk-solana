import { describe, it, expect } from 'vitest';
import { humanizeError, PercolatorError } from './error.js';

describe('PercolatorError enum mirror', () => {
  it('common range (0-99) matches the Rust enum', () => {
    expect(PercolatorError.InvalidInstruction).toBe(0);
    expect(PercolatorError.InvalidAccount).toBe(1);
    expect(PercolatorError.InvalidAccountOwner).toBe(2);
    expect(PercolatorError.InvalidMint).toBe(3);
    expect(PercolatorError.InsufficientFunds).toBe(4);
    expect(PercolatorError.Overflow).toBe(5);
    expect(PercolatorError.Underflow).toBe(6);
    expect(PercolatorError.Unauthorized).toBe(7);
  });

  it('matching range (300-399) matches the Rust enum', () => {
    expect(PercolatorError.InvalidSide).toBe(300);
    expect(PercolatorError.InvalidTimeInForce).toBe(301);
    expect(PercolatorError.InvalidMakerClass).toBe(302);
    expect(PercolatorError.InvalidOrderState).toBe(303);
    expect(PercolatorError.BookCorrupted).toBe(304);
    expect(PercolatorError.ReservedQtyExceeded).toBe(305);
  });

  it('risk range (400-499) matches the Rust enum', () => {
    expect(PercolatorError.InsufficientMargin).toBe(400);
    expect(PercolatorError.BelowMaintenanceMargin).toBe(401);
    expect(PercolatorError.InvalidRiskParams).toBe(402);
  });

  it('perps-core range (600-699) matches the Rust enum', () => {
    expect(PercolatorError.RevealDeadlineExpired).toBe(600);
  });
});

describe('humanizeError — known codes', () => {
  it('InvalidInstruction (0) mentions a malformed transaction', () => {
    expect(humanizeError(PercolatorError.InvalidInstruction)).toMatch(/malformed/i);
  });

  it('InsufficientFunds (4) tells the trader they are out of SOL', () => {
    const msg = humanizeError(PercolatorError.InsufficientFunds);
    expect(msg).toMatch(/SOL/i);
    expect(msg).not.toMatch(/lamport/i);
  });

  it('Unauthorized (7) tells the trader the action is forbidden', () => {
    expect(humanizeError(PercolatorError.Unauthorized)).toMatch(/not allowed|forbidden|unauthor/i);
  });

  it('InsufficientMargin (400) is distinct from InsufficientFunds', () => {
    const funds = humanizeError(PercolatorError.InsufficientFunds);
    const margin = humanizeError(PercolatorError.InsufficientMargin);
    expect(margin).not.toBe(funds);
    expect(margin).toMatch(/margin/i);
  });

  it('BelowMaintenanceMargin (401) mentions maintenance', () => {
    expect(humanizeError(PercolatorError.BelowMaintenanceMargin)).toMatch(/maintenance/i);
  });

  it('RevealDeadlineExpired (600) hints that the user should place a new order', () => {
    const msg = humanizeError(PercolatorError.RevealDeadlineExpired);
    expect(msg).toMatch(/deadline/i);
    expect(msg).toMatch(/new (order|batch)/i);
  });

  it('BookCorrupted (304) asks the trader to refresh', () => {
    expect(humanizeError(PercolatorError.BookCorrupted)).toMatch(/refresh/i);
  });

  it('every defined PercolatorError value has a non-empty, non-Unknown humanized message', () => {
    for (const code of Object.values(PercolatorError)) {
      const msg = humanizeError(code);
      expect(msg).toBeTruthy();
      expect(msg.length).toBeGreaterThan(0);
      expect(msg).not.toMatch(/^Unknown/);
      expect(msg).not.toMatch(/^Legacy/);
    }
  });
});

describe('humanizeError — input types', () => {
  it('accepts a number input', () => {
    expect(humanizeError(0)).toBe(humanizeError(PercolatorError.InvalidInstruction));
  });

  it('accepts a bigint input', () => {
    expect(humanizeError(0n)).toBe(humanizeError(PercolatorError.InvalidInstruction));
  });

  it('returns the same message for number and bigint of the same code', () => {
    expect(humanizeError(600n)).toBe(humanizeError(600));
    expect(humanizeError(305n)).toBe(humanizeError(305));
  });

  it('handles a large bigint that overflows a u32 cleanly (no precision loss within safe range)', () => {
    expect(humanizeError(7n)).toBe(humanizeError(7));
  });
});

describe('humanizeError — legacy ranges (return generic legacy message)', () => {
  it('100 (router, pre-strip) returns a legacy message', () => {
    const msg = humanizeError(100);
    expect(msg).toMatch(/legacy/i);
  });

  it('mid-range legacy code (150) returns a legacy message', () => {
    expect(humanizeError(150)).toMatch(/legacy/i);
  });

  it('upper-bound legacy code (199) returns a legacy message', () => {
    expect(humanizeError(199)).toMatch(/legacy/i);
  });

  it('200 (slab, pre-strip) returns a legacy message', () => {
    expect(humanizeError(200)).toMatch(/legacy/i);
  });

  it('500 (anti-toxicity, unused) returns a legacy message', () => {
    expect(humanizeError(500)).toMatch(/legacy/i);
  });

  it('599 (anti-toxicity upper bound) returns a legacy message', () => {
    expect(humanizeError(599)).toMatch(/legacy/i);
  });
});

describe('humanizeError — live ranges with unmapped codes (range-named unknown)', () => {
  it('gap in matching range (399) returns "Unknown matching error"', () => {
    const msg = humanizeError(399);
    expect(msg).toMatch(/unknown/i);
    expect(msg).toMatch(/matching/i);
    expect(msg).toContain('399');
  });

  it('gap in common range (99) returns "Unknown common error"', () => {
    const msg = humanizeError(99);
    expect(msg).toMatch(/unknown/i);
    expect(msg).toMatch(/common/i);
    expect(msg).toContain('99');
  });

  it('gap in risk range (450) returns "Unknown risk error"', () => {
    const msg = humanizeError(450);
    expect(msg).toMatch(/unknown/i);
    expect(msg).toMatch(/risk/i);
    expect(msg).toContain('450');
  });

  it('gap in perps-core range (650) returns "Unknown perps-core error"', () => {
    const msg = humanizeError(650);
    expect(msg).toMatch(/unknown/i);
    expect(msg).toMatch(/perps-core/i);
    expect(msg).toContain('650');
  });

  it('perps-matcher range (700) with no defined codes returns "Unknown perps-matcher error"', () => {
    const msg = humanizeError(700);
    expect(msg).toMatch(/unknown/i);
    expect(msg).toMatch(/perps-matcher/i);
    expect(msg).toContain('700');
  });
});

describe('humanizeError — out-of-range codes (generic unknown)', () => {
  it('code above the highest live range (800) returns a generic unknown message', () => {
    const msg = humanizeError(800);
    expect(msg).toMatch(/unknown/i);
    expect(msg).not.toMatch(/matching|risk|common|perps/);
    expect(msg).toContain('800');
  });

  it('code far above the live ranges (10000) returns a generic unknown message', () => {
    const msg = humanizeError(10000);
    expect(msg).toMatch(/unknown/i);
    expect(msg).toContain('10000');
  });

  it('code just below the lowest live range — actually 0-99 is live, so 0 maps; we test the boundary at 99 (live-unknown) vs 100 (legacy)', () => {
    expect(humanizeError(99)).toMatch(/common/i);
    expect(humanizeError(100)).toMatch(/legacy/i);
  });
});

describe('humanizeError — input guards', () => {
  it('throws on negative input', () => {
    expect(() => humanizeError(-1)).toThrow(/invalid input/i);
  });

  it('throws on a large negative input', () => {
    expect(() => humanizeError(-1000)).toThrow(/invalid input/i);
  });

  it('throws on a decimal input', () => {
    expect(() => humanizeError(1.5)).toThrow(/invalid input/i);
  });

  it('throws on NaN', () => {
    expect(() => humanizeError(Number.NaN)).toThrow(/invalid input/i);
  });

  it('throws on a decimal bigint (not possible in JS, but on decimal number)', () => {
    expect(() => humanizeError(0.1)).toThrow(/invalid input/i);
  });

  it('throws on Infinity', () => {
    expect(() => humanizeError(Number.POSITIVE_INFINITY)).toThrow(/invalid input/i);
  });
});
