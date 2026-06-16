import type { PublicKey } from '@solana/web3.js';
import { Side } from '../instruction.js';

export const BatchStatus = {
  Committing: 0,
  Revealing: 1,
  Clearing: 2,
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
  shuffleSeed: bigint;
  clearingPrice: bigint;
  totalCommitments: number;
  totalRevealed: number;
  totalSettled: number;
  totalVolume: bigint;
  totalNotional: bigint;
  slashedDeposits: bigint;
  bump: number;
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

export const BATCH_SIZE = 120;
export const COMMITMENT_SIZE = 164;
export const PORTFOLIO_SIZE = 1456;
export const MAX_POSITIONS = 32;
export const MAX_INSTRUMENTS = 32;

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
