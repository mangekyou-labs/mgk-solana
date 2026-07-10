import { PublicKey } from '@solana/web3.js';
import {
  COMMITMENT_SIZE,
  type CommitmentState,
  type CommitmentStatus,
  type RevealedOrder,
  type OrderType,
} from './types.js';
import { Side } from '../instruction.js';

const REVEALED_OFFSET = 96;

export function decodeRevealedOrder(
  view: DataView,
  baseOffset: number,
): RevealedOrder {
  const userBytes = new Uint8Array(
    view.buffer,
    view.byteOffset + baseOffset,
    32,
  );
  return {
    user: new PublicKey(userBytes),
    price: view.getBigInt64(baseOffset + 32, true),
    qty: view.getBigUint64(baseOffset + 40, true),
    salt: view.getBigUint64(baseOffset + 48, true),
    instrumentId: view.getUint16(baseOffset + 56, true),
    commitmentIdx: view.getUint32(baseOffset + 60, true),
    orderType: view.getUint8(baseOffset + 64) as OrderType,
    side: view.getUint8(baseOffset + 65) as Side,
    reduceOnly: view.getUint8(baseOffset + 66) !== 0,
  };
}

export function decodeCommitment(data: Uint8Array): CommitmentState {
  if (data.length < COMMITMENT_SIZE) {
    throw new Error(
      `decodeCommitment: buffer too small (${data.length} < ${COMMITMENT_SIZE})`,
    );
  }
  const view = new DataView(data.buffer, data.byteOffset, COMMITMENT_SIZE);

  const userBytes = new Uint8Array(data.buffer, data.byteOffset + 8, 32);
  const orderHash = new Uint8Array(
    data.buffer,
    data.byteOffset + 40,
    32,
  );

  return {
    batchId: view.getBigUint64(0, true),
    user: new PublicKey(userBytes),
    orderHash,
    depositLamports: view.getBigUint64(72, true),
    status: view.getUint8(80) as CommitmentStatus,
    nonce: view.getBigUint64(88, true),
    revealed: decodeRevealedOrder(view, REVEALED_OFFSET),
  };
}
