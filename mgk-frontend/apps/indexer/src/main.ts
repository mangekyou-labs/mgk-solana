import Fastify from 'fastify';
import { Connection, PublicKey } from '@solana/web3.js';
import { WebSocketServer } from 'ws';
import { createStore } from './store.js';
import { healthRoutes } from './rest/health.js';
import { marketsRoutes, candlesRoutes, tradesRoutes, bookRoutes, batchRoutes, userFillsRoutes } from './rest/routes.js';
import { createSubscriber } from './subscriber.js';
import { createWsServer, broadcastFill, broadcastBatch } from './ws.js';
import { backfillOnBoot } from './backfill.js';
import { aggregateCandles } from './aggregator.js';

const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? '0.0.0.0';
const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';
const RPC_URL = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const CORE_PROGRAM_ID = process.env.CORE_PROGRAM_ID ?? 'CzWqtmcrm6sivjNHfNWhoMJfxP7ibm8KqXXjZpkswXy5';
const MATCHER_PROGRAM_ID = process.env.MATCHER_PROGRAM_ID ?? 'AU4EKQAQupEbMWPK9fuJA7CZqfcjM5Bpgf6Ew9Y7o2FF';
const DB_PATH = process.env.DB_PATH ?? 'mgk-indexer.db';

async function main(): Promise<void> {
  const app = Fastify({
    logger: { level: LOG_LEVEL },
    disableRequestLogging: false,
  });

  const store = createStore(DB_PATH);
  const connection = new Connection(RPC_URL, 'confirmed');
  const corePk = new PublicKey(CORE_PROGRAM_ID);
  const matcherPk = new PublicKey(MATCHER_PROGRAM_ID);

  await healthRoutes(app);
  await marketsRoutes(app, store);
  await candlesRoutes(app, store);
  await tradesRoutes(app, store);
  await bookRoutes(app, store, { connection, matcherProgramId: MATCHER_PROGRAM_ID });
  await batchRoutes(app, store);
  await userFillsRoutes(app, store);

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
    const backfillResult = await backfillOnBoot(connection, store, corePk, matcherPk, 1000);
    app.log.info({ backfillResult }, 'backfill complete');

    subscriber.start();
    app.log.info('subscriber started');

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
