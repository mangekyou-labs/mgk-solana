'use client';

import { Connection, PublicKey } from '@solana/web3.js';
import * as sdk from '@mgk/sdk';

import { config } from '@/lib/config';

export function resolveRegistryAddress(
  programId: PublicKey,
  registryAddress: PublicKey | null = config.registryAddress,
): PublicKey {
  return registryAddress ?? sdk.deriveRegistryPda(programId)[0];
}

/**
 * Find the open (Collecting/Committing) batch PDA.
 *
 * Registry `batch_id_counter` is usually `openId + 1`, but can lag after
 * partial settles — scan a small window around the counter.
 */
export async function resolveOpenBatch(params: {
  connection: Connection;
  programId: PublicKey;
  batchIdCounter: bigint;
  batchAddress?: PublicKey | null;
  indexerUrl?: string;
  /** Include the current batch after collection for read-only status displays. */
  includeCompletedPhases?: boolean;
}): Promise<{ batchPda: PublicKey; batchId: bigint; batch: sdk.state.BatchState }> {
  const includeCompletedPhases = params.includeCompletedPhases ?? false;

  const isUsable = (batch: sdk.state.BatchState): boolean => {
    if (batch.status === sdk.state.BatchStatus.Collecting) return true;
    return includeCompletedPhases && (
      batch.status === sdk.state.BatchStatus.Revealing ||
      batch.status === sdk.state.BatchStatus.Clearing ||
      batch.status === sdk.state.BatchStatus.Settled
    );
  };

  if (params.batchAddress) {
    const acc = await params.connection.getAccountInfo(params.batchAddress);
    if (!acc) {
      throw new Error('Configured batch address not found on-chain.');
    }
    const batch = sdk.state.decodeBatch(new Uint8Array(acc.data));
    if (!isUsable(batch)) {
      throw new Error(
        'No open collecting batch found. Wait for the keeper to open the next window.',
      );
    }
    return {
      batchPda: params.batchAddress,
      batchId: batch.batchId,
      batch,
    };
  }

  const indexerBatch = await fetchIndexerBatchAddress(
    params.batchIdCounter > 0n ? params.batchIdCounter - 1n : 0n,
    params.indexerUrl ?? config.indexerUrl,
  );
  if (indexerBatch) {
    const acc = await params.connection.getAccountInfo(indexerBatch);
    if (acc) {
      const batch = sdk.state.decodeBatch(new Uint8Array(acc.data));
      if (isUsable(batch)) {
        return { batchPda: indexerBatch, batchId: batch.batchId, batch };
      }
    }
  }

  const c = params.batchIdCounter;
  const candidates: bigint[] = [];
  if (c > 0n) candidates.push(c - 1n);
  candidates.push(c);
  if (c > 1n) candidates.push(c - 2n);
  candidates.push(c + 1n);

  let best: { batchPda: PublicKey; batchId: bigint; batch: sdk.state.BatchState } | null =
    null;
  for (const id of candidates) {
    const [pda] = sdk.deriveBatchPda(id, params.programId);
    const acc = await params.connection.getAccountInfo(pda);
    if (!acc || acc.data.length < sdk.state.BATCH_SIZE) continue;
    const batch = sdk.state.decodeBatch(new Uint8Array(acc.data));
    if (!isUsable(batch)) continue;
    if (!best || batch.batchId > best.batchId) {
      best = { batchPda: pda, batchId: batch.batchId, batch };
    }
  }
  if (!best) {
    throw new Error(
      'No open collecting batch found. Wait for the keeper to open the next window.',
    );
  }
  return best;
}


export async function fetchIndexerBatchAddress(
  expectedBatchId: bigint,
  indexerUrl = config.indexerUrl,
): Promise<PublicKey | null> {
  if (!indexerUrl) return null;
  try {
    const res = await fetch(`${indexerUrl}/api/batch/current`, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) return null;

    const body = (await res.json()) as Record<string, unknown>;
    const batchAddress = body.batchAddress ?? body.batch_address;
    if (typeof batchAddress !== 'string') return null;

    // Trust the indexer's batch address even when batch IDs diverge.  The
    // indexer tracks the keeper's keypair-based batch directly; the registry
    // counter may race ahead during SettleBatch → CreateBatch transitions.
    return new PublicKey(batchAddress);
  } catch {
    return null;
  }
}

export async function resolveBatchAddress(params: {
  batchId: bigint;
  programId: PublicKey;
  batchAddress?: PublicKey | null;
  indexerUrl?: string;
}): Promise<PublicKey> {
  if (params.batchAddress) return params.batchAddress;

  const indexerBatch = await fetchIndexerBatchAddress(
    params.batchId,
    params.indexerUrl ?? config.indexerUrl,
  );
  if (indexerBatch) return indexerBatch;

  return sdk.deriveBatchPda(params.batchId, params.programId)[0];
}
