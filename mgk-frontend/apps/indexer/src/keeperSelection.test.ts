import { describe, expect, it } from 'vitest';

import {
  selectActiveBatchCandidate,
  shouldCloseCommitting,
  type BatchCandidate,
} from './keeperSelection.js';

function candidate(address: string, batchId: bigint): BatchCandidate {
  return { address, batchId };
}

describe('keeper batch selection', () => {
  it('uses a scanned active batch instead of creating a duplicate for a stale persisted keypair', () => {
    const selected = selectActiveBatchCandidate(
      18n,
      candidate('persisted-stale', 16n),
      [candidate('active-keypair', 18n)],
    );

    expect(selected).toEqual({
      source: 'scan',
      candidate: candidate('active-keypair', 18n),
    });
  });

  it('keeps the persisted keypair when it contains the active batch', () => {
    const selected = selectActiveBatchCandidate(
      18n,
      candidate('persisted-active', 18n),
      [candidate('another-account', 18n)],
    );

    expect(selected).toEqual({
      source: 'tracked',
      candidate: candidate('persisted-active', 18n),
    });
  });

  it('returns no candidate when the active batch account is genuinely missing', () => {
    expect(
      selectActiveBatchCandidate(20n, candidate('persisted-stale', 19n), [candidate('older', 18n)]),
    ).toBeNull();
  });

  it('allows an empty batch to close after its deadline without retuning n_min', () => {
    expect(shouldCloseCommitting(150n, 150n, 0n, 1n)).toBe(true);
    expect(shouldCloseCommitting(149n, 150n, 0n, 1n)).toBe(false);
    expect(shouldCloseCommitting(149n, 150n, 1n, 1n)).toBe(false);
  });
});
