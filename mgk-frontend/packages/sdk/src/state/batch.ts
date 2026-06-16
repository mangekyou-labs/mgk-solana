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
  };
}
