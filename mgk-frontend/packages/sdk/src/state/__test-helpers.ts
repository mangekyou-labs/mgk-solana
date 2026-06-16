/**
 * Test-only BPF layout encoders for Portfolio, Batch, Commitment.
 * Mirrors the decoder layout exactly. NOT for production use — T1.7 will add
 * instruction encoders; this file is purely for round-trip tests.
 */
import { PublicKey } from '@solana/web3.js';
import {
  BATCH_SIZE,
  COMMITMENT_SIZE,
  MAX_INSTRUMENTS,
  PORTFOLIO_SIZE,
  type BatchState,
  type CommitmentState,
  type PortfolioState,
} from './types.js';

function writeU128(view: DataView, offset: number, value: bigint): void {
  const mask = 0xffffffffffffffffn;
  const lo = value & mask;
  const hi = value >> 64n;
  view.setBigUint64(offset, lo, true);
  view.setBigUint64(offset + 8, hi, true);
}

function writeI128(view: DataView, offset: number, value: bigint): void {
  const mask = 0xffffffffffffffffn;
  const lo = value & mask;
  const hi = value >> 64n;
  view.setBigUint64(offset, lo, true);
  view.setBigInt64(offset + 8, hi, true);
}

export function encodeBatch(state: BatchState): Uint8Array {
  const buf = new Uint8Array(BATCH_SIZE);
  const view = new DataView(buf.buffer);
  view.setBigUint64(0, state.batchId, true);
  view.setUint8(8, state.status);
  view.setBigUint64(16, state.commitDeadlineSlot, true);
  view.setBigUint64(24, state.revealDeadlineSlot, true);
  view.setBigUint64(32, state.closeSlot, true);
  view.setBigUint64(40, state.shuffleSeed, true);
  view.setBigInt64(48, state.clearingPrice, true);
  view.setUint32(56, state.totalCommitments, true);
  view.setUint32(60, state.totalRevealed, true);
  view.setUint32(64, state.totalSettled, true);
  view.setBigUint64(72, state.totalVolume, true);
  writeU128(view, 80, state.totalNotional);
  writeU128(view, 96, state.slashedDeposits);
  view.setUint8(112, state.bump);
  return buf;
}

export function encodeCommitment(state: CommitmentState): Uint8Array {
  const buf = new Uint8Array(COMMITMENT_SIZE);
  const view = new DataView(buf.buffer);
  view.setBigUint64(0, state.batchId, true);
  buf.set(state.user.toBytes(), 8);
  buf.set(state.orderHash, 40);
  view.setBigUint64(72, state.depositLamports, true);
  view.setUint8(80, state.status);
  view.setBigUint64(88, state.nonce, true);
  const r = state.revealed;
  buf.set(r.user.toBytes(), 96);
  view.setBigInt64(128, r.price, true);
  view.setBigUint64(136, r.qty, true);
  view.setBigUint64(144, r.salt, true);
  view.setUint16(152, r.instrumentId, true);
  view.setUint32(154, r.commitmentIdx, true);
  view.setUint8(158, r.orderType);
  view.setUint8(159, r.side);
  view.setUint8(160, r.reduceOnly ? 1 : 0);
  return buf;
}

export function encodePortfolio(state: PortfolioState): Uint8Array {
  const buf = new Uint8Array(PORTFOLIO_SIZE);
  const view = new DataView(buf.buffer);
  buf.set(state.user.toBytes(), 0);
  writeI128(view, 32, state.equity);
  writeI128(view, 48, state.principal);
  writeI128(view, 64, state.pnl);
  writeU128(view, 80, state.im);
  writeU128(view, 96, state.mm);
  writeI128(view, 112, state.freeCollateral);
  writeI128(view, 128, state.health);
  view.setUint16(144, state.positionsLen, true);
  for (let i = 0; i < state.positionsLen; i++) {
    const p = state.positions[i];
    if (!p) continue;
    const off = 152 + i * 24;
    view.setUint16(off, p.instrumentId, true);
    view.setBigInt64(off + 8, p.qty, true);
    view.setBigInt64(off + 16, p.entryVwap, true);
  }
  for (let i = 0; i < MAX_INSTRUMENTS; i++) {
    const v = state.lastFundingCheckpoint[i] ?? 0n;
    writeI128(view, 920 + i * 16, v);
  }
  view.setBigUint64(1432, state.lastBatchId, true);
  view.setBigUint64(1440, state.lastSlot, true);
  view.setUint8(1448, state.bump);
  return buf;
}

export function pubkeyFromHex(hex: string): PublicKey {
  return new PublicKey(hex);
}
