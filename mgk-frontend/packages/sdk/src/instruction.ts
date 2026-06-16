export class InstructionReadError extends Error {
  public readonly offset: number;

  constructor(message: string, offset: number) {
    super(message);
    this.name = 'InstructionReadError';
    this.offset = offset;
  }
}

export const Side = {
  Buy: 0,
  Sell: 1,
} as const;
export type Side = (typeof Side)[keyof typeof Side];

function checkBounds(
  data: Uint8Array,
  offset: number,
  size: number,
  fn: string,
): void {
  if (offset + size > data.length) {
    throw new InstructionReadError(
      `${fn}: offset ${offset}+${size} > length ${data.length}`,
      offset,
    );
  }
}

export function readU8(data: Uint8Array, offset: number): number {
  if (offset >= data.length) {
    throw new InstructionReadError(
      `readU8: offset ${offset} >= length ${data.length}`,
      offset,
    );
  }
  return data[offset] as number;
}

export function readU16(data: Uint8Array, offset: number): number {
  checkBounds(data, offset, 2, 'readU16');
  const view = new DataView(data.buffer, data.byteOffset + offset, 2);
  return view.getUint16(0, true);
}

export function readU32(data: Uint8Array, offset: number): number {
  checkBounds(data, offset, 4, 'readU32');
  const view = new DataView(data.buffer, data.byteOffset + offset, 4);
  return view.getUint32(0, true);
}

export function readU64(data: Uint8Array, offset: number): bigint {
  checkBounds(data, offset, 8, 'readU64');
  const view = new DataView(data.buffer, data.byteOffset + offset, 8);
  return view.getBigUint64(0, true);
}

export function readI64(data: Uint8Array, offset: number): bigint {
  checkBounds(data, offset, 8, 'readI64');
  const view = new DataView(data.buffer, data.byteOffset + offset, 8);
  return view.getBigInt64(0, true);
}

export function readU128(data: Uint8Array, offset: number): bigint {
  checkBounds(data, offset, 16, 'readU128');
  const view = new DataView(data.buffer, data.byteOffset + offset, 16);
  const lo = view.getBigUint64(0, true);
  const hi = view.getBigUint64(8, true);
  return (hi << 64n) + lo;
}

export function readBytes(
  data: Uint8Array,
  offset: number,
  length: number,
): Uint8Array {
  if (offset + length > data.length) {
    throw new InstructionReadError(
      `readBytes: offset ${offset}+${length} > length ${data.length}`,
      offset,
    );
  }
  return data.slice(offset, offset + length);
}

export function readSide(data: Uint8Array, offset: number): Side {
  const v = readU8(data, offset);
  if (v === Side.Buy) return Side.Buy;
  if (v === Side.Sell) return Side.Sell;
  throw new InstructionReadError(
    `readSide: invalid side byte ${v} (expected 0=Buy or 1=Sell)`,
    offset,
  );
}

export class InstructionReader {
  private offset = 0;

  constructor(private readonly data: Uint8Array) {}

  get position(): number {
    return this.offset;
  }

  get remaining(): number {
    return Math.max(0, this.data.length - this.offset);
  }

  readU8(): number {
    const val = readU8(this.data, this.offset);
    this.offset += 1;
    return val;
  }

  readU16(): number {
    const val = readU16(this.data, this.offset);
    this.offset += 2;
    return val;
  }

  readU32(): number {
    const val = readU32(this.data, this.offset);
    this.offset += 4;
    return val;
  }

  readU64(): bigint {
    const val = readU64(this.data, this.offset);
    this.offset += 8;
    return val;
  }

  readI64(): bigint {
    const val = readI64(this.data, this.offset);
    this.offset += 8;
    return val;
  }

  readU128(): bigint {
    const val = readU128(this.data, this.offset);
    this.offset += 16;
    return val;
  }

  readBytes(length: number): Uint8Array {
    const val = readBytes(this.data, this.offset, length);
    this.offset += length;
    return val;
  }

  readSide(): Side {
    const val = readSide(this.data, this.offset);
    this.offset += 1;
    return val;
  }
}
