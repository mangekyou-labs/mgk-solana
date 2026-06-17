import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';

import { decodePriceOracle, PRICE_ORACLE_MAGIC, PRICE_ORACLE_SIZE, PRICE_ORACLE_VERSION } from './oracle.js';

function makeOracleBytes(opts: {
  magic?: bigint;
  version?: number;
  bump?: number;
  isActive?: boolean;
  authority?: PublicKey;
  instrument?: PublicKey;
  price?: bigint;
  timestamp?: bigint;
  confidence?: bigint;
}): Uint8Array {
  const buf = new Uint8Array(PRICE_ORACLE_SIZE);
  const view = new DataView(buf.buffer);
  const magic = opts.magic ?? PRICE_ORACLE_MAGIC;
  view.setBigUint64(0, magic, true);
  view.setUint8(8, opts.version ?? PRICE_ORACLE_VERSION);
  view.setUint8(9, opts.bump ?? 255);
  view.setUint8(10, opts.isActive === false ? 0 : 1);
  // 5 bytes of _padding stay 0
  const authority = opts.authority ?? new PublicKey(new Uint8Array(32).fill(0xaa));
  buf.set(authority.toBytes(), 16);
  const instrument = opts.instrument ?? new PublicKey(new Uint8Array(32).fill(0xbb));
  buf.set(instrument.toBytes(), 48);
  view.setBigInt64(80, opts.price ?? 150_420_000n, true);
  view.setBigInt64(88, opts.timestamp ?? 1_700_000_000n, true);
  view.setBigInt64(96, opts.confidence ?? 50_000n, true);
  // 24 bytes of _reserved stay 0
  return buf;
}

describe('decodePriceOracle', () => {
  it('decodes a well-formed 128-byte oracle account', () => {
    const authority = new PublicKey(new Uint8Array(32).fill(0x01));
    const instrument = new PublicKey(new Uint8Array(32).fill(0x02));
    const buf = makeOracleBytes({
      bump: 254,
      isActive: true,
      authority,
      instrument,
      price: 150_420_000n,
      timestamp: 1_700_000_000n,
      confidence: 50_000n,
    });
    const out = decodePriceOracle(buf);
    expect(out.magic).toBe(PRICE_ORACLE_MAGIC);
    expect(out.version).toBe(PRICE_ORACLE_VERSION);
    expect(out.bump).toBe(254);
    expect(out.isActive).toBe(true);
    expect(out.authority.toBase58()).toBe(authority.toBase58());
    expect(out.instrument.toBase58()).toBe(instrument.toBase58());
    expect(out.price).toBe(150_420_000n);
    expect(out.timestamp).toBe(1_700_000_000n);
    expect(out.confidence).toBe(50_000n);
  });

  it('decodes isActive=false as false', () => {
    const buf = makeOracleBytes({ isActive: false });
    expect(decodePriceOracle(buf).isActive).toBe(false);
  });

  it('decodes a negative price (downward move)', () => {
    const buf = makeOracleBytes({ price: -123_456_789n });
    expect(decodePriceOracle(buf).price).toBe(-123_456_789n);
  });

  it('throws when the buffer is too small', () => {
    const small = new Uint8Array(64);
    expect(() => decodePriceOracle(small)).toThrow(/too small/i);
  });

  it('throws on bad magic', () => {
    const buf = makeOracleBytes({ magic: 0xdeadbeefcafebaben });
    expect(() => decodePriceOracle(buf)).toThrow(/invalid magic/i);
  });

  it('throws on unsupported version', () => {
    const buf = makeOracleBytes({ version: 99 });
    expect(() => decodePriceOracle(buf)).toThrow(/unsupported version/i);
  });
});

describe('PRICE_ORACLE_SIZE', () => {
  it('is 128 bytes', () => {
    expect(PRICE_ORACLE_SIZE).toBe(128);
  });
});
