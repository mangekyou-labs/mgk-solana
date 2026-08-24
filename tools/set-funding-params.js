#!/usr/bin/env node
/**
 * T9.10.5 — governance SetFundingParams (disc 24).
 *
 * Updates D7 funding parameters on an instrument:
 *   coefficient_bps, max_rate_bps, interval_slots.
 *
 * Resets last_funding_slot to the current clock slot to prevent backfill.
 * Preserves cum_funding.
 *
 * Usage:
 *   node set-funding-params.js
 *   node set-funding-params.js --coefficient-bps 10000 --max-rate-bps 50 --interval-slots 100
 *   node set-funding-params.js --instrument <INSTRUMENT_PUBKEY>
 *
 * Env: RPC_URL, DEPLOYER_KEYPAIR / KEEPER_KEYPAIR, INSTRUMENT_ADDRESS
 * Defaults: coefficient_bps=10000, max_rate_bps=50, interval_slots=100
 * Logs RPC **host** only — never the full URL or api-key.
 */
'use strict';

const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } = require('@solana/web3.js');
const { readFileSync } = require('fs');
const { homedir } = require('os');
const { join } = require('path');
const { loadEnvLocal } = require('./inject-persona');

const CORE_ID = new PublicKey('C7w2mKz2KQgDroNNhACm9MutXhPiesVr9Gn2x8TDsRYx');

// Instrument struct offsets (from programs/perps-core/src/state/instrument.rs)
// After oracle_addr (@60, 32 bytes → ends @92), i128 cum_funding needs
// 16-byte alignment → padded to @96. Layout:
//   @96  cum_funding (i128, 16B) → @112
//   @112 last_funding_slot (u64, 8B) → @120
//   @120 funding_interval_slots (u64, 8B) → @128
//   @128 is_active (1), bump (1), _padding (6) → @136
//   @136 mark_price (i64) → @144
//   @144 mark_reference_qty (u64) → @152
//   @152 mark_decay_window_slots (u64) → @160
//   @160 funding_coefficient_bps (i64) → @168
//   @168 _reserved_deviation_cap (i64) → @176
//   @176 max_funding_rate_bps (i64) → @184
const OFFSET_CUM_FUNDING = 96;              // i128
const OFFSET_LAST_FUNDING_SLOT = 112;       // u64
const OFFSET_FUNDING_INTERVAL_SLOTS = 120;  // u64
const OFFSET_FUNDING_COEFFICIENT_BPS = 160; // i64
const OFFSET_MAX_FUNDING_RATE_BPS = 176;    // i64

function loadKP(p) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, 'utf-8'))));
}

function pda(seeds, prog) {
  return PublicKey.findProgramAddressSync(seeds, prog);
}

function le16(v) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v, 0);
  return b;
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/**
 * Encode the SetFundingParams wire payload: disc(1) + coefficient_bps(i64 LE) + max_rate_bps(i64 LE) + interval_slots(u64 LE)
 * Returns a 25-byte Buffer.
 */
function encodeSetFundingParams(coefficientBps, maxRateBps, intervalSlots) {
  // Validate types and ranges
  if (!Number.isInteger(coefficientBps)) {
    throw new Error('coefficient_bps must be an integer');
  }
  if (!Number.isInteger(maxRateBps)) {
    throw new Error('max_rate_bps must be an integer');
  }
  if (!Number.isInteger(intervalSlots)) {
    throw new Error('interval_slots must be an integer');
  }
  if (coefficientBps < 0) {
    throw new Error('coefficient_bps must be non-negative');
  }
  if (maxRateBps < 0) {
    throw new Error('max_rate_bps must be non-negative');
  }
  if (intervalSlots <= 0) {
    throw new Error('interval_slots must be non-zero');
  }

  const buf = Buffer.alloc(25);
  buf[0] = 24; // discriminator
  buf.writeBigInt64LE(BigInt(coefficientBps), 1);
  buf.writeBigInt64LE(BigInt(maxRateBps), 9);
  buf.writeBigUInt64LE(BigInt(intervalSlots), 17);
  return buf;
}

// ---------------------------------------------------------------------------
// Account decoding (for readback verification)
// ---------------------------------------------------------------------------

/**
 * Decode funding fields from a raw Instrument account buffer.
 * Returns { fundingCoefficientBps, maxFundingRateBps, fundingIntervalSlots, lastFundingSlot }.
 */
function decodeInstrumentFunding(data) {
  return {
    fundingCoefficientBps: data.readBigInt64LE(OFFSET_FUNDING_COEFFICIENT_BPS),
    maxFundingRateBps: data.readBigInt64LE(OFFSET_MAX_FUNDING_RATE_BPS),
    fundingIntervalSlots: data.readBigUInt64LE(OFFSET_FUNDING_INTERVAL_SLOTS),
    lastFundingSlot: data.readBigUInt64LE(OFFSET_LAST_FUNDING_SLOT),
  };
}

/**
 * Decode cum_funding (i128 LE) from a raw Instrument account buffer.
 */
function decodeCumFunding(data) {
  // Read as two i64 halves and combine
  const lo = data.readBigInt64LE(OFFSET_CUM_FUNDING);
  const hi = data.readBigInt64LE(OFFSET_CUM_FUNDING + 8);
  return lo | (hi << 64n);
}

// ---------------------------------------------------------------------------
// Instruction builder (testable without network)
// ---------------------------------------------------------------------------

function buildSetFundingParamsInstruction({
  instrument,
  registry,
  governance,
  coefficientBps,
  maxRateBps,
  intervalSlots,
  coreProgramId = CORE_ID,
}) {
  const data = encodeSetFundingParams(coefficientBps, maxRateBps, intervalSlots);

  return new TransactionInstruction({
    keys: [
      { pubkey: instrument, isSigner: false, isWritable: true },
      { pubkey: registry, isSigner: false, isWritable: false },
      { pubkey: governance, isSigner: true, isWritable: false },
    ],
    programId: coreProgramId,
    data,
  });
}

// ---------------------------------------------------------------------------
// Idempotency check — compare target params against on-chain state
// ---------------------------------------------------------------------------

function paramsAlreadySet(onChain, target) {
  return (
    onChain.fundingCoefficientBps === target.coefficientBps &&
    onChain.maxFundingRateBps === target.maxRateBps &&
    onChain.fundingIntervalSlots === target.intervalSlots
  );
}

// ---------------------------------------------------------------------------
// Main operator
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  let coefficientBps = 10_000;
  let maxRateBps = 50;
  let intervalSlots = 100;
  let instrument = process.env.INSTRUMENT_ADDRESS || null;

  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--coefficient-bps' && argv[i + 1] != null) {
      coefficientBps = Number(argv[++i]);
    } else if (argv[i] === '--max-rate-bps' && argv[i + 1] != null) {
      maxRateBps = Number(argv[++i]);
    } else if (argv[i] === '--interval-slots' && argv[i + 1] != null) {
      intervalSlots = Number(argv[++i]);
    } else if (argv[i] === '--instrument' && argv[i + 1] != null) {
      instrument = argv[++i];
    }
  }

  return {
    coefficientBps,
    maxRateBps,
    intervalSlots,
    instrumentPubkey: instrument ? new PublicKey(instrument) : null,
  };
}

async function setFundingParams({
  connection,
  governanceKeypair,
  coefficientBps,
  maxRateBps,
  intervalSlots,
  instrumentAccount,
  coreProgramId = CORE_ID,
}) {
  const [regPDA] = pda([Buffer.from('registry')], coreProgramId);
  const instPDA = instrumentAccount || pda([Buffer.from('instrument'), le16(0)], coreProgramId)[0];

  // Read current state
  const beforeInfo = await connection.getAccountInfo(instPDA);
  if (!beforeInfo || beforeInfo.data.length < 336) {
    throw new Error('instrument account missing or too small');
  }

  const before = decodeInstrumentFunding(beforeInfo.data);
  const beforeCumFunding = decodeCumFunding(beforeInfo.data);

  const target = {
    coefficientBps: BigInt(coefficientBps),
    maxRateBps: BigInt(maxRateBps),
    intervalSlots: BigInt(intervalSlots),
  };

  console.log('[set-funding-params] Before:');
  console.log('  coefficient_bps:', before.fundingCoefficientBps.toString());
  console.log('  max_rate_bps:', before.maxFundingRateBps.toString());
  console.log('  interval_slots:', before.fundingIntervalSlots.toString());
  console.log('  last_funding_slot:', before.lastFundingSlot.toString());
  console.log('  cum_funding:', beforeCumFunding.toString());

  // Idempotent skip
  if (paramsAlreadySet(before, target)) {
    console.log('[set-funding-params] Params already match target (idempotent skip)');
    return { sig: null, updated: false };
  }

  // Build and send transaction
  const data = encodeSetFundingParams(coefficientBps, maxRateBps, intervalSlots);
  const tx = new Transaction().add(
    new TransactionInstruction({
      keys: [
        { pubkey: instPDA, isSigner: false, isWritable: true },
        { pubkey: regPDA, isSigner: false, isWritable: false },
        { pubkey: governanceKeypair.publicKey, isSigner: true, isWritable: false },
      ],
      programId: coreProgramId,
      data,
    }),
  );

  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.feePayer = governanceKeypair.publicKey;
  tx.sign(governanceKeypair);

  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction(sig, 'confirmed');
  console.log('[set-funding-params] TX:', sig);

  // Readback verification
  const afterInfo = await connection.getAccountInfo(instPDA);
  const after = decodeInstrumentFunding(afterInfo.data);
  const afterCumFunding = decodeCumFunding(afterInfo.data);

  console.log('[set-funding-params] After:');
  console.log('  coefficient_bps:', after.fundingCoefficientBps.toString());
  console.log('  max_rate_bps:', after.maxFundingRateBps.toString());
  console.log('  interval_slots:', after.fundingIntervalSlots.toString());
  console.log('  last_funding_slot:', after.lastFundingSlot.toString());
  console.log('  cum_funding:', afterCumFunding.toString());

  // Verify parameters applied
  if (after.fundingCoefficientBps !== target.coefficientBps) {
    throw new Error(`on-chain coefficient_bps ${after.fundingCoefficientBps} did not match target ${target.coefficientBps}`);
  }
  if (after.maxFundingRateBps !== target.maxRateBps) {
    throw new Error(`on-chain max_rate_bps ${after.maxFundingRateBps} did not match target ${target.maxRateBps}`);
  }
  if (after.fundingIntervalSlots !== target.intervalSlots) {
    throw new Error(`on-chain interval_slots ${after.fundingIntervalSlots} did not match target ${target.intervalSlots}`);
  }

  // Verify cum_funding preserved
  if (afterCumFunding !== beforeCumFunding) {
    throw new Error(`cum_funding changed: ${beforeCumFunding} -> ${afterCumFunding} (expected unchanged)`);
  }

  // Verify last_funding_slot was reset (should be >= tx confirmation slot)
  if (after.lastFundingSlot <= before.lastFundingSlot && before.lastFundingSlot !== 0n) {
    throw new Error(`last_funding_slot was not reset: ${after.lastFundingSlot} <= ${before.lastFundingSlot}`);
  }

  return { sig, updated: true };
}

async function main() {
  loadEnvLocal();
  const { coefficientBps, maxRateBps, intervalSlots, instrumentPubkey } = parseArgs(process.argv);

  // Validate args before connecting
  encodeSetFundingParams(coefficientBps, maxRateBps, intervalSlots);

  const rpc = process.env.RPC_URL || process.env.NEXT_PUBLIC_RPC_URL || 'https://api.devnet.solana.com';
  let rpcHost = 'invalid-rpc';
  try {
    rpcHost = new URL(rpc).host;
  } catch {
    /* keep invalid-rpc */
  }

  const kpPath = process.env.DEPLOYER_KEYPAIR || process.env.KEEPER_KEYPAIR || join(homedir(), '.config/solana/id.json');
  const conn = new Connection(rpc, 'confirmed');
  const gov = loadKP(kpPath);

  console.log('=== SetFundingParams (disc 24) ===');
  console.log('RPC host:', rpcHost);
  console.log('Governance:', gov.publicKey.toBase58());
  console.log('Target: coefficient', coefficientBps, 'bps / max_rate', maxRateBps, 'bps / interval', intervalSlots, 'slots');

  await setFundingParams({
    connection: conn,
    governanceKeypair: gov,
    coefficientBps,
    maxRateBps,
    intervalSlots,
    instrumentAccount: instrumentPubkey,
  });
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}

module.exports = {
  setFundingParams,
  encodeSetFundingParams,
  buildSetFundingParamsInstruction,
  decodeInstrumentFunding,
  decodeCumFunding,
  paramsAlreadySet,
};
