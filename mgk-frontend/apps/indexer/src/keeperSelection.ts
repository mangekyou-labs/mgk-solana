export interface BatchCandidate {
  address: string;
  batchId: bigint;
}

export type BatchCandidateSource = 'tracked' | 'scan';

export interface SelectedBatchCandidate {
  source: BatchCandidateSource;
  candidate: BatchCandidate;
}

/**
 * DFBA batches close on the configured time boundary. `n_min` controls the
 * live flow requirement, but does not make an expired empty batch immortal:
 * an empty batch must be able to clear and advance the lifecycle.
 */
export function shouldCloseCommitting(
  currentSlot: bigint,
  deadlineSlot: bigint,
  _totalCommitments: bigint,
  _nMin: bigint,
): boolean {
  return currentSlot >= deadlineSlot;
}

/**
 * Prefer the persisted keypair only when it still names the registry's active
 * batch. Otherwise use an exact active match discovered from program accounts.
 * Returning null is intentional: the caller may create a replacement only
 * after proving that no active account exists.
 */
export function selectActiveBatchCandidate(
  activeBatchId: bigint,
  tracked: BatchCandidate | null,
  discovered: readonly BatchCandidate[],
): SelectedBatchCandidate | null {
  if (tracked?.batchId === activeBatchId) {
    return { source: 'tracked', candidate: tracked };
  }

  const scanned = discovered.find((candidate) => candidate.batchId === activeBatchId);
  return scanned ? { source: 'scan', candidate: scanned } : null;
}
