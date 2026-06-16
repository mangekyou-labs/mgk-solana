/**
 * mgk perps-core instruction encoders.
 *
 * Single-byte discriminator (not Anchor's 8-byte SHA256). All multi-byte
 * fields are little-endian. Discriminator table mirrors the Rust
 * `CoreInstruction` enum in programs/perps-core/src/instructions/mod.rs:29-44.
 */
import { Side } from '../instruction.js';
import { OrderType } from '../state/types.js';

export const CORE_INSTRUCTION = {
  Initialize: 0,
  InitPortfolio: 1,
  Deposit: 2,
  Withdraw: 3,
  CommitOrder: 4,
  RevealOrder: 5,
  CloseCommitting: 6,
  ClearBatch: 7,
  SettleBatch: 8,
  LiquidateUser: 9,
  AddInstrument: 10,
  CancelRestingOrder: 11,
  ModifyRestingOrder: 12,
} as const;
export type CoreInstruction =
  (typeof CORE_INSTRUCTION)[keyof typeof CORE_INSTRUCTION];

/**
 * InitPortfolio — no data, just the discriminator byte.
 * Account metas (set by caller): portfolio PDA (writable, signer = payer).
 */
export function encodeInitPortfolio(): Uint8Array {
  return new Uint8Array([CORE_INSTRUCTION.InitPortfolio]);
}

/**
 * Deposit — discriminator + amount (u64 LE).
 */
export function encodeDeposit(amount: bigint): Uint8Array {
  const buf = new Uint8Array(9);
  const view = new DataView(buf.buffer);
  view.setUint8(0, CORE_INSTRUCTION.Deposit);
  view.setBigUint64(1, amount, true);
  return buf;
}

/**
 * Withdraw — discriminator + amount (u64 LE).
 */
export function encodeWithdraw(amount: bigint): Uint8Array {
  const buf = new Uint8Array(9);
  const view = new DataView(buf.buffer);
  view.setUint8(0, CORE_INSTRUCTION.Withdraw);
  view.setBigUint64(1, amount, true);
  return buf;
}

export interface CommitOrderParams {
  orderType: OrderType;
  instrumentId: number;
  reduceOnly: boolean;
  side: Side;
  price: bigint;
  qty: bigint;
  salt: bigint;
  batchId: bigint;
  commitmentBump: number;
}

/**
 * CommitOrder — discriminator + 9 fields, 39 bytes total.
 * Layout mirrors `process_commit_order` in
 * programs/perps-core/src/instructions/commit_order.rs:96-105.
 */
export function encodeCommitOrder(params: CommitOrderParams): Uint8Array {
  const buf = new Uint8Array(39);
  const view = new DataView(buf.buffer);
  view.setUint8(0, CORE_INSTRUCTION.CommitOrder);
  view.setUint8(1, params.orderType);
  view.setUint16(2, params.instrumentId, true);
  view.setUint8(4, params.reduceOnly ? 1 : 0);
  view.setUint8(5, params.side);
  view.setBigInt64(6, params.price, true);
  view.setBigUint64(14, params.qty, true);
  view.setBigUint64(22, params.salt, true);
  view.setBigUint64(30, params.batchId, true);
  view.setUint8(38, params.commitmentBump);
  return buf;
}

export interface RevealOrderParams {
  orderType: OrderType;
  instrumentId: number;
  reduceOnly: boolean;
  side: Side;
  price: bigint;
  qty: bigint;
  salt: bigint;
  batchId: bigint;
}

/**
 * RevealOrder — discriminator + 8 fields, 38 bytes total.
 * Layout mirrors `process_reveal_order` in
 * programs/perps-core/src/instructions/reveal_order.rs:18-25.
 * Note: no `commitment_bump` (only CommitOrder takes it).
 */
export function encodeRevealOrder(params: RevealOrderParams): Uint8Array {
  const buf = new Uint8Array(38);
  const view = new DataView(buf.buffer);
  view.setUint8(0, CORE_INSTRUCTION.RevealOrder);
  view.setUint8(1, params.orderType);
  view.setUint16(2, params.instrumentId, true);
  view.setUint8(4, params.reduceOnly ? 1 : 0);
  view.setUint8(5, params.side);
  view.setBigInt64(6, params.price, true);
  view.setBigUint64(14, params.qty, true);
  view.setBigUint64(22, params.salt, true);
  view.setBigUint64(30, params.batchId, true);
  return buf;
}
