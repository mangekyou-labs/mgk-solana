import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { WebSocketServer } from 'ws';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createStore } from './store.js';
import { healthRoutes } from './rest/health.js';
import { marketsRoutes, candlesRoutes, tradesRoutes, bookRoutes, batchRoutes, userFillsRoutes } from './rest/routes.js';
import { portfolioRoutes } from './rest/portfolio.js';
import { createSubscriber } from './subscriber.js';
import { createWsServer, broadcastFill, broadcastBatch } from './ws.js';
import { backfillOnBoot } from './backfill.js';
import { aggregateCandles } from './aggregator.js';
import { startKeeper } from './keeper.js';

const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? '0.0.0.0';
const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';
const RPC_URL = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
// 2026-06-29: Fresh deploy to 3jYQ4mpW... after closing CThnLgZ... (stale registry cleanup)
const CORE_PROGRAM_ID = process.env.CORE_PROGRAM_ID ?? '3jYQ4mpWBBtwrzYQ4zzKhgqVcWWsG2HpXi9oXTBpekja';
const MATCHER_PROGRAM_ID = process.env.MATCHER_PROGRAM_ID ?? 'AU4EKQAQupEbMWPK9fuJA7CZqfcjM5Bpgf6Ew9Y7o2FF';
const DB_PATH = process.env.DB_PATH ?? 'mgk-indexer.db';

function loadPersistedBatchAddress(): string | undefined {
  try {
    const home = process.env.HOME ?? '/root';
    const raw = JSON.parse(
      readFileSync(join(home, '.config', 'solana', 'mgk-batch-keypair.json'), 'utf8'),
    );
    return Keypair.fromSecretKey(Buffer.from(raw)).publicKey.toBase58();
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const app = Fastify({
    logger: { level: LOG_LEVEL },
    disableRequestLogging: false,
  });

  await app.register(cors, { origin: true });

  const store = createStore(DB_PATH);
  const connection = new Connection(RPC_URL, 'confirmed');
  const corePk = new PublicKey(CORE_PROGRAM_ID);
  const matcherPk = new PublicKey(MATCHER_PROGRAM_ID);
  const REGISTRY_ADDRESS = process.env.REGISTRY_ADDRESS;
  const VAULT_ADDRESS = process.env.VAULT_ADDRESS;
  const BATCH_ADDRESS = process.env.BATCH_ADDRESS;
  const INSTRUMENT_ADDRESS = process.env.INSTRUMENT_ADDRESS;
  const BOOK_ADDRESS = process.env.BOOK_ADDRESS;
  const RESULTS_ADDRESS = process.env.RESULTS_ADDRESS;
  const activeBatch = { address: BATCH_ADDRESS ?? loadPersistedBatchAddress() };

  await healthRoutes(app);
  await marketsRoutes(app, store);
  await candlesRoutes(app, store);
  await tradesRoutes(app, store);
  await bookRoutes(app, store, {
    connection,
    matcherProgramId: MATCHER_PROGRAM_ID,
    bookAddress: BOOK_ADDRESS,
  });
  await batchRoutes(app, store, {
    connection,
    coreProgramId: CORE_PROGRAM_ID,
    registryAddress: REGISTRY_ADDRESS,
    getCurrentBatchAddress: () => activeBatch.address,
  });
  await userFillsRoutes(app, store);
  await portfolioRoutes(app, store);

  let wss: WebSocketServer | undefined;

  const subscriber = createSubscriber(
    { rpcUrl: RPC_URL, coreProgramId: CORE_PROGRAM_ID, matcherProgramId: MATCHER_PROGRAM_ID, instrumentIds: [0] },
    store,
    (fills: unknown[]) => {
      if (!wss) return;
      for (const fill of fills) {
        const f = fill as Record<string, unknown>;
        const instrumentId = typeof f.instrument_id === 'number' ? f.instrument_id : 0;
        broadcastFill(wss, instrumentId, fill);

        aggregateCandles(store, [
          {
            instrumentId,
            timestampMs: typeof f.slot === 'number' ? f.slot * 400 : Date.now(),
            price: BigInt(typeof f.price === 'number' ? f.price : 0),
            qty: BigInt(typeof f.qty === 'number' ? f.qty : 0),
          },
        ]);
      }
    },
    (event: unknown) => {
      if (!wss) return;
      broadcastBatch(wss, event);
    },
  );

  try {
    const address = await app.listen({ port: PORT, host: HOST });
    app.log.info({ address }, 'indexer listening');

    const httpServer = app.server;
    wss = createWsServer(httpServer, async (instrumentId: number) => {
      const trades = store.db
        .prepare('SELECT slot, price, qty, taker_side, is_maker FROM fills WHERE instrument_id = ? ORDER BY slot DESC LIMIT 50')
        .all(instrumentId);
      return { bids: [], asks: [], lastTrades: trades };
    });

    app.log.info('running backfill...');
    const backfillResult = process.env.SKIP_BACKFILL
      ? { slotsScanned: 0, txsMatched: 0, fillsInserted: 0, batchesInserted: 0 }
      : await backfillOnBoot(connection, store, corePk, matcherPk, 1000);
    app.log.info({ backfillResult }, 'backfill complete');

    subscriber.start();
    app.log.info('subscriber started');

    // Start the keeper loop (runs in same process, shares Connection + store)
    const KEEPER_POLL_MS = Number(process.env.KEEPER_POLL_MS ?? 5_000);
    const ORACLE_POLL_MS = Number(process.env.ORACLE_POLL_MS ?? 10_000);
    const ORACLE_PID = process.env.ORACLE_PROGRAM_ID ?? '6M9eEiDKy8imbDi44ZqquyfknNbveRjD4j9VnvYaHtmA';
    app.log.info({ REGISTRY_ADDRESS, CORE_PROGRAM_ID }, 'starting keeper');
    startKeeper({
      connection,
      corePid: corePk,
      matcherPid: matcherPk,
      oraclePid: new PublicKey(ORACLE_PID),
      registryAddress: REGISTRY_ADDRESS,
      vaultAddress: VAULT_ADDRESS,
      batchAddress: BATCH_ADDRESS,
      instrumentAddress: INSTRUMENT_ADDRESS,
      bookAddress: BOOK_ADDRESS,
      resultsAddress: RESULTS_ADDRESS,
      store,
      pollIntervalMs: KEEPER_POLL_MS,
      oraclePollMs: ORACLE_POLL_MS,
      onCurrentBatchAddress: (address) => {
        activeBatch.address = address;
      },
    });
    app.log.info('keeper started');

  } catch (err) {
    app.log.error({ err }, 'failed to start');
    process.exit(1);
  }

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      app.log.info({ sig }, 'shutting down');
      subscriber.stop();
      store.close();
      app.close().then(() => process.exit(0));
    });
  }
}

main();
