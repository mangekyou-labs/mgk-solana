'use client';

import { PublicKey } from '@solana/web3.js';
import * as sdk from '@mgk/sdk';

import { config } from '@/lib/config';

export function resolveRegistryAddress(
  programId: PublicKey,
  registryAddress: PublicKey | null = config.registryAddress,
): PublicKey {
  return registryAddress ?? sdk.deriveRegistryPda(programId)[0];
}

function parseBatchId(raw: unknown): bigint | null {
  if (typeof raw === 'string' && raw.length > 0) return BigInt(raw);
  if (typeof raw === 'number' && Number.isFinite(raw)) return BigInt(raw);
  return null;
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
    const batchId = parseBatchId(body.batchId ?? body.batch_id);
    const batchAddress = body.batchAddress ?? body.batch_address;
    if (batchId !== expectedBatchId || typeof batchAddress !== 'string') {
      return null;
    }
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
