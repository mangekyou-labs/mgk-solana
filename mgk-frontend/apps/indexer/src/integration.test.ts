import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { createStore } from './store.js';
import { aggregateCandles } from './aggregator.js';
import {
  marketsRoutes,
  candlesRoutes,
  tradesRoutes,
  bookRoutes,
  batchRoutes,
} from './rest/routes.js';
import { healthRoutes } from './rest/health.js';

const TX_SIG = Buffer.from('test-tx-signature-001', 'utf-8');
const MAKER = new Uint8Array(32).fill(0xaa);
const TAKER = new Uint8Array(32).fill(0xbb);

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
});
