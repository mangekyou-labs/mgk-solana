import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { Keypair, PublicKey, type AccountInfo, type Connection } from '@solana/web3.js';
import * as sdk from '@mgk/sdk';
import { createStore } from './store.js';
import { aggregateCandles } from './aggregator.js';
import {
  marketsRoutes,
  candlesRoutes,
  tradesRoutes,
  bookRoutes,
  batchRoutes,
  userFillsRoutes,
} from './rest/routes.js';
import { healthRoutes } from './rest/health.js';

const TX_SIG = Buffer.from('test-tx-signature-001', 'utf-8');
const MAKER = new Uint8Array(32).fill(0xaa);
const TAKER = new Uint8Array(32).fill(0xbb);
const TAKER_B58 = 'DdqGmK5uamYN5vmuZrzpQhKeehLdwtPLVJdhu5P2iJKC';
const MAKER_B58 = 'CVDFLCAjXhVWiPXH9nTCTpCgVzmDVoiPzNJYuccr1dqB';

function makeRegistryBuffer(batchIdCounter: bigint): Uint8Array {
  const buf = new Uint8Array(sdk.state.REGISTRY_SIZE);
  const view = new DataView(buf.buffer);
  view.setUint16(32, 1, true);
  view.setUint16(34, 10_000, true);
  view.setBigUint64(36, batchIdCounter, true);
  view.setBigUint64(44, 10_000_000n, true);
  view.setUint32(52, 1, true);
  view.setBigUint64(56, 4n, true);
  view.setBigUint64(64, 400n, true);
  view.setBigUint64(72, 50n, true);
  view.setUint8(80, 0);
  return buf;
}

function makeBatchBuffer(batchId: bigint): Uint8Array {
  const buf = new Uint8Array(sdk.state.BATCH_SIZE);
  const view = new DataView(buf.buffer);
  view.setBigUint64(0, batchId, true);
  view.setUint8(8, sdk.state.BatchStatus.Committing);
  view.setBigUint64(16, 100n, true);
  view.setBigUint64(24, 200n, true);
  view.setBigUint64(32, 250n, true);
  view.setBigUint64(40, 300n, true);
  view.setBigInt64(48, 150_000_000n, true);
  return buf;
}

function makeAccountInfo(data: Uint8Array): AccountInfo<Buffer> {
  return {
    data: Buffer.from(data),
    executable: false,
    lamports: 1_000_000,
    owner: Keypair.generate().publicKey,
    rentEpoch: 0,
  };
}

describe('indexer integration', () => {
  const store = createStore(':memory:');
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });

    await app.register(healthRoutes);
    await app.register(marketsRoutes, store);
    await app.register(candlesRoutes, store);
    await app.register(tradesRoutes, store);
    await app.register(bookRoutes, store);
    await app.register(batchRoutes, store);
    await app.register(userFillsRoutes, store);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    store.close();
  });

  // ── healthz ═════════════════════════════════════════════════════

  it('GET /api/healthz returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/healthz' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(typeof body.ts).toBe('number');
  });

  // ── batch events ════════════════════════════════════════════════

  it('GET /api/batch/current returns the latest batch event', async () => {
    store.insertBatchEvent.run([1, 1700000000, 0, 15, 123456, 150.42]);
    store.insertBatchEvent.run([1, 1700000060, 1, 15, 123456, 150.42]);
    store.insertBatchEvent.run([2, 1700000120, 0, 22, 123500, 151.10]);

    const res = await app.inject({ method: 'GET', url: '/api/batch/current' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.batch_id).toBe(2);
    expect(body.phase).toBe(0);
    expect(body.num_commitments).toBe(22);
  });

  it('GET /api/batch/current ignores a stale persisted keypair and scans for the active batch', async () => {
    const liveStore = createStore(':memory:');
    const liveApp = Fastify({ logger: false });
    const coreProgramId = Keypair.generate().publicKey;
    const registryAddress = Keypair.generate().publicKey;
    const staleBatchAddress = Keypair.generate().publicKey;
    const activeBatchAddress = Keypair.generate().publicKey;

    const connection = {
      async getAccountInfo(address: PublicKey) {
        if (address.equals(registryAddress)) return makeAccountInfo(makeRegistryBuffer(5n));
        if (address.equals(staleBatchAddress)) return makeAccountInfo(makeBatchBuffer(3n));
        return null;
      },
      async getProgramAccounts() {
        return [
          {
            pubkey: activeBatchAddress,
            account: makeAccountInfo(makeBatchBuffer(4n)),
          },
        ];
      },
    } as unknown as Connection;

    await liveApp.register(async (instance) => {
      await batchRoutes(instance, liveStore, {
        connection,
        coreProgramId: coreProgramId.toBase58(),
        registryAddress: registryAddress.toBase58(),
        getCurrentBatchAddress: () => staleBatchAddress.toBase58(),
      });
    });
    await liveApp.ready();

    try {
      const res = await liveApp.inject({ method: 'GET', url: '/api/batch/current' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.batchId).toBe('4');
      expect(body.batchAddress).toBe(activeBatchAddress.toBase58());
      expect(body.batch_id_counter).toBe('5');
    } finally {
      await liveApp.close();
      liveStore.close();
    }
  });

  // ── markets ══════════════════════════════════════════════════════

  it('GET /api/markets returns market state', async () => {
    store.upsertMarketState.run([0, 150.42, 150.38, 5000, 3200, 0.0125, 0, 1700000000]);
    store.upsertMarketState.run([1, 3200.10, 3200.05, 1200, 800, 0.01, 0, 1700000000]);

    const res = await app.inject({ method: 'GET', url: '/api/markets' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.markets).toHaveLength(2);
    expect(body.markets[0]).toMatchObject({
      instrument_id: 0,
      last_price: 150.42,
      open_interest_long: 5000,
    });
    expect(body.markets[1]).toMatchObject({
      instrument_id: 1,
      last_price: 3200.10,
    });
  });

  it('GET /api/markets/:id/state returns one market', async () => {
    store.upsertMarketState.run([0, 150.42, 150.38, 5000, 3200, 0.0125, 12345.67, 1700000000]);

    const res = await app.inject({ method: 'GET', url: '/api/markets/0/state' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      instrument_id: 0,
      last_price: 150.42,
      mark_price: 150.38,
      open_interest_long: 5000,
      open_interest_short: 3200,
      funding_rate: 0.0125,
      volume_24h: 12345.67,
    });
  });

  it('GET /api/markets/:id/state returns 404 for unknown instrument', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/markets/99/state' });
    expect(res.statusCode).toBe(404);
  });

  it('recompute24hVolume sums candles_1m in the 24h window', () => {
    const fresh = createStore(':memory:');
    const now = Math.floor(Date.now() / 1000);
    const inside = now - 60; // 1 minute ago — inside the window
    const outside = now - 90_000; // ~25h ago — outside the window

    fresh.db.prepare(`
      INSERT INTO candles_1m (instrument_id, open_ts, open, high, low, close, volume)
      VALUES (?, ?, 100, 100, 100, 100, 5.0)
    `).run(0, inside);
    fresh.db.prepare(`
      INSERT INTO candles_1m (instrument_id, open_ts, open, high, low, close, volume)
      VALUES (?, ?, 100, 100, 100, 100, 3.5)
    `).run(0, inside + 120);
    fresh.db.prepare(`
      INSERT INTO candles_1m (instrument_id, open_ts, open, high, low, close, volume)
      VALUES (?, ?, 100, 100, 100, 100, 99.0)
    `).run(0, outside);

    fresh.upsertMarketState.run([0, 100, 100, 0, 0, 0, 0, now]);
    fresh.recompute24hVolume.run(now - 86_400);

    const row = fresh.db
      .prepare('SELECT volume_24h FROM market_state WHERE instrument_id = 0')
      .get() as { volume_24h: number };
    expect(row.volume_24h).toBeCloseTo(8.5, 5); // 5.0 + 3.5, not 99.0
  });

  // ── fills + candle aggregation ═══════════════════════════════════

  it('aggregates fills into candles across all resolutions', () => {
    const fillTs = 1700000000000; // ms timestamp
    const price = 150_400_000n; // scaled 1e6 → 150.40
    const qty = 5_000_000n; // scaled 1e6 → 5.0

    // Insert two fills at the same timestamp
    store.insertFill.run([
      1000, 1, 0, 0, Number(price), Number(qty), TAKER, MAKER, TX_SIG, 0,
    ]);

    aggregateCandles(store, [
      { instrumentId: 0, timestampMs: fillTs, price, qty },
      { instrumentId: 0, timestampMs: fillTs, price: 151_000_000n, qty: 3_000_000n },
    ]);

    // Check 1m candles
    const candles1m = store.db
      .prepare('SELECT * FROM candles_1m WHERE instrument_id = ? ORDER BY open_ts')
      .all(0) as Array<Record<string, unknown>>;
    expect(candles1m).toHaveLength(1);
    const c1m = candles1m[0]!;
    expect(c1m.open).toBeCloseTo(150.40, 2);
    expect(c1m.close).toBeCloseTo(151.00, 2);
    expect(c1m.high).toBeCloseTo(151.00, 2);
    expect(c1m.low).toBeCloseTo(150.40, 2);
    expect(c1m.volume).toBeCloseTo(8.0, 2);

    // Check 5m candles (same bucket)
    const candles5m = store.db
      .prepare('SELECT * FROM candles_5m WHERE instrument_id = ? ORDER BY open_ts')
      .all(0) as Array<Record<string, unknown>>;
    expect(candles5m).toHaveLength(1);
    expect((candles5m[0] as Record<string, unknown>).volume).toBeCloseTo(8.0, 2);

    // Check 1h candles (same bucket)
    const candles1h = store.db
      .prepare('SELECT * FROM candles_1h WHERE instrument_id = ? ORDER BY open_ts')
      .all(0) as Array<Record<string, unknown>>;
    expect(candles1h).toHaveLength(1);
    expect((candles1h[0] as Record<string, unknown>).volume).toBeCloseTo(8.0, 2);
  });

  it('aggregates fills spanning multiple candle buckets', () => {
    const baseMs = 1800000000000;
    const fresh = createStore(':memory:');

    aggregateCandles(fresh, [
      { instrumentId: 0, timestampMs: baseMs, price: 100_000_000n, qty: 1_000_000n },
      // +70s → next 1m bucket (but same 5m bucket)
      { instrumentId: 0, timestampMs: baseMs + 70_000, price: 101_000_000n, qty: 2_000_000n },
      // +310s → next 5m bucket (but same 1h bucket)
      { instrumentId: 0, timestampMs: baseMs + 310_000, price: 102_000_000n, qty: 3_000_000n },
    ]);

    // 1m candles should have 2+ distinct buckets (0s and 70s are different minutes)
    const candles1m = fresh.db
      .prepare('SELECT * FROM candles_1m WHERE instrument_id = ? ORDER BY open_ts')
      .all(0) as Array<Record<string, unknown>>;
    expect(candles1m.length).toBeGreaterThanOrEqual(2);

    // 5m candles should have 2+ distinct buckets (0s and 310s are different 5m windows)
    const candles5m = fresh.db
      .prepare('SELECT * FROM candles_5m WHERE instrument_id = ? ORDER BY open_ts')
      .all(0) as Array<Record<string, unknown>>;
    expect(candles5m.length).toBeGreaterThanOrEqual(2);

    // 1h candles should have 1 bucket (all within same hour)
    const candles1h = fresh.db
      .prepare('SELECT * FROM candles_1h WHERE instrument_id = ? ORDER BY open_ts')
      .all(0) as Array<Record<string, unknown>>;
    expect(candles1h.length).toBe(1);

    fresh.close();
  });

  it('ON CONFLICT upsert merges same-bucket fills (high/low/close/volume)', () => {
    const fresh = createStore(':memory:');
    // Use a clean minute-aligned timestamp so 30s offsets stay in-bucket
    const ts = 1700000040000; // 1700000040 sec → bucket start = 1700000040

    // First fill in this bucket
    aggregateCandles(fresh, [
      { instrumentId: 0, timestampMs: ts, price: 200_000_000n, qty: 10_000_000n },
    ]);

    // Second fill — +10s, same 1m bucket
    aggregateCandles(fresh, [
      { instrumentId: 0, timestampMs: ts + 10_000, price: 205_000_000n, qty: 5_000_000n },
    ]);

    // Third fill — +30s, same 1m bucket
    aggregateCandles(fresh, [
      { instrumentId: 0, timestampMs: ts + 30_000, price: 195_000_000n, qty: 3_000_000n },
    ]);

    // Query the 1m candle for this bucket
    const bucketSec = Math.floor(ts / 1000);
    const bucket1m = Math.floor(bucketSec / 60) * 60;
    const candle = fresh.db
      .prepare(
        'SELECT * FROM candles_1m WHERE instrument_id = ? AND open_ts = ?',
      )
      .get(0, bucket1m) as Record<string, unknown>;
    expect(candle).toBeTruthy();
    expect(candle.open).toBeCloseTo(200.0, 2); // first fill's price
    expect(candle.high).toBeCloseTo(205.0, 2); // max of all
    expect(candle.low).toBeCloseTo(195.0, 2); // min of all
    expect(candle.close).toBeCloseTo(195.0, 2); // last fill's price
    expect(candle.volume).toBeCloseTo(18.0, 2); // 10 + 5 + 3

    fresh.close();
  });

  // ── REST round-trip ══════════════════════════════════════════════

  it('GET /api/markets/0/trades returns fill data ordered by slot desc', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/markets/0/trades?limit=10',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.trades)).toBe(true);
    // At least the fills inserted above should be present
    expect(body.trades.length).toBeGreaterThanOrEqual(1);
    // Verify descending slot order
    const slots = body.trades.map((t: { slot: number }) => t.slot);
    for (let i = 1; i < slots.length; i++) {
      expect(slots[i - 1]).toBeGreaterThanOrEqual(slots[i]);
    }
  });

  it('GET /api/markets/0/candles returns candles for a given resolution', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/markets/0/candles?resolution=1m&from=0&to=9999999999',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.candles)).toBe(true);
    expect(body.candles.length).toBeGreaterThanOrEqual(1);
    expect((body.candles[0] as Record<string, unknown>)).toHaveProperty('open');
    expect((body.candles[0] as Record<string, unknown>)).toHaveProperty('high');
    expect((body.candles[0] as Record<string, unknown>)).toHaveProperty('close');
    expect((body.candles[0] as Record<string, unknown>)).toHaveProperty('volume');
  });

  it('GET /api/markets/0/candles defaults to 1m resolution', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/markets/0/candles',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.candles)).toBe(true);
    expect(body.candles.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/markets/0/candles with 5m resolution returns 5m candles', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/markets/0/candles?resolution=5m&from=0&to=9999999999',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.candles)).toBe(true);
    expect(body.candles.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/markets/0/book returns empty book stub', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/markets/0/book',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.bids).toEqual([]);
    expect(body.asks).toEqual([]);
  });

  it('GET /api/markets/0/trades respects limit', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/markets/0/trades?limit=1',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.trades.length).toBeLessThanOrEqual(1);
  });

  // ── edge cases ═══════════════════════════════════════════════════

  it('GET /api/batch/current returns phase=-1 when no events exist', async () => {
    // Create a fresh store with no batch events
    const empty = createStore(':memory:');
    const emptyApp = Fastify({ logger: false });
    await emptyApp.register(batchRoutes, empty);
    await emptyApp.ready();

    const res = await emptyApp.inject({ method: 'GET', url: '/api/batch/current' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.phase).toBe(-1);

    await emptyApp.close();
    empty.close();
  });

  it('empty fills table returns empty trades array', async () => {
    const empty = createStore(':memory:');
    const emptyApp = Fastify({ logger: false });
    await emptyApp.register(tradesRoutes, empty);
    await emptyApp.ready();

    const res = await emptyApp.inject({
      method: 'GET',
      url: '/api/markets/99/trades',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.trades).toEqual([]);

    await emptyApp.close();
    empty.close();
  });

  // ── user fills (G6) ════════════════════════════════════════════

  describe('GET /api/users/:pubkey/fills', () => {
    const setup = createStore(':memory:');
    let setupApp: ReturnType<typeof Fastify>;

    beforeAll(async () => {
      setupApp = Fastify({ logger: false });
      await setupApp.register(userFillsRoutes, setup);
      await setupApp.ready();

      // Two fills where MAKER is the user, two where TAKER is the user, plus
      // one fill between two unrelated pubkeys (should not appear).
      setup.insertFill.run([1001, 1, 0, 0, 150_400_000, 5_000_000, TAKER, MAKER, TX_SIG, 0]);
      setup.insertFill.run([1002, 1, 0, 1, 151_000_000, 3_000_000, TAKER, MAKER, TX_SIG, 1]);
      setup.insertFill.run([1003, 1, 0, 0, 150_500_000, 2_000_000, MAKER, TAKER, TX_SIG, 0]);
      setup.insertFill.run([1004, 1, 0, 1, 150_600_000, 1_000_000, MAKER, TAKER, TX_SIG, 1]);

      const OTHER_A = new Uint8Array(32).fill(0x11);
      const OTHER_B = new Uint8Array(32).fill(0x22);
      setup.insertFill.run([1005, 1, 0, 0, 150_700_000, 9_000_000, OTHER_A, OTHER_B, TX_SIG, 0]);
    });

    afterAll(async () => {
      await setupApp.close();
      setup.close();
    });

    it('returns 400 for an invalid pubkey', async () => {
      const res = await setupApp.inject({
        method: 'GET',
        url: '/api/users/not-a-pubkey/fills',
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns the user's fills as taker", async () => {
      const res = await setupApp.inject({
        method: 'GET',
        url: `/api/users/${TAKER_B58}/fills`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.fills.length).toBe(4);
      // Sorted by slot DESC
      const slots = body.fills.map((f: { slot: number }) => f.slot);
      expect(slots).toEqual([1004, 1003, 1002, 1001]);
    });

    it("returns the user's fills as maker (same set; role flipped)", async () => {
      const res = await setupApp.inject({
        method: 'GET',
        url: `/api/users/${MAKER_B58}/fills`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.fills.length).toBe(4);
      // The first fill (1001) is maker=MAKER (in our seed: taker=TAKER, maker=MAKER),
      // so its role should be 'maker'. Slot 1004 is taker=MAKER → 'taker'.
      const bySlot = new Map<number, { role: string }>(
        body.fills.map((f: { slot: number; role: string }) => [f.slot, f]),
      );
      expect(bySlot.get(1004)?.role).toBe('taker');
      expect(bySlot.get(1001)?.role).toBe('maker');
    });

    it('does not return fills where the user is neither taker nor maker', async () => {
      const res = await setupApp.inject({
        method: 'GET',
        url: `/api/users/${TAKER_B58}/fills`,
      });
      const body = JSON.parse(res.body);
      const slots = body.fills.map((f: { slot: number }) => f.slot);
      expect(slots).not.toContain(1005);
    });

    it('respects the limit query parameter', async () => {
      const res = await setupApp.inject({
        method: 'GET',
        url: `/api/users/${TAKER_B58}/fills?limit=2`,
      });
      const body = JSON.parse(res.body);
      expect(body.fills.length).toBe(2);
    });

    it('exposes ts_estimate (slot * 400ms)', async () => {
      const res = await setupApp.inject({
        method: 'GET',
        url: `/api/users/${TAKER_B58}/fills`,
      });
      const body = JSON.parse(res.body);
      const first = body.fills[0] as { slot: number; ts_estimate: number };
      expect(first.ts_estimate).toBe(first.slot * 400);
    });

    it('filters by instrumentId when provided', async () => {
      // Insert a fill on instrument 1; should not show up under instrument 0
      const OTHER_A = new Uint8Array(32).fill(0x11);
      const OTHER_B = new Uint8Array(32).fill(0x22);
      setup.insertFill.run([2000, 2, 1, 0, 200_000_000, 4_000_000, OTHER_A, OTHER_B, TX_SIG, 0]);

      const res = await setupApp.inject({
        method: 'GET',
        url: `/api/users/${TAKER_B58}/fills?instrumentId=0`,
      });
      const body = JSON.parse(res.body);
      const ids = body.fills.map((f: { instrument_id: number }) => f.instrument_id);
      expect(ids.every((id: number) => id === 0)).toBe(true);
    });
  });
});
