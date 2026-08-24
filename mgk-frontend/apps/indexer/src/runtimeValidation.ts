import type { PublicKey } from '@solana/web3.js';

export interface RuntimeAccountLike {
  owner: PublicKey;
  data: Uint8Array;
}

/** Reject accounts from a previous deployment or an older data layout. */
export function isOwnedAccountWithMinimumSize(
  info: RuntimeAccountLike | null,
  owner: PublicKey,
  minimumSize: number,
): boolean {
  return info !== null && info.owner.equals(owner) && info.data.length >= minimumSize;
}
