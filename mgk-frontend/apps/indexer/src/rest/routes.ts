import type { FastifyInstance } from 'fastify';
import type { Store } from '../store.js';
import { Connection, PublicKey } from '@solana/web3.js';
import * as sdk from '@mgk/sdk';

export async function marketsRoutes(app: FastifyInstance, store: Store): Promise<void> {
  app.get('/api/markets', async () => {
    const rows = store.db.prepare('SELECT * FROM market_state ORDER BY instrument_id').all();
    return { markets: rows };
  });

  app.get<{ Params: { id: string } }>(
    '/api/markets/:id/state',
    async (req, reply) => {
      const row = store.db
        .prepare('SELECT * FROM market_state WHERE instrument_id = ?')
        .get(Number(req.params.id));
      if (!row) {
        return reply.code(404).send({ error: 'market not found' });
      }
      return row;
    },
  );
}

export async function candlesRoutes(app: FastifyInstance, store: Store): Promise<void> {
  app.get<{ Params: { id: string }; Querystring: { resolution?: string; from?: string; to?: string } }>(
    '/api/markets/:id/candles',
    async (req) => {
      const resolution = req.query.resolution ?? '1m';
      const table = `candles_${resolution}`;
      const from = req.query.from ? Number(req.query.from) : 0;
      const to = req.query.to ? Number(req.query.to) : Math.floor(Date.now() / 1000);

      const rows = store.db.prepare(`
        SELECT * FROM ${table}
        WHERE instrument_id = ? AND open_ts >= ? AND open_ts <= ?
        ORDER BY open_ts ASC
        LIMIT 1000
      `).all(Number(req.params.id), from, to);

      return { candles: rows };
    },
  );
}

export async function tradesRoutes(app: FastifyInstance, store: Store): Promise<void> {
  app.get<{ Params: { id: string }; Querystring: { limit?: string; before?: string } }>(
    '/api/markets/:id/trades',
    async (req) => {
      const limit = Math.min(Number(req.query.limit ?? 200), 200);
      const before = req.query.before ? Number(req.query.before) : 1e20;

      const rows = store.db.prepare(`
        SELECT slot, batch_id, price, qty, taker_side, is_maker
        FROM fills
        WHERE instrument_id = ? AND slot < ?
        ORDER BY slot DESC
        LIMIT ?
      `).all(Number(req.params.id), before, limit);

      return { trades: rows };
    },
  );
}

export interface BookRouteConfig {
  /** Solana RPC connection. When omitted, returns empty stub (test mode). */
  connection?: Connection;
  /** Matcher program public key. Required if connection is provided. */
  matcherProgramId?: string;
}

export async function bookRoutes(
  app: FastifyInstance,
  store: Store,
  cfg: BookRouteConfig = {},
): Promise<void> {
  const { connection, matcherProgramId } = cfg;
  let matcherPk: PublicKey | null = null;
  if (matcherProgramId) {
    try {
      matcherPk = new PublicKey(matcherProgramId);
    } catch {
      app.log.warn({ matcherProgramId }, 'bookRoutes: invalid matcherProgramId, serving stubs');
    }
  }

  // Cache the book PDA response for 3 seconds to avoid hammering RPC
  let cachedBook: { bids: sdk.state.BookLevel[]; asks: sdk.state.BookLevel[] } | null = null;
  let cachedAt = 0;

  app.get<{ Params: { id: string } }>(
    '/api/markets/:id/book',
    async (req) => {
      const instrumentId = Number(req.params.id);

      if (!connection || !matcherPk) {
        return { bids: [], asks: [] };
      }

      const now = Date.now();
      if (cachedBook && now - cachedAt < 3000) {
        return cachedBook;
      }

      try {
        const [bookPda] = sdk.deriveBookPda(instrumentId, matcherPk);
        const accounts = await connection.getMultipleAccountsInfo([bookPda]);
        const acc = accounts[0] ?? null;
        if (!acc) {
          cachedAt = now;
          cachedBook = { bids: [], asks: [] };
          return cachedBook;
        }

        const book = sdk.state.decodeBookHeader(new Uint8Array(acc.data));
        const bids = book.bids.filter((l) => l.orderCount > 0);
        const asks = book.asks.filter((l) => l.orderCount > 0);
        bids.sort((a, b) => (b.price > a.price ? 1 : b.price < a.price ? -1 : 0));
        asks.sort((a, b) => (a.price > b.price ? 1 : a.price < b.price ? -1 : 0));

        cachedBook = {
          bids: bids.slice(0, 20).map((l) => ({
            price: l.price,
            totalQty: l.totalQty,
            orderCount: l.orderCount,
            firstOrderOffset: l.firstOrderOffset,
          })),
          asks: asks.slice(0, 20).map((l) => ({
            price: l.price,
            totalQty: l.totalQty,
            orderCount: l.orderCount,
            firstOrderOffset: l.firstOrderOffset,
          })),
        };
        cachedAt = now;
        return cachedBook;
      } catch (err) {
        app.log.warn({ err, instrumentId }, 'bookRoutes: RPC fetch failed, returning stubs');
        return { bids: [], asks: [] };
      }
    },
  );
}

export async function batchRoutes(app: FastifyInstance, store: Store): Promise<void> {
  app.get('/api/batch/current', async () => {
    const row = store.db.prepare('SELECT * FROM batch_events ORDER BY batch_id DESC, phase DESC LIMIT 1').get();
    return row ?? { phase: -1 };
  });
}
