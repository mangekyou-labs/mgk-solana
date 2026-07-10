import { PublicKey } from '@solana/web3.js';
import {
  MAX_INSTRUMENTS,
  PORTFOLIO_SIZE,
  readI128,
  readU128,
  type PortfolioState,
  type Position,
} from './types.js';

const POSITIONS_OFFSET = 152;
const POSITION_SIZE = 24;
const FUNDING_CHECKPOINT_OFFSET = 920; // BPF: i128 8-byte aligned, no 16-byte padding before this field
const FUNDING_CHECKPOINT_SIZE = 16;

export function decodePosition(
  view: DataView,
  baseOffset: number,
): Position {
  return {
    instrumentId: view.getUint16(baseOffset, true),
    qty: view.getBigInt64(baseOffset + 8, true),
    entryVwap: view.getBigInt64(baseOffset + 16, true),
  };
}

export function decodePortfolio(data: Uint8Array): PortfolioState {
  if (data.length < PORTFOLIO_SIZE) {
    throw new Error(
      `decodePortfolio: buffer too small (${data.length} < ${PORTFOLIO_SIZE})`,
    );
  }
  const view = new DataView(data.buffer, data.byteOffset, PORTFOLIO_SIZE);

  const userBytes = new Uint8Array(data.buffer, data.byteOffset, 32);

  const positionsLen = view.getUint16(144, true);
  const positions: Position[] = [];
  for (let i = 0; i < positionsLen; i++) {
    const off = POSITIONS_OFFSET + i * POSITION_SIZE;
    positions.push(decodePosition(view, off));
  }

  const lastFundingCheckpoint: bigint[] = [];
  for (let i = 0; i < MAX_INSTRUMENTS; i++) {
    const off = FUNDING_CHECKPOINT_OFFSET + i * FUNDING_CHECKPOINT_SIZE;
    lastFundingCheckpoint.push(readI128(view, off));
  }

  return {
    user: new PublicKey(userBytes),
    equity: readI128(view, 32),
    principal: readI128(view, 48),
    pnl: readI128(view, 64),
    im: readU128(view, 80),
    mm: readU128(view, 96),
    freeCollateral: readI128(view, 112),
    health: readI128(view, 128),
    positionsLen,
    positions,
    lastFundingCheckpoint,
        lastBatchId: view.getBigUint64(1432, true),
    lastSlot: view.getBigUint64(1440, true),
    bump: view.getUint8(1448),
  };
}
