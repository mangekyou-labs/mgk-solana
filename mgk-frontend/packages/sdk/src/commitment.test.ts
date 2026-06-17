import { describe, expect, it } from 'vitest';
import { Side } from './instruction.js';
import { OrderType } from './state/types.js';
import { computeCommitmentHash, computeCommitmentHashHex } from './commitment.js';

describe('computeCommitmentHash', () => {
  const user = new Uint8Array(32).fill(0x42);

  it('produces a 32-byte hash', () => {
    const hash = computeCommitmentHash(
      OrderType.LimitGTC,
      0,
      false,
      Side.Buy,
      150_000_000n,
      10_000_000n,
      12345n,
      user,
      1n,
    );
    expect(hash).toHaveLength(32);
  });

  it('produces deterministic output', () => {
    const a = computeCommitmentHash(
      OrderType.LimitGTC, 1, true, Side.Sell,
      150_000_000n, 10_000_000n, 999n, user, 42n,
    );
    const b = computeCommitmentHash(
      OrderType.LimitGTC, 1, true, Side.Sell,
      150_000_000n, 10_000_000n, 999n, user, 42n,
    );
    expect(a).toEqual(b);
  });

  it('changes output when any field differs', () => {
    const base = computeCommitmentHash(
      OrderType.LimitGTC, 0, false, Side.Buy,
      150_000_000n, 10_000_000n, 0n, user, 1n,
    );

    const diffOrderType = computeCommitmentHash(
      OrderType.LimitIOC, 0, false, Side.Buy,
      150_000_000n, 10_000_000n, 0n, user, 1n,
    );
    const diffSide = computeCommitmentHash(
      OrderType.LimitGTC, 0, false, Side.Sell,
      150_000_000n, 10_000_000n, 0n, user, 1n,
    );
    const diffPrice = computeCommitmentHash(
      OrderType.LimitGTC, 0, false, Side.Buy,
      151_000_000n, 10_000_000n, 0n, user, 1n,
    );
    const diffSalt = computeCommitmentHash(
      OrderType.LimitGTC, 0, false, Side.Buy,
      150_000_000n, 10_000_000n, 1n, user, 1n,
    );

    expect(diffOrderType).not.toEqual(base);
    expect(diffSide).not.toEqual(base);
    expect(diffPrice).not.toEqual(base);
    expect(diffSalt).not.toEqual(base);
  });

  it('produces 64-char hex string from the wrapper', () => {
    const hex = computeCommitmentHashHex(
      OrderType.LimitGTC,
      0,
      false,
      Side.Buy,
      150_000_000n,
      10_000_000n,
      0n,
      { toBytes: () => user },
      1n,
    );
    expect(hex).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(hex)).toBe(true);
  });

  it('handles reduceOnly flag correctly', () => {
    const withReduce = computeCommitmentHash(
      OrderType.LimitGTC, 0, true, Side.Sell,
      100n, 100n, 0n, user, 0n,
    );
    const withoutReduce = computeCommitmentHash(
      OrderType.LimitGTC, 0, false, Side.Sell,
      100n, 100n, 0n, user, 0n,
    );
    expect(withReduce).not.toEqual(withoutReduce);
  });
});
