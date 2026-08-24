'use strict';

const BATCH_STATUS_SETTLED = 3;
const LIQUIDATE_DISC = 9;
const HEALTH_OFFSET = 128;
const POSITIONS_LEN_OFFSET = 144;

function readI128LE(buf, offset) {
  const lo = buf.readBigUInt64LE(offset);
  const hi = buf.readBigInt64LE(offset + 8);
  return (hi << 64n) + lo;
}

function decodePortfolioHealth(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length < POSITIONS_LEN_OFFSET + 2) {
    throw new Error('portfolio buffer too small');
  }
  return {
    health: readI128LE(buf, HEALTH_OFFSET),
    positionsLen: buf.readUInt16LE(POSITIONS_LEN_OFFSET),
  };
}

function encodeLiquidateUser(numInstruments) {
  const n = Number(numInstruments);
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) {
    throw new Error('num_instruments must be u16');
  }
  const buf = Buffer.alloc(3);
  buf[0] = LIQUIDATE_DISC;
  buf.writeUInt16LE(n, 1);
  return buf;
}

function decideLiquidation(p) {
  const health = p.health == null ? 0n : BigInt(p.health);
  const positionsLen = p.positionsLen || 0;
  if (!positionsLen) {
    return { action: 'skip', reason: 'no_positions' };
  }
  if (health >= 0n) {
    return { action: 'skip', reason: 'healthy' };
  }
  if (p.batchStatus !== BATCH_STATUS_SETTLED) {
    return { action: 'skip', reason: 'batch_not_settled' };
  }
  if (!p.markValid || p.liqPaused) {
    return { action: 'skip', reason: 'mark_invalid' };
  }
  if (p.liquidationsPaused) {
    return { action: 'skip', reason: 'liquidations_paused' };
  }
  return { action: 'liquidate', reason: 'underwater' };
}

module.exports = {
  BATCH_STATUS_SETTLED,
  LIQUIDATE_DISC,
  decodePortfolioHealth,
  encodeLiquidateUser,
  decideLiquidation,
  readI128LE,
};
