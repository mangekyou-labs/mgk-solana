import { describe, expect, it } from 'vitest';
import { decodeFills } from './decoder.js';

describe('decodeFills', () => {
  it('decodes an empty results account (no fills)', () => {
    const buf = new Uint8Array(2);
    const view = new DataView(buf.buffer);
    view.setUint16(0, 0, true); // num_fills = 0
    const fills = decodeFills(buf, 100, 1n, 0, 'sig', 0);
    expect(fills).toHaveLength(0);
  });

  it('returns empty array for data shorter than 2 bytes', () => {
    const fills = decodeFills(new Uint8Array(1), 100, 1n, 0, 'sig', 0);
    expect(fills).toHaveLength(0);
  });

  it('decodes a single fill', () => {
    const user = new Uint8Array(32).fill(0x42);
    const buf = new Uint8Array(2 + 49);
    const view = new DataView(buf.buffer);
    view.setUint16(0, 1, true);
    buf.set(user, 2);
    view.setBigUint64(34, 1000n, true); // qty
    view.setBigUint64(42, 150000n, true); // notional
    view.setUint8(50, 0); // not maker

    const fills = decodeFills(buf, 42, 7n, 0, 'txsig123', 1);
    expect(fills).toHaveLength(1);
    expect(fills[0]!.slot).toBe(42);
    expect(fills[0]!.batchId).toBe(7n);
    expect(fills[0]!.qty).toBe(1000n);
  });

  it('skips fills with zero qty', () => {
    const buf = new Uint8Array(2 + 49);
    const view = new DataView(buf.buffer);
    view.setUint16(0, 1, true);
    view.setBigUint64(34, 0n, true); // qty = 0
    view.setBigUint64(42, 100n, true); // notional

    const fills = decodeFills(buf, 1, 1n, 0, 'sig', 0);
    expect(fills).toHaveLength(0);
  });
});
