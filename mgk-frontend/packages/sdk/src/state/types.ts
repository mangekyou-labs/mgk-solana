import type { PublicKey } from '@solana/web3.js';
import { Side } from '../instruction.js';

/**
 * On-chain batch phase (u8 @ Batch.status).
 *
 * DFBA v1 lifecycle: Collecting → Clearing → Settled.
 * Wire values are stable; names follow DFBA (not commit-reveal).
 * `Committing` / `Revealing` remain as numeric aliases for older callers.
 */
export const BatchStatus = {
  /** Open post window — DFBA orders accepted (wire 0). */
  Collecting: 0,
  /** @deprecated DFBA alias — same wire value as Collecting. */
  Committing: 0,
  /** @deprecated DFBA skips reveal; wire 1 retained for layout/compat only. */
  Revealing: 1,
  /** Dual auction running (keeper ClearBatch). */
  Clearing: 2,
  /** Fills applied; next batch opened. */
  Settled: 3,
} as const;
export type BatchStatus = (typeof BatchStatus)[keyof typeof BatchStatus];

export const CommitmentStatus = {
  Pending: 0,
  Revealed: 1,
  Slashed: 2,
  Settled: 3,
} as const;
export type CommitmentStatus = (typeof CommitmentStatus)[keyof typeof CommitmentStatus];

export const OrderType = {
  LimitGTC: 0,
  LimitIOC: 1,
  LimitALO: 2,
  Market: 3,
  Cancel: 4,
  CancelAll: 5,
} as const;
export type OrderType = (typeof OrderType)[keyof typeof OrderType];

export interface Position {
  instrumentId: number;
  qty: bigint;
  entryVwap: bigint;
}

export interface RevealedOrder {
  user: PublicKey;
  price: bigint;
  qty: bigint;
  salt: bigint;
  instrumentId: number;
  commitmentIdx: number;
  orderType: OrderType;
  side: Side;
  reduceOnly: boolean;
}

export interface BatchState {
  batchId: bigint;
  status: BatchStatus;
  commitDeadlineSlot: bigint;
  revealDeadlineSlot: bigint;
  closeSlot: bigint;
  /** Unused in DFBA (legacy shuffle seed). */
  shuffleSeed: bigint;
  /** DFBA mid mark when markValid; else 0 / VWAP fallback. */
  clearingPrice: bigint;
  totalCommitments: number;
  totalRevealed: number;
  totalSettled: number;
  totalVolume: bigint;
  totalNotional: bigint;
  slashedDeposits: bigint;
  bump: number;
  /** DFBA bid auction clearing price. */
  bidClearingPrice: bigint;
  /** DFBA ask auction clearing price. */
  askClearingPrice: bigint;
  matchedBidQty: bigint;
  matchedAskQty: bigint;
  /** Both auctions produced a clear this batch. */
  markValid: boolean;
  /** Liquidations paused (no dual clear). */
  liqPaused: boolean;
}

export interface CommitmentState {
  batchId: bigint;
  user: PublicKey;
  orderHash: Uint8Array;
  depositLamports: bigint;
  status: CommitmentStatus;
  nonce: bigint;
  revealed: RevealedOrder;
}

export interface PortfolioState {
  user: PublicKey;
  equity: bigint;
  principal: bigint;
  pnl: bigint;
  im: bigint;
  mm: bigint;
  freeCollateral: bigint;
  health: bigint;
  positionsLen: number;
  positions: Position[];
  lastFundingCheckpoint: bigint[];
  lastBatchId: bigint;
  lastSlot: bigint;
  bump: number;
}

/** size_of::<Batch>() after DFBA fields (was 120 pre-DFBA). */
export const BATCH_SIZE = 160;
export const COMMITMENT_SIZE = 168;
export const PORTFOLIO_SIZE = 1456; // BPF layout: i128/u128 have 8-byte alignment (not 16 like native)
export const MAX_POSITIONS = 32;
export const MAX_INSTRUMENTS = 32;

// Order book constants (mirrors programs/common/src/book.rs and programs/perps-matcher/src/state/book.rs)
export const MAX_LEVELS = 64;
export const MAX_RESTING_ORDERS = 256;
export const BOOK_HEADER_SIZE = 3120; // 48 (header) + 64*24 (bids) + 64*24 (asks)
export const RESTING_ORDER_SIZE = 96;
export const RESTING_ORDERS_OFFSET = BOOK_HEADER_SIZE;
export const REGISTRY_SIZE = 86; // bytes (packed struct, no 8-byte alignment padding)

// ---------------------------------------------------------------------------
// Order book types
// ---------------------------------------------------------------------------

export interface BookLevel {
  /** i64, LE, scaled 1e6 */
  price: bigint;
  /** u64, LE, scaled 1e6 */
  totalQty: bigint;
  /** u16, LE */
  orderCount: number;
  /** u32, LE, index into the resting-order flat array */
  firstOrderOffset: number;
}

export interface BookHeader {
  instrumentId: number;
  bestBid: bigint;
  bestAsk: bigint;
  bidCount: number;
  askCount: number;
  nextOrderId: bigint;
  lastUpdateSlot: bigint;
  bids: BookLevel[];
  asks: BookLevel[];
}

export interface RestingOrder {
  orderId: bigint;
  user: PublicKey;
  side: Side;
  price: bigint;
  qty: bigint;
  filledQty: bigint;
  instrumentId: number;
  reduceOnly: boolean;
  batchPlaced: bigint;
  nextOrderOffset: number;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface RegistryState {
  governance: PublicKey;
  instrumentCount: number;
  volatilityMultiplier: number;
  batchIdCounter: bigint;
  baseDeposit: bigint;
  nMin: number;
  tMinSlots: bigint;
  tMaxSlots: bigint;
  tRevealSlots: bigint;
  bump: number;
  pauseFlags: number;
}

export function readI128(view: DataView, offset: number): bigint {
  const lo = view.getBigUint64(offset, true);
  const hi = view.getBigInt64(offset + 8, true);
  return (hi << 64n) + lo;
}

export function readU128(view: DataView, offset: number): bigint {
  const lo = view.getBigUint64(offset, true);
  const hi = view.getBigUint64(offset + 8, true);
  return (hi << 64n) + lo;
}
