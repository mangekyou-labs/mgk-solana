import { Connection, PublicKey } from '@solana/web3.js';
import * as sdk from '@mgk/sdk';
import type { Store } from './store.js';
import { decodeBatchEvent } from './decoder.js';

export interface SubscriberConfig {
  rpcUrl: string;
  coreProgramId: string;
  matcherProgramId: string;
  instrumentIds: number[];
}

interface Subscriber {
  start: () => void;
  stop: () => void;
}

export function createSubscriber(
  config: SubscriberConfig,
  store: Store,
  onFill?: (fills: unknown[]) => void,
  onBatchEvent?: (event: unknown) => void,
): Subscriber {
  const connection = new Connection(config.rpcUrl, 'confirmed');
  const corePk = new PublicKey(config.coreProgramId);
  const matcherPk = new PublicKey(config.matcherProgramId);

  let pollHandle: ReturnType<typeof setInterval> | null = null;
  let lastBatchId: bigint | null = null;
  let lastPhase: number | null = null;
  let lastFillSlot = 0;

  /** Broadcast any fills that appeared since the last poll cycle. */
  function broadcastNewFills() {
    if (!onFill) return;
    const rows = store.db.prepare(
      'SELECT * FROM fills WHERE slot > ? ORDER BY slot ASC',
    ).all(lastFillSlot) as Array<Record<string, unknown>>;
    for (const row of rows) {
      onFill([row]);
      lastFillSlot = Math.max(lastFillSlot, Number(row.slot));
    }
  }

  async function poll() {
    try {
      // Broadcast fills that arrived since last cycle (from backfill or previous polls)
      broadcastNewFills();
      const [registryPda] = sdk.deriveRegistryPda(corePk);
      const accounts = await connection.getMultipleAccountsInfo([registryPda]);
      const regData = accounts[0];
      if (!regData) return;

      const registry = sdk.state.decodeRegistry(new Uint8Array(regData.data));
      const batchId = registry.batchIdCounter;

      if (batchId === 0n) return;

      const [batchPda] = sdk.deriveBatchPda(batchId, corePk);
      const batchAccounts = await connection.getMultipleAccountsInfo([batchPda]);
      const batchData = batchAccounts[0];
      if (!batchData) return;

      const batch = sdk.state.decodeBatch(new Uint8Array(batchData.data));

      if (batchId !== lastBatchId || batch.status !== lastPhase) {
        const event = decodeBatchEvent(batch);
        store.insertBatchEvent.run([
          Number(event.batchId),
          event.ts,
          event.phase,
          event.numCommitments,
          Number(event.closeSlot),
          Number(event.vwap) / 1e6,
        ]);

        if (onBatchEvent) {
          onBatchEvent(event);
        }

        lastBatchId = batchId;
        lastPhase = batch.status;
      }
    } catch {
      // Silently retry on next poll
    }
  }

  return {
    start() {
      // Seed lastFillSlot from existing data so we don't broadcast old fills
      const row = store.db.prepare('SELECT MAX(slot) as slot FROM fills').get() as { slot: number | null } | undefined;
      lastFillSlot = row?.slot ?? 0;
      pollHandle = setInterval(poll, 10_000);
      void poll();
    },
    stop() {
      if (pollHandle) {
        clearInterval(pollHandle);
        pollHandle = null;
      }
    },
  };
}
