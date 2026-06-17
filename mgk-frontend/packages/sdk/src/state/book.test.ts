import { describe, it, expect } from 'vitest';
import {
  BOOK_HEADER_SIZE,
  decodeBookHeader,
  type BookHeader,
} from './index.js';
import { encodeBookHeader } from './__test-helpers.js';

function emptyLevel() {
  return { price: 0n, totalQty: 0n, orderCount: 0, firstOrderOffset: 0 };
}

function sampleBookHeader(): BookHeader {
  return {
    instrumentId: 7,
    bestBid: 150_000_000n,
    bestAsk: 150_500_000n,
    bidCount: 2,
    askCount: 1,
    nextOrderId: 1024n,
    lastUpdateSlot: 999_999n,
    bids: [
      emptyLevel(),
      { price: 150_000_000n, totalQty: 3_000_000n, orderCount: 2, firstOrderOffset: 0 },
      { price: 149_900_000n, totalQty: 1_500_000n, orderCount: 1, firstOrderOffset: 5 },
    ],
    asks: [
      emptyLevel(),
      { price: 150_500_000n, totalQty: 2_000_000n, orderCount: 1, firstOrderOffset: 7 },
      emptyLevel(),
    ],
  };
}

describe('decodeBookHeader', () => {
  it('round-trips a known Book header', () => {
    const original = sampleBookHeader();
    const buf = encodeBookHeader(original);
    expect(buf.length).toBe(BOOK_HEADER_SIZE);
    const decoded = decodeBookHeader(buf);

    expect(decoded.instrumentId).toBe(original.instrumentId);
    expect(decoded.bestBid).toBe(original.bestBid);
    expect(decoded.bestAsk).toBe(original.bestAsk);
    expect(decoded.bidCount).toBe(original.bidCount);
    expect(decoded.askCount).toBe(original.askCount);
    expect(decoded.nextOrderId).toBe(original.nextOrderId);
    expect(decoded.lastUpdateSlot).toBe(original.lastUpdateSlot);
  });

  it('decodes populated bid and ask levels at their array indices', () => {
    const original = sampleBookHeader();
    const decoded = decodeBookHeader(encodeBookHeader(original));

    expect(decoded.bids.length).toBe(64);
    expect(decoded.asks.length).toBe(64);

    expect(decoded.bids[0]).toEqual(emptyLevel());
    expect(decoded.bids[1]).toEqual(original.bids[1]);
    expect(decoded.bids[2]).toEqual(original.bids[2]);

    expect(decoded.asks[0]).toEqual(emptyLevel());
    expect(decoded.asks[1]).toEqual(original.asks[1]);
    expect(decoded.asks[2]).toEqual(emptyLevel());
  });

  it('handles a zeroed book (no orders)', () => {
    const zeroed: BookHeader = {
      instrumentId: 0,
      bestBid: 0n,
      bestAsk: 0n,
      bidCount: 0,
      askCount: 0,
      nextOrderId: 0n,
      lastUpdateSlot: 0n,
      bids: Array.from({ length: 64 }, emptyLevel),
      asks: Array.from({ length: 64 }, emptyLevel),
    };
    const decoded = decodeBookHeader(encodeBookHeader(zeroed));
    expect(decoded.bestBid).toBe(0n);
    expect(decoded.bestAsk).toBe(0n);
    expect(decoded.bidCount).toBe(0);
    expect(decoded.askCount).toBe(0);
  });

  it('handles negative i64 prices (bestBid/bestAsk)', () => {
    const negative: BookHeader = {
      ...sampleBookHeader(),
      bestBid: -1n,
      bestAsk: -1n,
    };
    const decoded = decodeBookHeader(encodeBookHeader(negative));
    expect(decoded.bestBid).toBe(-1n);
    expect(decoded.bestAsk).toBe(-1n);
  });

  it('throws when buffer is too small', () => {
    expect(() => decodeBookHeader(new Uint8Array(100))).toThrow(/too small/);
  });
});
