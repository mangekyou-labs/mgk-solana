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
  CancelAllRestingOrders: 13,
  SetPauseFlags: 14,
  InitVault: 15,
  CreateBatch: 16,
  SetBatchCounter: 17,
  CreatePortfolio: 18,
  InitPortfolioForUser: 19,
  /** DFBA single-tx open post (replaces Commit+Reveal). */
  PostOrder: 20,
  /** Governance-only: update batch parameters. */
  SetBatchParams: 21,
  /** Governance-only: retune instrument taker/maker fees. */
  SetInstrumentFees: 22,
  /** Governance-only: bind instrument to price oracle account. */
  SetInstrumentOracle: 23,
  /** Governance-only: update D7 funding parameters. */
  SetFundingParams: 24,
} as const;

/** Matcher program discriminators (perps-matcher entrypoint). */
export const MATCHER_INSTRUCTION = {
  ComputeClearing: 0,
  CancelResting: 1,
  ModifyResting: 2,
  ClearAndMatch: 3,
  CancelAll: 4,
  DfbaClear: 5,
  PlaceResting: 6,
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
 * DFBA: transitions Committing → Clearing (skips reveal).
 */
export function encodeCloseCommitting(): Uint8Array {
  return new Uint8Array([CORE_INSTRUCTION.CloseCommitting]);
}

export interface PostOrderParams {
  side: Side;
  /** false = taker (default), true = maker */
  isMaker?: boolean;
  price: bigint;
  qty: bigint;
  instrumentId: number;
  reduceOnly?: boolean;
}

/**
 * PostOrder (disc 20) — DFBA open limit post.
 * Wire: disc(1) + side(1) + is_maker(1) + price(8) + qty(8) + instrument_id(2) + reduce_only(1) = 22
 */
export function encodePostOrder(params: PostOrderParams): Uint8Array {
  const buf = new Uint8Array(22);
  const view = new DataView(buf.buffer);
  view.setUint8(0, CORE_INSTRUCTION.PostOrder);
  view.setUint8(1, params.side);
  view.setUint8(2, params.isMaker ? 1 : 0);
  view.setBigInt64(3, params.price, true);
  view.setBigUint64(11, params.qty, true);
  view.setUint16(19, params.instrumentId, true);
  view.setUint8(21, params.reduceOnly ? 1 : 0);
  return buf;
}

/**
 * Matcher DfbaClear (disc 5).
 * Wire: disc(1) + marginal_size_cap(8) + num_orders(2) [=0 → collect from book]
 * Optional trailing orders if num_orders > 0 (not encoded here for keeper path).
 */
export function encodeDfbaClear(marginalSizeCap: bigint = BigInt('0xFFFFFFFFFFFFFFFF')): Uint8Array {
  const buf = new Uint8Array(11);
  const view = new DataView(buf.buffer);
  view.setUint8(0, MATCHER_INSTRUCTION.DfbaClear);
  view.setBigUint64(1, marginalSizeCap, true);
  view.setUint16(9, 0, true); // collect from book
  return buf;
}

/**
 * Matcher PlaceResting (disc 6) — usually invoked via Core PostOrder CPI.
 * Wire: disc(1) + user(32) + side(1) + is_maker(1) + price(8) + qty(8) + instrument_id(2) + reduce_only(1) = 54
 */
export function encodePlaceResting(
  user: Uint8Array,
  side: Side,
  isMaker: boolean,
  price: bigint,
  qty: bigint,
  instrumentId: number,
  reduceOnly = false,
): Uint8Array {
  const buf = new Uint8Array(54);
  const view = new DataView(buf.buffer);
  view.setUint8(0, MATCHER_INSTRUCTION.PlaceResting);
  buf.set(user.subarray(0, 32), 1);
  view.setUint8(33, side);
  view.setUint8(34, isMaker ? 1 : 0);
  view.setBigInt64(35, price, true);
  view.setBigUint64(43, qty, true);
  view.setUint16(51, instrumentId, true);
  view.setUint8(53, reduceOnly ? 1 : 0);
  return buf;
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
 * LiquidateUser — discriminator + num_instruments (u16), 3 bytes total.
 * Wire: disc(1) + num_instruments(2).
 * Accounts: portfolio, registry, vault, liquidator, **batch** (Settled + mark_valid),
 * instruments…, oracle. Rejects when batch.liq_paused or !mark_valid (DFBA).
 */
export function encodeLiquidateUser(numInstruments: number): Uint8Array {
  const buf = new Uint8Array(3);
  const view = new DataView(buf.buffer);
  view.setUint8(0, CORE_INSTRUCTION.LiquidateUser);
  view.setUint16(1, numInstruments, true);
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
 * Initialize — discriminator + 131 bytes params, 132 total.
 * Wire format (matches process_initialize_inner data layout):
 *   governance(32) + base_deposit(8) + n_min(4) + t_min(8) + t_max(8) + t_reveal(8)
 *   + instrument_id(2) + tick(8) + lot(8) + imr(2) + mmr(2) + taker_fee(2) + maker_fee(2)
 *   + oracle(32) + registry_bump(1) + instrument_bump(1) + vault_bump(1) + batch_bump(1)
 *   = 131 bytes params.
 */
export interface InitializeParams {
  governance: Uint8Array;
  baseDeposit: bigint;
  nMin: number;
  tMinSlots: bigint;
  tMaxSlots: bigint;
  tRevealSlots: bigint;
  instrumentId: number;
  tickSize: bigint;
  lotSize: bigint;
  imrBps: number;
  mmrBps: number;
  takerFeeBps: number;
  makerFeeBps: number;
  oracleAddr: Uint8Array;
  registryBump: number;
  instrumentBump: number;
  vaultBump: number;
  batchBump: number;
}

export function encodeInitialize(params: InitializeParams): Uint8Array {
  const buf = new Uint8Array(132);
  buf.set(params.governance, 1);                              // 1..33
  const view = new DataView(buf.buffer);
  view.setBigUint64(33, params.baseDeposit, true);           // 33..41
  view.setUint32(41, params.nMin, true);                     // 41..45
  view.setBigUint64(45, params.tMinSlots, true);             // 45..53
  view.setBigUint64(53, params.tMaxSlots, true);             // 53..61
  view.setBigUint64(61, params.tRevealSlots, true);           // 61..69
  view.setUint16(69, params.instrumentId, true);             // 69..71
  view.setBigUint64(71, params.tickSize, true);              // 71..79
  view.setBigUint64(79, params.lotSize, true);                // 79..87
  view.setUint16(87, params.imrBps, true);                   // 87..89
  view.setUint16(89, params.mmrBps, true);                   // 89..91
  view.setUint16(91, params.takerFeeBps, true);             // 91..93
  view.setInt16(93, params.makerFeeBps, true);              // 93..95
  buf.set(params.oracleAddr, 95);                            // 95..127
  buf[127] = params.registryBump;                           // 127
  buf[128] = params.instrumentBump;                         // 128
  buf[129] = params.vaultBump;                              // 129
  buf[130] = params.batchBump;                              // 130
  buf[0] = CORE_INSTRUCTION.Initialize;                      // disc @ 0
  return buf;
}

/**
 * CreatePortfolio — discriminator + bump, 2 bytes total.
 * Atomic create + initialize via invoke_signed(SystemProgram.createAccount).
 * Wire format: disc(1) + bump(1) = 2.
 */
export function encodeCreatePortfolio(bump: number): Uint8Array {
  const buf = new Uint8Array(2);
  buf[0] = CORE_INSTRUCTION.CreatePortfolio;
  buf[1] = bump;
  return buf;
}

/**
 * InitPortfolioForUser — discriminator + user_pubkey, 33 bytes total.
 * Keeper calls this to create + initialize a Portfolio PDA for a user.
 * Wire format: disc(1) + user_pubkey(32) = 33.
 * Entrypoint strips disc 19, passes 32-byte user pubkey to inner function.
 */
export function encodeInitPortfolioForUser(user: Uint8Array): Uint8Array {
  const buf = new Uint8Array(33);
  buf[0] = CORE_INSTRUCTION.InitPortfolioForUser;
  buf.set(user, 1);
  return buf;
}

/**
 * SetInstrumentFees (disc 22) — governance retune of taker/maker fees.
 * Wire: disc(1) + taker_fee_bps(u16 LE) + maker_fee_bps(i16 LE) = 5
 */
export function encodeSetInstrumentFees(
  takerFeeBps: number,
  makerFeeBps: number,
): Uint8Array {
  const buf = new Uint8Array(5);
  const view = new DataView(buf.buffer);
  view.setUint8(0, CORE_INSTRUCTION.SetInstrumentFees);
  view.setUint16(1, takerFeeBps, true);
  view.setInt16(3, makerFeeBps, true);
  return buf;
}

/**
 * SetInstrumentOracle (disc 23) — governance-only instrument oracle binding.
 * Wire: disc(1) = 1 byte.
 */
export function encodeSetInstrumentOracle(): Uint8Array {
  return new Uint8Array([CORE_INSTRUCTION.SetInstrumentOracle]);
}

/**
 * SetFundingParams (disc 24) — governance-only D7 funding parameter update.
 * Wire: disc(1) + coefficient_bps(i64 LE) + max_rate_bps(i64 LE) + interval_slots(u64 LE) = 25
 */
export function encodeSetFundingParams(
  coefficientBps: number,
  maxRateBps: number,
  intervalSlots: number,
): Uint8Array {
  const buf = new Uint8Array(25);
  const view = new DataView(buf.buffer);
  view.setUint8(0, CORE_INSTRUCTION.SetFundingParams);
  view.setBigInt64(1, BigInt(coefficientBps), true);
  view.setBigInt64(9, BigInt(maxRateBps), true);
  view.setBigUint64(17, BigInt(intervalSlots), true);
  return buf;
}
