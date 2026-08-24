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
  /** Devnet override for keypair-owned book accounts. */
  bookAddress?: string;
}

interface BookLevelResponse {
  price: string;
  totalQty: string;
  orderCount: number;
  firstOrderOffset: number;
}

function serializeBookLevel(level: sdk.state.BookLevel): BookLevelResponse {
  return {
    price: level.price.toString(),
    totalQty: level.totalQty.toString(),
    orderCount: level.orderCount,
    firstOrderOffset: level.firstOrderOffset,
  };
}

export async function bookRoutes(
  app: FastifyInstance,
  store: Store,
  cfg: BookRouteConfig = {},
): Promise<void> {
  const { connection, matcherProgramId, bookAddress } = cfg;
  let matcherPk: PublicKey | null = null;
  let bookPk: PublicKey | null = null;
  if (matcherProgramId) {
    try {
      matcherPk = new PublicKey(matcherProgramId);
    } catch {
      app.log.warn({ matcherProgramId }, 'bookRoutes: invalid matcherProgramId, serving stubs');
    }
  }
  if (bookAddress) {
    try {
      bookPk = new PublicKey(bookAddress);
    } catch {
      app.log.warn({ bookAddress }, 'bookRoutes: invalid bookAddress, falling back to PDA');
    }
  }

  // Cache the book PDA response for 3 seconds to avoid hammering RPC
  let cachedBook: { bids: BookLevelResponse[]; asks: BookLevelResponse[] } | null = null;
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
        const bookAccount = bookPk ?? sdk.deriveBookPda(instrumentId, matcherPk)[0];
        const accounts = await connection.getMultipleAccountsInfo([bookAccount]);
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
          bids: bids.slice(0, 20).map(serializeBookLevel),
          asks: asks.slice(0, 20).map(serializeBookLevel),
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

export interface BatchRouteConfig {
  connection?: Connection;
  coreProgramId?: string;
  registryAddress?: string;
  getCurrentBatchAddress?: () => string | undefined;
}

async function findLiveBatchAccount(
  connection: Connection,
  coreProgramId: PublicKey,
  activeBatchId: bigint,
): Promise<{ address: PublicKey; batch: sdk.state.BatchState } | null> {
  const accounts = await connection.getProgramAccounts(coreProgramId, {
    filters: [{ dataSize: sdk.state.BATCH_SIZE }],
    encoding: 'base64',
  });

  for (const { pubkey, account } of accounts) {
    try {
      const batch = sdk.state.decodeBatch(new Uint8Array(account.data));
      if (batch.batchId === activeBatchId) {
        return { address: pubkey, batch };
      }
    } catch {
      // Ignore non-batch accounts that happen to share the same byte length.
    }
  }

  return null;
}

function batchStateToJson(batch: sdk.state.BatchState, batchAddress: string): Record<string, unknown> {
  return {
    source: 'rpc',
    batch_address: batchAddress,
    batchAddress,
    batch_id: Number(batch.batchId),
    batchId: batch.batchId.toString(),
    phase: batch.status,
    status: batch.status,
    commit_deadline_slot: Number(batch.commitDeadlineSlot),
    commitDeadlineSlot: batch.commitDeadlineSlot.toString(),
    reveal_deadline_slot: Number(batch.revealDeadlineSlot),
    revealDeadlineSlot: batch.revealDeadlineSlot.toString(),
    close_slot: Number(batch.closeSlot),
    closeSlot: batch.closeSlot.toString(),
    shuffle_seed: batch.shuffleSeed.toString(),
    shuffleSeed: batch.shuffleSeed.toString(),
    clearing_price: batch.clearingPrice.toString(),
    clearingPrice: batch.clearingPrice.toString(),
    total_commitments: batch.totalCommitments,
    totalCommitments: batch.totalCommitments,
    total_revealed: batch.totalRevealed,
    totalRevealed: batch.totalRevealed,
    total_settled: batch.totalSettled,
    totalSettled: batch.totalSettled,
    total_volume: batch.totalVolume.toString(),
    totalVolume: batch.totalVolume.toString(),
    total_notional: batch.totalNotional.toString(),
    totalNotional: batch.totalNotional.toString(),
  };
}

export async function batchRoutes(
  app: FastifyInstance,
  store: Store,
  cfg: BatchRouteConfig = {},
): Promise<void> {
  let cachedLiveBatch: Record<string, unknown> | null = null;
  let cachedLiveBatchAt = 0;
  const LIVE_BATCH_CACHE_MS = 1_000;

  app.get('/api/batch/current', async () => {
    const { connection, coreProgramId, registryAddress, getCurrentBatchAddress } = cfg;

    if (connection && coreProgramId) {
      const now = Date.now();
      const currentBatchAddress = getCurrentBatchAddress?.();
      if (
        cachedLiveBatch &&
        now - cachedLiveBatchAt < LIVE_BATCH_CACHE_MS &&
        (!currentBatchAddress || cachedLiveBatch.batchAddress === currentBatchAddress)
      ) {
        return cachedLiveBatch;
      }

      try {
        const corePk = new PublicKey(coreProgramId);
        const registryPk = registryAddress
          ? new PublicKey(registryAddress)
          : sdk.deriveRegistryPda(corePk)[0];
        const registryInfo = await connection.getAccountInfo(registryPk, 'confirmed');
        if (!registryInfo) {
          return { phase: -1, source: 'rpc', error: 'registry not found' };
        }

        const registry = sdk.state.decodeRegistry(new Uint8Array(registryInfo.data));
        if (registry.batchIdCounter === 0n) {
          return {
            phase: -1,
            source: 'rpc',
            registry_address: registryPk.toBase58(),
            batch_id_counter: '0',
          };
        }

        const activeBatchId = registry.batchIdCounter - 1n;
        const configuredBatch = getCurrentBatchAddress?.();
        const candidateAddresses: PublicKey[] = [];
        if (configuredBatch) {
          candidateAddresses.push(new PublicKey(configuredBatch));
        }
        const derivedBatch = sdk.deriveBatchPda(activeBatchId, corePk)[0];
        if (!candidateAddresses.some((pk) => pk.equals(derivedBatch))) {
          candidateAddresses.push(derivedBatch);
        }

        for (const batchPk of candidateAddresses) {
          const batchInfo = await connection.getAccountInfo(batchPk, 'confirmed');
          if (!batchInfo) continue;

          const batch = sdk.state.decodeBatch(new Uint8Array(batchInfo.data));
          if (batch.batchId !== activeBatchId) {
            app.log.warn(
              {
                configuredBatch: batchPk.toBase58(),
                decodedBatchId: batch.batchId.toString(),
                activeBatchId: activeBatchId.toString(),
              },
              'batchRoutes: ignoring stale batch account',
            );
            continue;
          }

          cachedLiveBatch = {
            ...batchStateToJson(batch, batchPk.toBase58()),
            registry_address: registryPk.toBase58(),
            batch_id_counter: registry.batchIdCounter.toString(),
          };
          cachedLiveBatchAt = now;
          return cachedLiveBatch;
        }

        const scannedBatch = await findLiveBatchAccount(connection, corePk, activeBatchId);
        if (scannedBatch) {
          cachedLiveBatch = {
            ...batchStateToJson(scannedBatch.batch, scannedBatch.address.toBase58()),
            registry_address: registryPk.toBase58(),
            batch_id_counter: registry.batchIdCounter.toString(),
          };
          cachedLiveBatchAt = now;
          return cachedLiveBatch;
        }

        return {
          phase: -1,
          source: 'rpc',
          registry_address: registryPk.toBase58(),
          batch_id_counter: registry.batchIdCounter.toString(),
          batchId: activeBatchId.toString(),
          error: 'active batch account not found',
        };
      } catch (err) {
        app.log.warn({ err }, 'batchRoutes: live batch fetch failed, falling back to store');
      }
    }

    const row = store.db.prepare('SELECT * FROM batch_events ORDER BY batch_id DESC, phase DESC LIMIT 1').get();
    return row ?? { phase: -1 };
  });
}

/** Approximate ms per Solana slot on devnet (cluster-agnostic estimate). */
const SLOT_MS_ESTIMATE = 400;

export interface UserFillsRouteConfig {
  /** Slot-to-ms estimator. Override in tests for determinism. */
  slotMsEstimate?: number;
}

export async function userFillsRoutes(
  app: FastifyInstance,
  store: Store,
  cfg: UserFillsRouteConfig = {},
): Promise<void> {
  const slotMs = cfg.slotMsEstimate ?? SLOT_MS_ESTIMATE;

  app.get<{ Params: { pubkey: string }; Querystring: { limit?: string; instrumentId?: string } }>(
    '/api/users/:pubkey/fills',
    async (req, reply) => {
      let userPubkey: Uint8Array;
      try {
        userPubkey = new PublicKey(req.params.pubkey).toBytes();
      } catch {
        return reply.code(400).send({ error: 'invalid pubkey' });
      }

      const limit = Math.min(Number(req.query.limit ?? 200), 500);
      const instrumentId =
        req.query.instrumentId !== undefined ? Number(req.query.instrumentId) : null;

      const sql = instrumentId !== null
        ? `SELECT slot, batch_id, instrument_id, taker_side, price, qty,
                  taker_pubkey, maker_pubkey, tx_signature, is_maker
             FROM fills
             WHERE (taker_pubkey = ? OR maker_pubkey = ?)
               AND instrument_id = ?
             ORDER BY slot DESC
             LIMIT ?`
        : `SELECT slot, batch_id, instrument_id, taker_side, price, qty,
                  taker_pubkey, maker_pubkey, tx_signature, is_maker
             FROM fills
             WHERE (taker_pubkey = ? OR maker_pubkey = ?)
             ORDER BY slot DESC
             LIMIT ?`;

      const params = instrumentId !== null
        ? [Buffer.from(userPubkey), Buffer.from(userPubkey), instrumentId, limit]
        : [Buffer.from(userPubkey), Buffer.from(userPubkey), limit];

      const rows = store.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;

      const takerKey = Buffer.from(userPubkey);
      const makerKey = Buffer.from(userPubkey);
      const fills = rows.map((r) => {
        const takerBuf = r.taker_pubkey as Buffer;
        const makerBuf = r.maker_pubkey as Buffer;
        const role: 'taker' | 'maker' = takerBuf.equals(takerKey)
          ? 'taker'
          : makerBuf.equals(makerKey)
            ? 'maker'
            : 'taker';
        const txSig = r.tx_signature as Buffer;
        return {
          slot: r.slot as number,
          batch_id: r.batch_id as number,
          instrument_id: r.instrument_id as number,
          taker_side: r.taker_side as number,
          price: r.price as number,
          qty: r.qty as number,
          role,
          tx_signature: txSig.toString('base64'),
          ts_estimate: (r.slot as number) * slotMs,
        };
      });

      return { fills };
    },
  );
}
