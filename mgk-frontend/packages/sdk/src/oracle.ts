import { PublicKey } from '@solana/web3.js';

import { InstructionReader, readBytes } from './instruction.js';

/**
 * Mirror of `programs/oracle/src/state.rs` `PriceOracle` struct.
 *
 * Layout (128 bytes, all little-endian):
 *   0..8    magic:        u64   (LE; must equal PRICE_ORACLE_MAGIC)
 *   8       version:      u8    (must equal PRICE_ORACLE_VERSION = 0)
 *   9       bump:         u8
 *   10      is_active:    u8   (bool, 0 or 1)
 *   11..16  _padding:     [u8; 5]
 *   16..48  authority:    Pubkey (32 bytes)
 *   48..80  instrument:   Pubkey (32 bytes)
 *   80..88  price:        i64 (LE, scaled by 1_000_000)
 *   88..96  timestamp:    i64 (LE, unix seconds)
 *   96..104 confidence:   i64 (LE, scaled by 1_000_000)
 *   104..128 _reserved:    [u8; 24]
 */
export const PRICE_ORACLE_SIZE = 128;

/**
 * Magic bytes the oracle writes at offset 0 — `b"PRCLORCL"` as a
 * little-endian u64. The literal hex below is the LE interpretation:
 *   P=0x50, R=0x52, C=0x43, L=0x4c, O=0x4f, R=0x52, C=0x43, L=0x4c
 *   → 0x4c43524f_4c435250 (LE) → 0x4c43524f4c435250 as a number literal.
 */
export const PRICE_ORACLE_MAGIC = 0x4c43524f4c435250n;

/** Current schema version. */
export const PRICE_ORACLE_VERSION = 0;

export interface DecodedPriceOracle {
  magic: bigint;
  version: number;
  bump: number;
  isActive: boolean;
  authority: PublicKey;
  instrument: PublicKey;
  price: bigint;
  timestamp: bigint;
  confidence: bigint;
}

/**
 * Decode a 128-byte `PriceOracle` account. Throws if the buffer is
 * too small or the magic doesn't match.
 */
export function decodePriceOracle(buf: Uint8Array): DecodedPriceOracle {
  if (buf.length < PRICE_ORACLE_SIZE) {
    throw new Error(
      `decodePriceOracle: buffer too small (${buf.length} < ${PRICE_ORACLE_SIZE})`,
    );
  }

  const r = new InstructionReader(buf);
  const magic = r.readU64();
  const version = r.readU8();
  const bump = r.readU8();
  const isActive = r.readU8() !== 0;
  // 5 bytes of padding — skip via raw read.
  r.readBytes(5);
  const authority = new PublicKey(readBytes(buf, r.position, 32));
  r.readBytes(32);
  const instrument = new PublicKey(readBytes(buf, r.position, 32));
  r.readBytes(32);
  const price = r.readI64();
  const timestamp = r.readI64();
  const confidence = r.readI64();
  // 24 bytes of _reserved — total reaches 128.

  if (magic !== PRICE_ORACLE_MAGIC) {
    throw new Error(
      `decodePriceOracle: invalid magic 0x${magic.toString(16)}, expected 0x${PRICE_ORACLE_MAGIC.toString(16)}`,
    );
  }
  if (version !== PRICE_ORACLE_VERSION) {
    throw new Error(
      `decodePriceOracle: unsupported version ${version}, expected ${PRICE_ORACLE_VERSION}`,
    );
  }

  return {
    magic,
    version,
    bump,
    isActive,
    authority,
    instrument,
    price,
    timestamp,
    confidence,
  };
}

