import { describe, it, expect } from 'vitest';
import {
  InstructionReadError,
  InstructionReader,
  Side,
  readBytes,
  readI64,
  readSide,
  readU8,
  readU16,
  readU32,
  readU64,
  readU128,
} from './instruction.js';

describe('readU8', () => {
  it('reads a u8 at a valid offset', () => {
    const data = new Uint8Array([42, 0, 0, 0]);
    expect(readU8(data, 0)).toBe(42);
  });

  it('throws when offset is out of bounds', () => {
    const data = new Uint8Array([42, 0, 0, 0]);
    expect(() => readU8(data, 4)).toThrow(InstructionReadError);
  });
});

describe('readU16', () => {
  it('reads a u16 little-endian at offset 0', () => {
    const data = new Uint8Array([0x34, 0x12, 0, 0]);
    expect(readU16(data, 0)).toBe(0x1234);
  });

  it('throws when 2 bytes are not available', () => {
    const data = new Uint8Array([0x34, 0x12, 0, 0]);
    expect(() => readU16(data, 3)).toThrow(InstructionReadError);
  });
});

describe('readU32', () => {
  it('reads a u32 little-endian at offset 0', () => {
    const data = new Uint8Array([0x78, 0x56, 0x34, 0x12]);
    expect(readU32(data, 0)).toBe(0x12345678);
  });

  it('throws when 4 bytes are not available', () => {
    const data = new Uint8Array([0x78, 0x56, 0x34, 0x12]);
    expect(() => readU32(data, 1)).toThrow(InstructionReadError);
  });
});

describe('readU64', () => {
  it('reads a u64 little-endian at offset 0', () => {
    const data = new Uint8Array([0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01]);
    expect(readU64(data, 0)).toBe(0x0102030405060708n);
  });

  it('throws when 8 bytes are not available', () => {
    const data = new Uint8Array([0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01]);
    expect(() => readU64(data, 1)).toThrow(InstructionReadError);
  });
});

describe('readI64', () => {
  it('reads a negative i64 (sign bit set)', () => {
    const data = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    expect(readI64(data, 0)).toBe(-1n);
  });

  it('reads -2 in two’s complement', () => {
    const data = new Uint8Array([0xfe, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    expect(readI64(data, 0)).toBe(-2n);
  });
});

describe('readU128', () => {
  it('reads a u128 little-endian at offset 0', () => {
    const data = new Uint8Array([
      0x10, 0x0f, 0x0e, 0x0d, 0x0c, 0x0b, 0x0a, 0x09,
      0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01,
    ]);
    expect(readU128(data, 0)).toBe(0x0102030405060708090a0b0c0d0e0f10n);
  });

  it('throws when 16 bytes are not available', () => {
    const data = new Uint8Array(15);
    expect(() => readU128(data, 0)).toThrow(InstructionReadError);
  });
});

describe('readBytes', () => {
  it('slices the requested number of bytes', () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const out = readBytes(data, 1, 3);
    expect(Array.from(out)).toEqual([2, 3, 4]);
  });

  it('throws when length bytes are not available', () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    expect(() => readBytes(data, 2, 4)).toThrow(InstructionReadError);
  });
});

describe('readSide', () => {
  it('maps 0 to Buy', () => {
    const data = new Uint8Array([0, 1, 2]);
    expect(readSide(data, 0)).toBe(Side.Buy);
  });

  it('maps 1 to Sell', () => {
    const data = new Uint8Array([0, 1, 2]);
    expect(readSide(data, 1)).toBe(Side.Sell);
  });

  it('throws on any other value', () => {
    const data = new Uint8Array([0, 1, 2]);
    expect(() => readSide(data, 2)).toThrow(InstructionReadError);
  });
});

describe('InstructionReader', () => {
  it('tracks offset and remaining through sequential reads', () => {
    const data = new Uint8Array([
      42,           // u8
      0x34, 0x12,   // u16
      0x78, 0x56, 0x34, 0x12, // u32
    ]);
    const r = new InstructionReader(data);
    expect(r.remaining).toBe(7);
    expect(r.position).toBe(0);

    expect(r.readU8()).toBe(42);
    expect(r.position).toBe(1);
    expect(r.remaining).toBe(6);

    expect(r.readU16()).toBe(0x1234);
    expect(r.position).toBe(3);

    expect(r.readU32()).toBe(0x12345678);
    expect(r.position).toBe(7);
    expect(r.remaining).toBe(0);

    expect(() => r.readU8()).toThrow(InstructionReadError);
  });

  it('reads u64/u128/i64 as bigint', () => {
    const data = new Uint8Array(8 + 8 + 16);
    const dv = new DataView(data.buffer);
    dv.setBigUint64(0, 100n, true);
    dv.setBigInt64(8, -7n, true);
    dv.setBigUint64(16, 2n, true);
    dv.setBigUint64(24, 1n, true);

    const r = new InstructionReader(data);
    expect(r.readU64()).toBe(100n);
    expect(r.readI64()).toBe(-7n);
    expect(r.readU128()).toBe((1n << 64n) + 2n);
  });

  it('readBytes advances offset by length', () => {
    const data = new Uint8Array([10, 20, 30, 40, 50]);
    const r = new InstructionReader(data);
    expect(Array.from(r.readBytes(2))).toEqual([10, 20]);
    expect(r.position).toBe(2);
    expect(Array.from(r.readBytes(2))).toEqual([30, 40]);
    expect(r.position).toBe(4);
  });

  it('readSide advances offset by 1', () => {
    const data = new Uint8Array([0, 1, 0]);
    const r = new InstructionReader(data);
    expect(r.readSide()).toBe(Side.Buy);
    expect(r.position).toBe(1);
    expect(r.readSide()).toBe(Side.Sell);
    expect(r.position).toBe(2);
  });
});
