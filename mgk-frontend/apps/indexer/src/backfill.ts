import { Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import * as sdk from '@mgk/sdk';
import type { Store } from './store.js';
import { decodeBatchEvent, decodeDfbaFills, decodeFills } from './decoder.js';
import { aggregateCandles } from './aggregator.js';

export interface BackfillResult {
  /** Slots scanned via getBlocks + getBlock */
  slotsScanned: number;
  /** Transactions found that touch mgk programs */
  txsMatched: number;
  /** Fills decoded from results accounts and stored */
  fillsInserted: number;
  /** Batch events inserted from PDA polling */
  batchesInserted: number;
}

// ── batch event catchup ════════════════════════════════════════════

/**
 * Walk backward from the latest batch ID, decode each Batch PDA, and insert
 * any batch_events rows that are missing from SQLite.
 */
async function backfillBatchEvents(
  connection: Connection,
  store: Store,
  corePk: PublicKey,
): Promise<number> {
  let inserted = 0;

  try {
    const [registryPda] = sdk.deriveRegistryPda(corePk);
    const accounts = await connection.getMultipleAccountsInfo([registryPda]);
    const regData = accounts[0];
    if (!regData) return 0;

    const registry = sdk.state.decodeRegistry(new Uint8Array(regData.data));
    const latestBatchId = registry.batchIdCounter;

    if (latestBatchId === 0n) return 0;

    for (let bid = latestBatchId; bid > 0n; bid--) {
      const [batchPda] = sdk.deriveBatchPda(bid, corePk);
      const batchAccounts = await connection.getMultipleAccountsInfo([batchPda]);
      const batchData = batchAccounts[0];
      if (!batchData) continue;

      const batch = sdk.state.decodeBatch(new Uint8Array(batchData.data));
      const event = decodeBatchEvent(batch);

      store.insertBatchEvent.run([
        Number(event.batchId),
        event.ts,
        event.phase,
        event.numCommitments,
        Number(event.closeSlot),
        Number(event.vwap) / 1e6,
      ]);
      inserted++;
    }
  } catch {
    // Silently continue — batch events are best-effort on backfill
  }

  return inserted;
}

// ── transaction-level backfill ═════════════════════════════════════

/**
 * Walk each confirmed slot, fetch its block, find transactions that invoke
 * mgk programs, and extract fills from SettleBatch instructions.
 *
 * SettleBatch (disc 8) account layout per entrypoint L559–562:
 *   account[0] = batch, account[3] = results_account. The results account is
 *   decoded as DFBA when the batch carries dual-auction state, with the
 *   legacy CLOB format retained for older settled batches.
 */
export async function backfillTransactions(
  connection: Connection,
  store: Store,
  corePk: PublicKey,
  matcherPk: PublicKey,
  blockSlots: number[],
): Promise<{ txsMatched: number; fillsInserted: number }> {
  let txsMatched = 0;
  let fillsInserted = 0;

  for (const slot of blockSlots) {
    try {
      const block = await connection.getBlock(slot, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });

      if (!block?.transactions) continue;

      for (const txResp of block.transactions) {
        const msg = txResp.transaction.message;
        const staticKeys: PublicKey[] = 'staticAccountKeys' in msg && Array.isArray(msg.staticAccountKeys)
          ? (msg.staticAccountKeys as PublicKey[])
          : 'accountKeys' in msg && Array.isArray(msg.accountKeys)
            ? (msg.accountKeys as PublicKey[])
            : [];

        // Quick filter: does this tx reference either program?
        const hasCore = staticKeys.some((k) => k.equals(corePk));
        const hasMatcher = staticKeys.some((k) => k.equals(matcherPk));

        if (!hasCore && !hasMatcher) continue;

        txsMatched++;

        const compiledIxs = msg.compiledInstructions;
        for (const ix of compiledIxs) {
          const progKey = staticKeys[ix.programIdIndex];
          if (!progKey || !progKey.equals(corePk)) continue;

          const data = ix.data;
          let parsed: Uint8Array;
          if (data instanceof Uint8Array || Buffer.isBuffer(data)) {
            parsed = new Uint8Array(data);
          } else if (typeof data === 'string') {
            parsed = bs58.decode(data);
          } else {
            continue;
          }

          if (parsed.length < 1) continue;
          if (parsed[0] !== 8) continue; // SettleBatch discriminator

          // The batch account supplies both the persisted batch ID and the
          // format discriminator. DFBA results reuse the old results account
          // address slot but move num_fills to the 34-byte header.
          const batchIdx = ix.accountKeyIndexes[0];
          const batchPk = batchIdx === undefined ? undefined : staticKeys[batchIdx];
          let batchId = 0n;
          let isDfba = false;
          if (batchPk) {
            const batchInfo = await connection.getAccountInfo(batchPk, 'confirmed');
            if (batchInfo) {
              const batch = sdk.state.decodeBatch(new Uint8Array(batchInfo.data));
              batchId = batch.batchId;
              isDfba = batch.markValid || batch.matchedBidQty > 0n || batch.matchedAskQty > 0n;
            }
          }

          // Results account is at account index 3 (entrypoint L562)
          const resultsIdx = ix.accountKeyIndexes[3];
          if (resultsIdx === undefined || resultsIdx >= staticKeys.length) continue;
          const resultsPk = staticKeys[resultsIdx];
          if (!resultsPk) continue;

          // Fetch results account data from RPC to decode fills
          try {
            const accInfo = await connection.getAccountInfo(resultsPk, 'confirmed');
            if (!accInfo) continue;

            const signature = txResp.transaction.signatures[0] ?? `unknown-${slot}`;
            const resultsData = new Uint8Array(accInfo.data);
            const fills = isDfba
              ? decodeDfbaFills(resultsData, slot, batchId, 0, signature)
              : decodeFills(resultsData, slot, batchId, 0, signature, 0);

            for (const fill of fills) {
              store.insertFill.run([
                fill.slot,
                Number(fill.batchId),
                fill.instrumentId,
                fill.takerSide,
                Number(fill.price),
                Number(fill.qty),
                Buffer.from(fill.takerPubkey),
                Buffer.from(fill.makerPubkey),
                Buffer.from(fill.txSignature, 'utf-8'),
                fill.isMaker ? 1 : 0,
              ]);

              aggregateCandles(store, [
                {
                  instrumentId: fill.instrumentId,
                  timestampMs: slot * 400, // approximate: ~400ms/slot
                  price: fill.price,
                  qty: fill.qty,
                },
              ]);
              fillsInserted++;
            }
          } catch {
            // Results account may be stale or unavailable — skip
          }
        }
      }
    } catch {
      // Individual block fetch failures are non-fatal
    }
  }

  return { txsMatched, fillsInserted };
}

// ── slot discovery ═════════════════════════════════════════════════

/** Return unique, ascending signature slots in the requested window. */
export function recentSignatureSlots(
  entries: ReadonlyArray<{ slot: number | null | undefined }>,
  startSlot: number,
): number[] {
  return [...new Set(
    entries.flatMap(({ slot }) =>
      slot !== null && slot !== undefined && slot >= startSlot ? [slot] : [],
    ),
  )].sort((a, b) => a - b);
}

/** Build inclusive RPC ranges without exceeding the provider's range cap. */
export function splitSlotRanges(
  startSlot: number,
  endSlot: number,
  maxRange: number,
): Array<[number, number]> {
  if (startSlot > endSlot) return [];
  const width = Math.max(1, Math.floor(maxRange));
  const ranges: Array<[number, number]> = [];
  for (let start = startSlot; start <= endSlot; start += width) {
    ranges.push([start, Math.min(start + width - 1, endSlot)]);
  }
  return ranges;
}

/**
 * Query the RPC for confirmed slots in the last `slotCount` slots.
 * Returns the list of slot numbers that have confirmed blocks.
 */
export async function discoverSlots(
  connection: Connection,
  slotCount: number,
  programAddresses: PublicKey[] = [],
): Promise<number[]> {
  const currentSlot = await connection.getSlot('confirmed');
  const startSlot = Math.max(currentSlot - slotCount, 0);

  // Signature history is one request per program and avoids provider-specific
  // getBlocks range caps. A block scan remains as a compatibility fallback for
  // RPCs that do not expose signature history.
  if (programAddresses.length > 0) {
    const signatures: Array<{ slot: number | null | undefined }> = [];
    for (const address of programAddresses) {
      try {
        const found = await connection.getSignaturesForAddress(
          address,
          { limit: 1_000 },
          'confirmed',
        );
        signatures.push(...found);
        if (process.env.DEBUG_BACKFILL) {
          console.log(JSON.stringify({
            event: 'backfill_signature_history',
            address: address.toBase58(),
            count: found.length,
          }));
        }
      } catch (error) {
        if (process.env.DEBUG_BACKFILL) {
          console.log(JSON.stringify({
            event: 'backfill_signature_history_error',
            address: address.toBase58(),
            name: error instanceof Error ? error.name : 'unknown',
          }));
        }
        // Try the block fallback below when signature history is unavailable.
      }
    }
    const signatureSlots = recentSignatureSlots(signatures, startSlot);
    if (process.env.DEBUG_BACKFILL) {
      console.log(JSON.stringify({
        event: 'backfill_signature_slots',
        currentSlot,
        startSlot,
        count: signatureSlots.length,
      }));
    }
    if (signatureSlots.length > 0) return signatureSlots;
  }

  // The selected working-devnet provider currently caps getBlocks ranges at
  // five slots. Keep this conservative across fallback RPCs; it costs more
  // requests but prevents a silent zero-slot backfill on that endpoint.
  const MAX_RANGE = 5;

  const slots: number[] = [];
  for (const [s, end] of splitSlotRanges(startSlot, currentSlot, MAX_RANGE)) {
    try {
      const batch = await connection.getBlocks(s, end, 'confirmed');
      slots.push(...batch);
    } catch {
      // Skip ranges that fail
    }
  }

  return slots;
}

// ── public entry point ═════════════════════════════════════════════

/**
 * Run backfill on indexer boot: catch up on batch events, then walk
 * recent slots and replay transactions that touch mgk programs.
 */
export async function backfillOnBoot(
  connection: Connection,
  store: Store,
  corePk: PublicKey,
  matcherPk: PublicKey,
  slotCount = 1000,
): Promise<BackfillResult> {
  const batchesInserted = await backfillBatchEvents(connection, store, corePk);

  const slots = await discoverSlots(connection, slotCount, [corePk, matcherPk]);

  const { txsMatched, fillsInserted } = await backfillTransactions(
    connection,
    store,
    corePk,
    matcherPk,
    slots,
  );

  return {
    slotsScanned: slots.length,
    txsMatched,
    fillsInserted,
    batchesInserted,
  };
}
