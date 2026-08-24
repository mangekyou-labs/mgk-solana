import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';

import { isOwnedAccountWithMinimumSize } from './runtimeValidation.js';

const CURRENT_PROGRAM = new PublicKey('C7w2mKz2KQgDroNNhACm9MutXhPiesVr9Gn2x8TDsRYx');
const OTHER_PROGRAM = new PublicKey('3jYQ4mpWBBtwrzYQ4zzKhgqVcWWsG2HpXi9oXTBpekja');

describe('runtime account validation', () => {
  it('rejects a persisted account owned by an older deployment', () => {
    expect(
      isOwnedAccountWithMinimumSize(
        { owner: OTHER_PROGRAM, data: new Uint8Array(160) },
        CURRENT_PROGRAM,
        160,
      ),
    ).toBe(false);
  });

  it('rejects an account whose data is smaller than the active layout', () => {
    expect(
      isOwnedAccountWithMinimumSize(
        { owner: CURRENT_PROGRAM, data: new Uint8Array(120) },
        CURRENT_PROGRAM,
        160,
      ),
    ).toBe(false);
  });

  it('accepts an account owned by the active program with enough data', () => {
    expect(
      isOwnedAccountWithMinimumSize(
        { owner: CURRENT_PROGRAM, data: new Uint8Array(160) },
        CURRENT_PROGRAM,
        160,
      ),
    ).toBe(true);
  });
});
