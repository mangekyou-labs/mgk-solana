import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';

export interface Store {
  db: DB;
  insertFill: ReturnType<DB['prepare']>;
  upsertCandle: Record<string, ReturnType<DB['prepare']>>;
  insertBatchEvent: ReturnType<DB['prepare']>;
  upsertMarketState: ReturnType<DB['prepare']>;
  getLatestSlot: ReturnType<DB['prepare']>;
  recompute24hVolume: ReturnType<DB['prepare']>;
  close: () => void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS fills (
  slot INTEGER NOT NULL,
  batch_id INTEGER NOT NULL,
  instrument_id INTEGER NOT NULL,
  taker_side INTEGER NOT NULL,
  price INTEGER NOT NULL,
  qty INTEGER NOT NULL,
  taker_pubkey BLOB NOT NULL,
  maker_pubkey BLOB NOT NULL,
  tx_signature BLOB NOT NULL,
  is_maker INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tx_signature, instrument_id, slot)
);
CREATE INDEX IF NOT EXISTS idx_fills_instrument_slot
  ON fills(instrument_id, slot DESC);

CREATE TABLE IF NOT EXISTS candles_1m (
  instrument_id INTEGER NOT NULL,
  open_ts INTEGER NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume REAL NOT NULL,
  PRIMARY KEY (instrument_id, open_ts)
);

CREATE TABLE IF NOT EXISTS candles_5m (
  instrument_id INTEGER NOT NULL,
  open_ts INTEGER NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume REAL NOT NULL,
  PRIMARY KEY (instrument_id, open_ts)
);

CREATE TABLE IF NOT EXISTS candles_1h (
  instrument_id INTEGER NOT NULL,
  open_ts INTEGER NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume REAL NOT NULL,
  PRIMARY KEY (instrument_id, open_ts)
);

CREATE TABLE IF NOT EXISTS batch_events (
  batch_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  phase INTEGER NOT NULL,
  num_commitments INTEGER DEFAULT 0,
  close_slot INTEGER DEFAULT 0,
  vwap REAL DEFAULT 0.0,
  PRIMARY KEY (batch_id, phase)
);

CREATE TABLE IF NOT EXISTS market_state (
  instrument_id INTEGER PRIMARY KEY,
  last_price REAL DEFAULT 0.0,
  mark_price REAL DEFAULT 0.0,
  open_interest_long REAL DEFAULT 0.0,
  open_interest_short REAL DEFAULT 0.0,
  funding_rate REAL DEFAULT 0.0,
  volume_24h REAL DEFAULT 0.0,
  updated_ts INTEGER DEFAULT 0
);

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
`;

export function createStore(dbPath = ':memory:'): Store {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);

  const insertFill = db.prepare(`
    INSERT OR IGNORE INTO fills (slot, batch_id, instrument_id, taker_side, price, qty, taker_pubkey, maker_pubkey, tx_signature, is_maker)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const upsertCandle: Record<string, ReturnType<DB['prepare']>> = {};
  for (const resolution of ['1m', '5m', '1h']) {
    upsertCandle[resolution] = db.prepare(`
      INSERT INTO candles_${resolution} (instrument_id, open_ts, open, high, low, close, volume)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(instrument_id, open_ts) DO UPDATE SET
        high = MAX(high, excluded.high),
        low = MIN(low, excluded.low),
        close = excluded.close,
        volume = volume + excluded.volume
    `);
  }

  const insertBatchEvent = db.prepare(`
    INSERT OR IGNORE INTO batch_events (batch_id, ts, phase, num_commitments, close_slot, vwap)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const upsertMarketState = db.prepare(`
    INSERT INTO market_state (instrument_id, last_price, mark_price, open_interest_long, open_interest_short, funding_rate, volume_24h, updated_ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(instrument_id) DO UPDATE SET
      last_price = excluded.last_price,
      mark_price = excluded.mark_price,
      open_interest_long = excluded.open_interest_long,
      open_interest_short = excluded.open_interest_short,
      funding_rate = excluded.funding_rate,
      volume_24h = excluded.volume_24h,
      updated_ts = excluded.updated_ts
  `);

  const getLatestSlot = db.prepare(`
    SELECT MAX(slot) as slot FROM fills
  `);

  const recompute24hVolume = db.prepare(`
    UPDATE market_state
    SET volume_24h = COALESCE((
      SELECT SUM(volume) FROM candles_1m
      WHERE instrument_id = market_state.instrument_id
        AND open_ts >= ?
    ), 0)
  `);

  return {
    db,
    insertFill,
    upsertCandle,
    insertBatchEvent,
    upsertMarketState,
    getLatestSlot,
    recompute24hVolume,
    close: () => db.close(),
  };
}
