#!/usr/bin/env node
/**
 * Standalone MGK Oracle Worker.
 *
 * Posts prices to the PriceOracle on-chain account from multiple venue
 * sources with quorum, freshness, and deviation checks.
 *
 * Usage:
 *   node ops-oracle.js --loop                # continuous (default)
 *   node ops-oracle.js                       # one-shot
 *
 * Env vars:
 *   RPC_URL                     -- Solana RPC endpoint
 *   ORACLE_AUTHORITY_KEYPAIR    -- path to oracle authority keypair JSON
 *   OR ORACLE_AUTHORITY_KEYPAIR_FILE
 *   PRICE_ORACLE_ADDRESS        -- PriceOracle PDA (required)
 *   INSTRUMENT_ADDRESS          -- Instrument PDA (required)
 *   ORACLE_PROGRAM_ID           -- Oracle program ID (default: canonical)
 *   ORACLE_LOOP_INTERVAL        -- interval ms (default: 10000)
 *   QUORUM_VENUES               -- comma-separated venue names (default: binance,okx,bybit)
 *   MAX_FRESHNESS_SEC           -- max staleness in seconds (default: 30)
 *   MAX_DEVIATION_BPS           -- max price deviation in bps between venues (default: 50)
 *   LOOP                        -- "1" for continuous
 */

'use strict';

const {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
} = require('@solana/web3.js');
const { readFileSync, existsSync } = require('fs');
const { homedir } = require('os');
const { join } = require('path');

// ---------------------------------------------------------------------------
// Canonical program ID
// ---------------------------------------------------------------------------
const ORACLE_PROGRAM_ID = new PublicKey(
  process.env.ORACLE_PROGRAM_ID || 'CsSqVZMoXixNYstNhTtixeT4pyRgrYnXdpfoXQBgFPqZ',
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function loadKP(path) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Load oracle authority keypair (with file-path env var for Render secrets)
// ---------------------------------------------------------------------------
function loadOracleKeypair() {
  const filePath = process.env.ORACLE_AUTHORITY_KEYPAIR || process.env.ORACLE_AUTHORITY_KEYPAIR_FILE;
  if (filePath && existsSync(filePath)) {
    return loadKP(filePath);
  }
  // Fallback for local dev
  const fallback = join(homedir(), '.config/solana/mgk-oracle-keypair.json');
  if (existsSync(fallback)) {
    console.log(`[oracle] Using fallback keypair: ${fallback}`);
    return loadKP(fallback);
  }
  // Last resort: generate ephemeral
  console.warn('[oracle] WARNING: No persisted keypair found. Generating ephemeral keypair (will not persist).');
  return Keypair.generate();
}

// ---------------------------------------------------------------------------
// Price fetching (multi-venue quorum)
// ---------------------------------------------------------------------------
const VENUE_FETCHERS = {
  binance: async () => {
    const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT');
    if (!res.ok) return null;
    const json = await res.json();
    return { venue: 'binance', price: parseFloat(json.price), ts: Date.now() };
  },
  okx: async () => {
    const res = await fetch('https://www.okx.com/api/v5/market/ticker?instId=SOL-USDT');
    if (!res.ok) return null;
    const json = await res.json();
    const last = json.data?.[0]?.last;
    if (!last) return null;
    return { venue: 'okx', price: parseFloat(last), ts: Date.now() };
  },
  bybit: async () => {
    const res = await fetch('https://api.bybit.com/v5/market/tickers?category=spot&symbol=SOLUSDT');
    if (!res.ok) return null;
    const json = await res.json();
    const last = json.result?.list?.[0]?.lastPrice;
    if (!last) return null;
    return { venue: 'bybit', price: parseFloat(last), ts: Date.now() };
  },
};

async function fetchQuorumPrice(venues, maxFreshnessSec, maxDeviationBps) {
  const results = await Promise.allSettled(
    venues.map(v => VENUE_FETCHERS[v]()),
  );

  const prices = results
    .filter(r => r.status === 'fulfilled' && r.value !== null)
    .map(r => r.value);

  if (prices.length === 0) {
    console.error('[oracle] No venue responded');
    return null;
  }

  // Check freshness
  const now = Date.now();
  const fresh = prices.filter(p => (now - p.ts) / 1000 <= maxFreshnessSec);
  if (fresh.length === 0) {
    console.error('[oracle] All prices stale (max freshness:', maxFreshnessSec, 'sec)');
    return null;
  }

  // Check deviation
  if (fresh.length >= 2) {
    const avg = fresh.reduce((s, p) => s + p.price, 0) / fresh.length;
    for (const p of fresh) {
      const devBps = Math.abs((p.price - avg) / avg) * 10000;
      if (devBps > maxDeviationBps) {
        console.error(`[oracle] Deviation too high: ${p.venue} dev=${devBps.toFixed(1)}bps > ${maxDeviationBps}bps`);
        return null;
      }
    }
  }

  // Median price
  const sorted = fresh.map(p => p.price).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  console.log(`[oracle] Quorum: ${fresh.map(p => `${p.venue}=${p.price}`).join(', ')} → median=${median}`);

  return {
    price: BigInt(Math.round(median * 1_000_000)), // 6 decimals
    confidence: BigInt(Math.round(median * 10_000)), // 1% of price
    venues: fresh.map(p => p.venue),
  };
}

// ---------------------------------------------------------------------------
// On-chain posting
// ---------------------------------------------------------------------------
async function postPrice(conn, oracleAuthority, priceOraclePda, price, confidence) {
  // UpdatePrice: disc(1) + price(i64) + confidence(i64) = 17 bytes
  const data = Buffer.alloc(17);
  data.writeUInt8(1, 0); // disc UpdatePrice
  data.writeBigInt64LE(price, 1);
  data.writeBigInt64LE(confidence, 9);

  const tx = new Transaction();
  tx.add(new TransactionInstruction({
    keys: [
      { pubkey: priceOraclePda, isSigner: false, isWritable: true },
      { pubkey: oracleAuthority.publicKey, isSigner: true, isWritable: true },
    ],
    programId: ORACLE_PROGRAM_ID,
    data,
  }));

  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.feePayer = oracleAuthority.publicKey;
  tx.sign(oracleAuthority);

  let lastErr;
  for (let i = 0; i < 6; i++) {
    try {
      const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
      await conn.confirmTransaction(sig, 'confirmed');
      console.log(`[oracle] Posted price ${price} (${Number(price) / 1e6} USD): TX ${sig}`);
      return sig;
    } catch (e) {
      lastErr = e;
      const msg = e && e.message ? e.message : String(e);
      if (msg.includes('429') && i < 5) {
        const wait = 1500 * Math.pow(2, i);
        console.log(`[oracle] 429, retry in ${wait}ms`);
        await sleep(wait);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const loop = process.argv.includes('--loop') || process.env.LOOP === '1';
  const interval = parseInt(process.env.ORACLE_LOOP_INTERVAL || '10000');
  const maxFreshnessSec = parseInt(process.env.MAX_FRESHNESS_SEC || '30');
  const maxDeviationBps = parseInt(process.env.MAX_DEVIATION_BPS || '50');
  const venues = (process.env.QUORUM_VENUES || 'binance,okx,bybit').split(',').map(v => v.trim());

  const rpc = process.env.RPC_URL || 'https://api.devnet.solana.com';
  const conn = new Connection(rpc, 'confirmed');
  const oracleAuthority = loadOracleKeypair();

  const priceOraclePda = new PublicKey(process.env.PRICE_ORACLE_ADDRESS);
  const instrumentPda = new PublicKey(process.env.INSTRUMENT_ADDRESS);

  console.log('=== MGK Oracle Worker (standalone) ===');
  console.log('RPC:', new URL(rpc).host);
  console.log('Authority:', oracleAuthority.publicKey.toBase58());
  console.log('PriceOracle:', priceOraclePda.toBase58());
  console.log('Instrument:', instrumentPda.toBase58());
  console.log('Venues:', venues.join(', '));
  console.log('Max freshness:', maxFreshnessSec, 'sec');
  console.log('Max deviation:', maxDeviationBps, 'bps');
  console.log('Interval:', interval, 'ms');

  async function cycle() {
    try {
      const result = await fetchQuorumPrice(venues, maxFreshnessSec, maxDeviationBps);
      if (result) {
        await postPrice(conn, oracleAuthority, priceOraclePda, result.price, result.confidence);
      }
    } catch (e) {
      console.error('[oracle] Cycle error:', e.message || e);
    }
  }

  if (loop) {
    console.log(`\nPolling every ${interval}ms...\n`);
    while (true) {
      await cycle();
      await sleep(interval);
    }
  } else {
    await cycle();
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
