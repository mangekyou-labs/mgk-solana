import { BATCH_SIZE, readU128, type BatchState, type BatchStatus } from './types.js';

export function decodeBatch(data: Uint8Array): BatchState {
  if (data.length < BATCH_SIZE) {
    throw new Error(
      `decodeBatch: buffer too small (${data.length} < ${BATCH_SIZE})`,
    );
  }
  const view = new DataView(data.buffer, data.byteOffset, BATCH_SIZE);

  return {
    batchId: view.getBigUint64(0, true),
    status: view.getUint8(8) as BatchStatus,
    commitDeadlineSlot: view.getBigUint64(16, true),
    revealDeadlineSlot: view.getBigUint64(24, true),
    closeSlot: view.getBigUint64(32, true),
    shuffleSeed: view.getBigUint64(40, true),
    clearingPrice: view.getBigInt64(48, true),
    totalCommitments: view.getUint32(56, true),
    totalRevealed: view.getUint32(60, true),
    totalSettled: view.getUint32(64, true),
    totalVolume: view.getBigUint64(72, true),
    totalNotional: readU128(view, 80),
    slashedDeposits: readU128(view, 96),
    bump: view.getUint8(112),
    // DFBA fields at offset 120 (after 120-byte legacy header + padding to 120)
    bidClearingPrice: view.getBigInt64(120, true),
    askClearingPrice: view.getBigInt64(128, true),
    matchedBidQty: view.getBigUint64(136, true),
    matchedAskQty: view.getBigUint64(144, true),
    markValid: view.getUint8(152) !== 0,
    liqPaused: view.getUint8(153) !== 0,
  };
}

/** DFBA dual-clear results account header (matcher DfbaClear output). */
export const DFBA_RESULTS_HEADER_SIZE = 34;
export const DFBA_FILL_SIZE = 58;

export interface DfbaClearResult {
  bidClearingPrice: bigint;
  askClearingPrice: bigint;
  matchedBidQty: bigint;
  matchedAskQty: bigint;
  numFills: number;
}

export function decodeDfbaResultsHeader(data: Uint8Array): DfbaClearResult {
  if (data.length < DFBA_RESULTS_HEADER_SIZE) {
    throw new Error(
      `decodeDfbaResultsHeader: buffer too small (${data.length} < ${DFBA_RESULTS_HEADER_SIZE})`,
    );
  }
  const view = new DataView(data.buffer, data.byteOffset, DFBA_RESULTS_HEADER_SIZE);
  return {
    bidClearingPrice: view.getBigInt64(0, true),
    askClearingPrice: view.getBigInt64(8, true),
    matchedBidQty: view.getBigUint64(16, true),
    matchedAskQty: view.getBigUint64(24, true),
    numFills: view.getUint16(32, true),
  };
}
