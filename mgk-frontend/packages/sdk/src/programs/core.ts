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
 * InitPortfolio — discriminator + user pubkey + bump, 34 bytes total.
 * Wire format: disc(1) + user(32) + bump(1) = 34.
 *
 * Entrypoint `process_init_portfolio_inner` reads data[0..32] as the
 * user pubkey and data[32] as the bump. The discriminator is stripped
 * by the dispatch layer before reaching the inner function.
 */
export function encodeInitPortfolio(user: Uint8Array, bump: number): Uint8Array {
  const buf = new Uint8Array(34);
  buf[0] = CORE_INSTRUCTION.InitPortfolio;
  buf.set(user, 1);
  buf[33] = bump;
  return buf;
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

/**
 * CloseCommitting — discriminator only, no extra data.
 * Wire format: disc(1) + (nothing) = 1 byte.
 */
export function encodeCloseCommitting(): Uint8Array {
  return new Uint8Array([CORE_INSTRUCTION.CloseCommitting]);
}

/**
 * ClearBatch — discriminator + 3 u16 LE counts, 7 bytes total.
 * Wire format: disc(1) + num_commitments(2) + num_instruments(2) + num_portfolios(2) = 7.
 */
export function encodeClearBatch(
  numCommitments: number,
  numInstruments: number,
  numPortfolios: number,
): Uint8Array {
  const buf = new Uint8Array(7);
  const view = new DataView(buf.buffer);
  view.setUint8(0, CORE_INSTRUCTION.ClearBatch);
  view.setUint16(1, numCommitments, true);
  view.setUint16(3, numInstruments, true);
  view.setUint16(5, numPortfolios, true);
  return buf;
}

/**
 * SettleBatch — discriminator + 2 u16 LE counts, 5 bytes total.
 * Wire format: disc(1) + num_commitments(2) + num_portfolios(2) = 5.
 */
export function encodeSettleBatch(
  numCommitments: number,
  numPortfolios: number,
): Uint8Array {
  const buf = new Uint8Array(5);
  const view = new DataView(buf.buffer);
  view.setUint8(0, CORE_INSTRUCTION.SettleBatch);
  view.setUint16(1, numCommitments, true);
  view.setUint16(3, numPortfolios, true);
  return buf;
}

/**
 * LiquidateUser — discriminator + num_oracles (u16), 3 bytes total.
 * Wire format: disc(1) + num_oracles(2) = 3.
 */
export function encodeLiquidateUser(numOracles: number): Uint8Array {
  const buf = new Uint8Array(3);
  const view = new DataView(buf.buffer);
  view.setUint8(0, CORE_INSTRUCTION.LiquidateUser);
  view.setUint16(1, numOracles, true);
  return buf;
}

/**
 * CancelRestingOrder — discriminator + order_id (u64), 9 bytes total.
 * Wire format: disc(1) + order_id(8) = 9.
 */
export function encodeCancelRestingOrder(orderId: bigint): Uint8Array {
  const buf = new Uint8Array(9);
  const view = new DataView(buf.buffer);
  view.setUint8(0, CORE_INSTRUCTION.CancelRestingOrder);
  view.setBigUint64(1, orderId, true);
  return buf;
}

/**
 * ModifyRestingOrder — discriminator + order_id (u64) + new_qty (u64), 17 bytes total.
 * Wire format: disc(1) + order_id(8) + new_qty(8) = 17.
 */
export function encodeModifyRestingOrder(
  orderId: bigint,
  newQty: bigint,
): Uint8Array {
  const buf = new Uint8Array(17);
  const view = new DataView(buf.buffer);
  view.setUint8(0, CORE_INSTRUCTION.ModifyRestingOrder);
  view.setBigUint64(1, orderId, true);
  view.setBigUint64(9, newQty, true);
  return buf;
}

export interface AddInstrumentParams {
  instrumentId: number;
  tickSize: bigint;
  lotSize: bigint;
  imrBps: number;
  mmrBps: number;
  takerFeeBps: number;
  makerFeeBps: number;
  oracleAddr: Uint8Array;
  bump: number;
}

/**
 * AddInstrument (governance-only) — discriminator + 58 bytes, 59 total.
 * Wire format: disc(1) + instrument_id(2) + tick_size(8) + lot_size(8)
 *   + imr_bps(2) + mmr_bps(2) + taker_fee_bps(2) + maker_fee_bps(2)
 *   + oracle_addr(32) + bump(1) = 59.
 */
export function encodeAddInstrument(params: AddInstrumentParams): Uint8Array {
  const buf = new Uint8Array(59);
  const view = new DataView(buf.buffer);
  view.setUint8(0, CORE_INSTRUCTION.AddInstrument);
  view.setUint16(1, params.instrumentId, true);
  view.setBigUint64(3, params.tickSize, true);
  view.setBigUint64(11, params.lotSize, true);
  view.setUint16(19, params.imrBps, true);
  view.setUint16(21, params.mmrBps, true);
  view.setUint16(23, params.takerFeeBps, true);
  view.setInt16(25, params.makerFeeBps, true);
  buf.set(params.oracleAddr, 27);
  view.setUint8(58, params.bump);
  return buf;
}

/**
 * Initialize (governance-only) — discriminator only, 1 byte.
 */
export function encodeInitialize(): Uint8Array {
  return new Uint8Array([CORE_INSTRUCTION.Initialize]);
}
