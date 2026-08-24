'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  decideLiquidation,
  encodeLiquidateUser,
  decodePortfolioHealth,
} = require('./ops-liquidate');

test('LiquidateUser is skipped when the portfolio is healthy', () => {
  const d = decideLiquidation({
    health: 1n,
    positionsLen: 1,
    markValid: 1,
    liqPaused: 0,
    liquidationsPaused: false,
    batchStatus: 3,
  });
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, 'healthy');
});

test('LiquidateUser is skipped when DFBA mark is invalid or liq is paused', () => {
  const invalid = decideLiquidation({
    health: -10n,
    positionsLen: 1,
    markValid: 0,
    liqPaused: 1,
    liquidationsPaused: false,
    batchStatus: 3,
  });
  assert.equal(invalid.action, 'skip');
  assert.equal(invalid.reason, 'mark_invalid');

  const paused = decideLiquidation({
    health: -10n,
    positionsLen: 1,
    markValid: 1,
    liqPaused: 0,
    liquidationsPaused: true,
    batchStatus: 3,
  });
  assert.equal(paused.action, 'skip');
  assert.equal(paused.reason, 'liquidations_paused');
});

test('LiquidateUser is skipped unless the mark batch is Settled', () => {
  const d = decideLiquidation({
    health: -10n,
    positionsLen: 1,
    markValid: 1,
    liqPaused: 0,
    liquidationsPaused: false,
    batchStatus: 0,
  });
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, 'batch_not_settled');
});

test('underwater portfolio with valid DFBA mark is liquidatable', () => {
  const d = decideLiquidation({
    health: -1n,
    positionsLen: 1,
    markValid: 1,
    liqPaused: 0,
    liquidationsPaused: false,
    batchStatus: 3,
  });
  assert.equal(d.action, 'liquidate');
  assert.equal(d.reason, 'underwater');
});

test('encodeLiquidateUser is disc 9 + num_instruments u16 LE', () => {
  const buf = encodeLiquidateUser(1);
  assert.equal(buf.length, 3);
  assert.equal(buf[0], 9);
  assert.equal(buf.readUInt16LE(1), 1);
});

test('decodePortfolioHealth reads health i128 @ 128 and positions_len u16 @ 144', () => {
  const data = Buffer.alloc(1456);
  // health = -42 as i128 LE
  data.writeBigUInt64LE(BigInt.asUintN(64, -42n), 128);
  data.writeBigInt64LE(-1n, 136);
  data.writeUInt16LE(2, 144);
  const p = decodePortfolioHealth(data);
  assert.equal(p.health, -42n);
  assert.equal(p.positionsLen, 2);
});
