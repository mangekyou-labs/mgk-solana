'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  encodeSetFundingParams,
  buildSetFundingParamsInstruction,
  decodeInstrumentFunding,
  decodeCumFunding,
} = require('./set-funding-params');

// ---------------------------------------------------------------------------
// 1. Buffer encoding tests — disc 24 + i64/i64/u64 LE
// ---------------------------------------------------------------------------

test('encodeSetFundingParams produces 25-byte buffer with disc 24', () => {
  const buf = encodeSetFundingParams(10_000, 50, 100);
  assert.equal(buf.length, 25);
  assert.equal(buf[0], 24); // discriminator
});

test('encodeSetFundingParams writes coefficient_bps as i64 LE at offset 1', () => {
  const buf = encodeSetFundingParams(10_000, 50, 100);
  assert.equal(buf.readBigInt64LE(1), 10_000n);
});

test('encodeSetFundingParams writes max_rate_bps as i64 LE at offset 9', () => {
  const buf = encodeSetFundingParams(10_000, 50, 100);
  assert.equal(buf.readBigInt64LE(9), 50n);
});

test('encodeSetFundingParams writes interval_slots as u64 LE at offset 17', () => {
  const buf = encodeSetFundingParams(10_000, 50, 100);
  assert.equal(buf.readBigUInt64LE(17), 100n);
});

test('encodeSetFundingParams handles large values without overflow', () => {
  const buf = encodeSetFundingParams(2_000_000, 1_000, 500_000);
  assert.equal(buf.readBigInt64LE(1), 2_000_000n);
  assert.equal(buf.readBigInt64LE(9), 1_000n);
  assert.equal(buf.readBigUInt64LE(17), 500_000n);
});

test('encodeSetFundingParams handles zero values', () => {
  const buf = encodeSetFundingParams(0, 0, 1);
  assert.equal(buf.readBigInt64LE(1), 0n);
  assert.equal(buf.readBigInt64LE(9), 0n);
  assert.equal(buf.readBigUInt64LE(17), 1n);
});

// ---------------------------------------------------------------------------
// 2. Account order tests — instrument(writable), registry, governance(signer)
// ---------------------------------------------------------------------------

test('buildSetFundingParamsInstruction orders accounts correctly', () => {
  const { PublicKey } = require('@solana/web3.js');
  const inst = new PublicKey('11111111111111111111111111111111');
  const reg = new PublicKey('11111111111111111111111111111112');
  const gov = new PublicKey('11111111111111111111111111111113');
  const ix = buildSetFundingParamsInstruction({
    instrument: inst,
    registry: reg,
    governance: gov,
    coefficientBps: 10_000,
    maxRateBps: 50,
    intervalSlots: 100,
  });

  assert.equal(ix.keys.length, 3);
  // Account 0: instrument — writable, not signer
  assert.equal(ix.keys[0].pubkey.toBase58(), inst.toBase58());
  assert.equal(ix.keys[0].isWritable, true);
  assert.equal(ix.keys[0].isSigner, false);
  // Account 1: registry — not writable, not signer
  assert.equal(ix.keys[1].pubkey.toBase58(), reg.toBase58());
  assert.equal(ix.keys[1].isWritable, false);
  assert.equal(ix.keys[1].isSigner, false);
  // Account 2: governance — not writable, signer
  assert.equal(ix.keys[2].pubkey.toBase58(), gov.toBase58());
  assert.equal(ix.keys[2].isWritable, false);
  assert.equal(ix.keys[2].isSigner, true);
});

test('buildSetFundingParamsInstruction uses CORE_ID as programId', () => {
  const { PublicKey } = require('@solana/web3.js');
  const ix = buildSetFundingParamsInstruction({
    instrument: PublicKey.default,
    registry: PublicKey.default,
    governance: PublicKey.default,
    coefficientBps: 10_000,
    maxRateBps: 50,
    intervalSlots: 100,
  });
  assert.equal(ix.programId.toBase58(), 'C7w2mKz2KQgDroNNhACm9MutXhPiesVr9Gn2x8TDsRYx');
});

// ---------------------------------------------------------------------------
// 3. Argument bounds tests
// ---------------------------------------------------------------------------

test('encodeSetFundingParams rejects negative coefficient_bps', () => {
  assert.throws(() => encodeSetFundingParams(-1, 50, 100), /coefficient_bps must be non-negative/);
});

test('encodeSetFundingParams rejects negative max_rate_bps', () => {
  assert.throws(() => encodeSetFundingParams(10_000, -1, 100), /max_rate_bps must be non-negative/);
});

test('encodeSetFundingParams rejects zero interval_slots', () => {
  assert.throws(() => encodeSetFundingParams(10_000, 50, 0), /interval_slots must be non-zero/);
});

test('encodeSetFundingParams rejects non-integer coefficient_bps', () => {
  assert.throws(() => encodeSetFundingParams(1.5, 50, 100), /must be an integer/);
});

test('encodeSetFundingParams rejects non-integer max_rate_bps', () => {
  assert.throws(() => encodeSetFundingParams(10_000, 1.5, 100), /must be an integer/);
});

test('encodeSetFundingParams rejects non-integer interval_slots', () => {
  assert.throws(() => encodeSetFundingParams(10_000, 50, 1.5), /must be an integer/);
});

// ---------------------------------------------------------------------------
// 4. Signed-i128 account decoding tests — cum_funding at offset 96
// ---------------------------------------------------------------------------

test('decodeCumFunding reads i128 LE from offset 96', () => {
  const buf = Buffer.alloc(336);
  buf.writeBigInt64LE(42n, 96);
  buf.writeBigInt64LE(0n, 104);
  const val = decodeCumFunding(buf);
  assert.equal(val, 42n);
});

test('decodeCumFunding handles negative values', () => {
  const buf = Buffer.alloc(336);
  // Write -42 as i128 LE: lo = -42 as i64, hi = -1 as i64 (sign extension)
  buf.writeBigInt64LE(-42n, 96);
  buf.writeBigInt64LE(-1n, 104);
  const val = decodeCumFunding(buf);
  assert.equal(val, -42n);
});

// ---------------------------------------------------------------------------
// 5. Instrument funding field decode tests
// ---------------------------------------------------------------------------

test('decodeInstrumentFunding reads all three fields correctly', () => {
  const buf = Buffer.alloc(336);
  // funding_interval_slots at struct offset 120 (u64)
  buf.writeBigUInt64LE(100n, 120);
  // funding_coefficient_bps at offset 160 (i64)
  buf.writeBigInt64LE(10_000n, 160);
  // max_funding_rate_bps at offset 176 (i64)
  buf.writeBigInt64LE(50n, 176);

  const f = decodeInstrumentFunding(buf);
  assert.equal(f.fundingCoefficientBps, 10_000n);
  assert.equal(f.maxFundingRateBps, 50n);
  assert.equal(f.fundingIntervalSlots, 100n);
});

test('decodeInstrumentFunding reads pre-D7 defaults (1/50/100)', () => {
  const buf = Buffer.alloc(336);
  buf.writeBigUInt64LE(100n, 120);
  buf.writeBigInt64LE(1n, 160);
  buf.writeBigInt64LE(50n, 176);

  const f = decodeInstrumentFunding(buf);
  assert.equal(f.fundingCoefficientBps, 1n);
  assert.equal(f.maxFundingRateBps, 50n);
  assert.equal(f.fundingIntervalSlots, 100n);
});

test('decodeInstrumentFunding reads D7 target (10000/50/100)', () => {
  const buf = Buffer.alloc(336);
  buf.writeBigUInt64LE(100n, 120);
  buf.writeBigInt64LE(10_000n, 160);
  buf.writeBigInt64LE(50n, 176);

  const f = decodeInstrumentFunding(buf);
  assert.equal(f.fundingCoefficientBps, 10_000n);
  assert.equal(f.maxFundingRateBps, 50n);
  assert.equal(f.fundingIntervalSlots, 100n);
});

// ---------------------------------------------------------------------------
// 6. last_funding_slot decode at offset 112 (u64)
// ---------------------------------------------------------------------------

test('decodeInstrumentFunding reads last_funding_slot at offset 112', () => {
  const buf = Buffer.alloc(336);
  buf.writeBigUInt64LE(12345n, 112);
  buf.writeBigUInt64LE(100n, 120);
  buf.writeBigInt64LE(10_000n, 160);
  buf.writeBigInt64LE(50n, 176);

  const f = decodeInstrumentFunding(buf);
  assert.equal(f.lastFundingSlot, 12345n);
});

// ---------------------------------------------------------------------------
// 7. Payload byte layout regression pin
// ---------------------------------------------------------------------------

test('discriminator-24 payload is exactly i64+i64+u64 = 24 bytes after disc', () => {
  const buf = encodeSetFundingParams(1, 2, 3);
  // disc(1) + coefficient(8) + max_rate(8) + interval(8) = 25
  assert.equal(buf.length, 25);
  // Verify exact byte positions
  assert.deepEqual(Array.from(buf.subarray(1, 9)), Array.from(Buffer.from([1, 0, 0, 0, 0, 0, 0, 0])));
  assert.deepEqual(Array.from(buf.subarray(9, 17)), Array.from(Buffer.from([2, 0, 0, 0, 0, 0, 0, 0])));
  assert.deepEqual(Array.from(buf.subarray(17, 25)), Array.from(Buffer.from([3, 0, 0, 0, 0, 0, 0, 0])));
});
