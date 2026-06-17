import { Connection, PublicKey } from '@solana/web3.js';
import * as sdk from '@mgk/sdk';
import type { Store } from './store.js';
import { decodeBatchEvent, decodeFills } from './decoder.js';
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
 *   account[3] = results_account (holds CLOB matching results: 2-byte
 *   num_fills header + N×49-byte fill records).
 */
async function backfillTransactions(
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
        const accountKeys = msg.getAccountKeys();
        const staticKeys = accountKeys.staticAccountKeys;

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
          } else {
            continue;
          }

          if (parsed.length < 1) continue;
          if (parsed[0] !== 8) continue; // SettleBatch discriminator

          // Results account is at account index 3 (entrypoint L562)
          const resultsIdx = ix.accountKeyIndexes[3];
          if (resultsIdx === undefined || resultsIdx >= staticKeys.length) continue;
          const resultsPk = staticKeys[resultsIdx];
          if (!resultsPk) continue;

          // Fetch results account data from RPC to decode fills
          try {
            const accInfo = await connection.getAccountInfo(resultsPk, 'confirmed');
            if (!accInfo) continue;

            const fills = decodeFills(
              new Uint8Array(accInfo.data),
              slot,
              0n, // batchId — stored on batch account, not in inst data; post-MVP refinement
              0,  // instrumentId (SOL-USD only in v1)
              txResp.transaction.signatures[0] ?? `unknown-${slot}`,
              0,  // takerSide — not available from results account alone
            );

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

/**
 * Query the RPC for confirmed slots in the last `slotCount` slots.
 * Returns the list of slot numbers that have confirmed blocks.
 */
async function discoverSlots(
  connection: Connection,
  slotCount: number,
): Promise<number[]> {
  const currentSlot = await connection.getSlot('confirmed');
  const startSlot = Math.max(currentSlot - slotCount, 0);
  const MAX_RANGE = 5_000; // Solana getBlocks range cap

  const slots: number[] = [];
  for (let s = startSlot; s <= currentSlot; s += MAX_RANGE) {
    const end = Math.min(s + MAX_RANGE - 1, currentSlot);
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

  const slots = await discoverSlots(connection, slotCount);

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
