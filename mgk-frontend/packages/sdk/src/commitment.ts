import { sha256 } from '@noble/hashes/sha2.js';
import { Side } from './instruction.js';
import { OrderType } from './state/types.js';

/**
 * Compute the commitment hash exactly as Rust's `compute_commitment_hash` does.
 *
 * Layout: order_type(1) + instrument_id(2) + reduce_only(1) + side(1)
 *         + price(8) + qty(8) + salt(8) + user(32) + batch_id(8) = 69 bytes
 *
 * All multi-byte fields are little-endian (matching Rust's `to_le_bytes()`).
 * The 69 bytes are concatenated and fed to a single SHA-256 hash.
 *
 * See: programs/perps-core/src/instructions/commit_order.rs:46-87
 */
export function computeCommitmentHash(
  orderType: OrderType,
  instrumentId: number,
  reduceOnly: boolean,
  side: Side,
  price: bigint,
  qty: bigint,
  salt: bigint,
  user: Uint8Array,
  batchId: bigint,
): Uint8Array {
  const buf = new Uint8Array(69);
  const view = new DataView(buf.buffer);

  let off = 0;
  view.setUint8(off, orderType); off += 1;
  view.setUint16(off, instrumentId, true); off += 2;
  view.setUint8(off, reduceOnly ? 1 : 0); off += 1;
  view.setUint8(off, side); off += 1;
  view.setBigInt64(off, price, true); off += 8;
  view.setBigUint64(off, qty, true); off += 8;
  view.setBigUint64(off, salt, true); off += 8;
  buf.set(user, off); off += 32;
  view.setBigUint64(off, batchId, true);

  return sha256(buf);
}

/**
 * Convenience wrapper that returns a hex string — uses the full
 * web3.js PublicKey to get the 32-byte user address.
 */
export function computeCommitmentHashHex(
  orderType: OrderType,
  instrumentId: number,
  reduceOnly: boolean,
  side: Side,
  price: bigint,
  qty: bigint,
  salt: bigint,
  user: { toBytes(): Uint8Array },
  batchId: bigint,
): string {
  const hash = computeCommitmentHash(
    orderType,
    instrumentId,
    reduceOnly,
    side,
    price,
    qty,
    salt,
    user.toBytes(),
    batchId,
  );
  return Array.from(hash)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
