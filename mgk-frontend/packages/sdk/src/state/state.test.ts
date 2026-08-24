import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import {
  BATCH_SIZE,
  COMMITMENT_SIZE,
  PORTFOLIO_SIZE,
  BatchStatus,
  CommitmentStatus,
  OrderType,
  decodeBatch,
  decodeCommitment,
  decodeDfbaResultsHeader,
  decodePortfolio,
  decodeRevealedOrder,
} from './index.js';
import { Side } from '../instruction.js';
import {
  encodeBatch,
  encodeCommitment,
  encodePortfolio,
} from './__test-helpers.js';
import type {
  BatchState,
  CommitmentState,
  PortfolioState,
  RevealedOrder,
} from './types.js';

const USER = new PublicKey('A6qbhK9mPRpFhX7D1kZsBpr2xNy8mfgU5J7Vu9xLE5Rp');
const OTHER = new PublicKey('7cVFFx4CQp4dJ1qVAx7wEXBxg6ZJ8VfZz5cMqQGEYRBX');

function sampleBatchState(): BatchState {
  return {
    batchId: 42n,
    status: BatchStatus.Clearing,
    commitDeadlineSlot: 100_000n,
    revealDeadlineSlot: 100_100n,
    closeSlot: 100_200n,
    shuffleSeed: 0n,
    clearingPrice: 150_000_000n,
    totalCommitments: 7,
    totalRevealed: 6,
    totalSettled: 5,
    totalVolume: 9_876_543_210n,
    totalNotional: 1_481_481_481_500n,
    slashedDeposits: 123_456_789n,
    bump: 254,
    bidClearingPrice: 149_000_000n,
    askClearingPrice: 151_000_000n,
    matchedBidQty: 100n,
    matchedAskQty: 100n,
    markValid: true,
    liqPaused: false,
  };
}

function sampleRevealedOrder(): RevealedOrder {
  return {
    user: USER,
    price: 150_500_000n,
    qty: 1_000_000n,
    salt: 0x123456789abcdef0n,
    instrumentId: 1,
    commitmentIdx: 2,
    orderType: OrderType.LimitGTC,
    side: Side.Buy,
    reduceOnly: false,
  };
}

function sampleCommitmentState(): CommitmentState {
  return {
    batchId: 42n,
    user: USER,
    orderHash: new Uint8Array(32).map((_, i) => i + 1),
    depositLamports: 5_000_000_000n,
    status: CommitmentStatus.Revealed,
    nonce: 0xabcdef0123456789n,
    revealed: sampleRevealedOrder(),
  };
}

function samplePortfolioState(): PortfolioState {
  return {
    user: USER,
    equity: 10_000_000_000n,
    principal: 9_000_000_000n,
    pnl: 1_000_000_000n,
    im: 500_000_000n,
    mm: 250_000_000n,
    freeCollateral: 9_500_000_000n,
    health: 9_750_000_000n,
    positionsLen: 2,
    positions: [
      { instrumentId: 1, qty: 1_000_000_000n, entryVwap: 150_000_000n },
      { instrumentId: 2, qty: -500_000_000n, entryVwap: 2_500_000_000n },
    ],
    lastFundingCheckpoint: Array.from({ length: 32 }, (_, i) => BigInt(i * 1000)),
    lastBatchId: 41n,
    lastSlot: 99_999n,
    bump: 255,
  };
}

describe('decodeBatch', () => {
  it('round-trips a known Batch state', () => {
    const original = sampleBatchState();
    const buf = encodeBatch(original);
    expect(buf.length).toBe(BATCH_SIZE);
    const decoded = decodeBatch(buf);

    expect(decoded.batchId).toBe(original.batchId);
    expect(decoded.status).toBe(original.status);
    expect(decoded.commitDeadlineSlot).toBe(original.commitDeadlineSlot);
    expect(decoded.revealDeadlineSlot).toBe(original.revealDeadlineSlot);
    expect(decoded.closeSlot).toBe(original.closeSlot);
    expect(decoded.shuffleSeed).toBe(original.shuffleSeed);
    expect(decoded.clearingPrice).toBe(original.clearingPrice);
    expect(decoded.totalCommitments).toBe(original.totalCommitments);
    expect(decoded.totalRevealed).toBe(original.totalRevealed);
    expect(decoded.totalSettled).toBe(original.totalSettled);
    expect(decoded.totalVolume).toBe(original.totalVolume);
    expect(decoded.totalNotional).toBe(original.totalNotional);
    expect(decoded.slashedDeposits).toBe(original.slashedDeposits);
    expect(decoded.bump).toBe(original.bump);
    expect(decoded.bidClearingPrice).toBe(original.bidClearingPrice);
    expect(decoded.askClearingPrice).toBe(original.askClearingPrice);
    expect(decoded.matchedBidQty).toBe(original.matchedBidQty);
    expect(decoded.matchedAskQty).toBe(original.matchedAskQty);
    expect(decoded.markValid).toBe(true);
    expect(decoded.liqPaused).toBe(false);
  });

  it('throws when buffer is too small', () => {
    expect(() => decodeBatch(new Uint8Array(50))).toThrow(/too small/);
  });

  it('handles i128 boundary (negative clearingPrice)', () => {
    const s = { ...sampleBatchState(), clearingPrice: -1n };
    const decoded = decodeBatch(encodeBatch(s));
    expect(decoded.clearingPrice).toBe(-1n);
  });
});

describe('decodeDfbaResultsHeader', () => {
  it('decodes dual clear header', () => {
    const buf = new Uint8Array(34);
    const view = new DataView(buf.buffer);
    view.setBigInt64(0, 100n, true);
    view.setBigInt64(8, 110n, true);
    view.setBigUint64(16, 50n, true);
    view.setBigUint64(24, 40n, true);
    view.setUint16(32, 3, true);
    const r = decodeDfbaResultsHeader(buf);
    expect(r.bidClearingPrice).toBe(100n);
    expect(r.askClearingPrice).toBe(110n);
    expect(r.matchedBidQty).toBe(50n);
    expect(r.matchedAskQty).toBe(40n);
    expect(r.numFills).toBe(3);
  });
});

describe('decodeCommitment', () => {
  it('round-trips a known Commitment state', () => {
    const original = sampleCommitmentState();
    const buf = encodeCommitment(original);
    expect(buf.length).toBe(COMMITMENT_SIZE);
    const decoded = decodeCommitment(buf);

    expect(decoded.batchId).toBe(original.batchId);
    expect(decoded.user.toBase58()).toBe(original.user.toBase58());
    expect(Array.from(decoded.orderHash)).toEqual(
      Array.from(original.orderHash),
    );
    expect(decoded.depositLamports).toBe(original.depositLamports);
    expect(decoded.status).toBe(original.status);
    expect(decoded.nonce).toBe(original.nonce);

    const r = decoded.revealed;
    const o = original.revealed;
    expect(r.user.toBase58()).toBe(o.user.toBase58());
    expect(r.price).toBe(o.price);
    expect(r.qty).toBe(o.qty);
    expect(r.salt).toBe(o.salt);
    expect(r.instrumentId).toBe(o.instrumentId);
    expect(r.commitmentIdx).toBe(o.commitmentIdx);
    expect(r.orderType).toBe(o.orderType);
    expect(r.side).toBe(o.side);
    expect(r.reduceOnly).toBe(o.reduceOnly);
  });

  it('throws when buffer is too small', () => {
    expect(() => decodeCommitment(new Uint8Array(100))).toThrow(/too small/);
  });

  it('decodes reduceOnly=true correctly', () => {
    const s = sampleCommitmentState();
    s.revealed = { ...s.revealed, reduceOnly: true };
    const decoded = decodeCommitment(encodeCommitment(s));
    expect(decoded.revealed.reduceOnly).toBe(true);
  });
});

describe('decodePortfolio', () => {
  it('round-trips a known Portfolio state', () => {
    const original = samplePortfolioState();
    const buf = encodePortfolio(original);
    expect(buf.length).toBe(PORTFOLIO_SIZE);
    const decoded = decodePortfolio(buf);

    expect(decoded.user.toBase58()).toBe(original.user.toBase58());
    expect(decoded.equity).toBe(original.equity);
    expect(decoded.principal).toBe(original.principal);
    expect(decoded.pnl).toBe(original.pnl);
    expect(decoded.im).toBe(original.im);
    expect(decoded.mm).toBe(original.mm);
    expect(decoded.freeCollateral).toBe(original.freeCollateral);
    expect(decoded.health).toBe(original.health);
    expect(decoded.positionsLen).toBe(original.positionsLen);
    expect(decoded.positions.length).toBe(2);
    expect(decoded.positions[0]).toEqual(original.positions[0]);
    expect(decoded.positions[1]).toEqual(original.positions[1]);
    expect(decoded.lastBatchId).toBe(original.lastBatchId);
    expect(decoded.lastSlot).toBe(original.lastSlot);
    expect(decoded.bump).toBe(original.bump);
  });

  it('reads all 32 funding checkpoint slots', () => {
    const original = samplePortfolioState();
    const decoded = decodePortfolio(encodePortfolio(original));
    expect(decoded.lastFundingCheckpoint.length).toBe(32);
    for (let i = 0; i < 32; i++) {
      expect(decoded.lastFundingCheckpoint[i]).toBe(BigInt(i * 1000));
    }
  });

  it('handles an empty portfolio (positions_len = 0)', () => {
    const empty: PortfolioState = {
      ...samplePortfolioState(),
      positionsLen: 0,
      positions: [],
    };
    const decoded = decodePortfolio(encodePortfolio(empty));
    expect(decoded.positionsLen).toBe(0);
    expect(decoded.positions.length).toBe(0);
  });

  it('handles negative i128 fields (e.g. losing position)', () => {
    const losing: PortfolioState = {
      ...samplePortfolioState(),
      pnl: -1_000_000_000n,
      equity: 8_000_000_000n,
      health: 7_750_000_000n,
    };
    const decoded = decodePortfolio(encodePortfolio(losing));
    expect(decoded.pnl).toBe(-1_000_000_000n);
    expect(decoded.equity).toBe(8_000_000_000n);
    expect(decoded.health).toBe(7_750_000_000n);
  });

    it('throws when buffer is too small', () => {
    expect(() => decodePortfolio(new Uint8Array(500))).toThrow(/too small/);
  });

  it('PORTFOLIO_SIZE matches BPF layout (1456 bytes, i128 8-byte aligned)', () => {
    // On BPF (sbf-solana-solana), i128/u128 have 8-byte alignment (not 16
    // like native macOS/aarch64). This means:
    //   - No 8-byte padding before last_funding_checkpoint (starts at 920, not 928)
    //   - No 8-byte trailing padding (total 1456, not 1472)
    // The deployed program creates 1456-byte accounts. The SDK MUST match.
    expect(PORTFOLIO_SIZE).toBe(1456);
  });

  it('decodes a BPF-layout portfolio (1456 bytes, i128 8-byte aligned)', () => {
    // Manually construct a buffer matching the BPF repr(C) layout:
    //   user(32) + equity(16) + principal(16) + pnl(16) + im(16) + mm(16)
    //   + free_collateral(16) + health(16) + positions_len(2)
    //   + 6 padding + positions(768) + last_funding_checkpoint(512)
    //   + last_batch_id(8) + last_slot(8) + bump(1) + padding(7) = 1456
    const buf = new Uint8Array(1456);
    const view = new DataView(buf.buffer);
    const user = new PublicKey(
      'A6qbhK9mPRpFhX7D1kZsBpr2xNy8mfgU5J7Vu9xLE5Rp',
    );
    buf.set(user.toBytes(), 0);
    // equity (i128) at offset 32
    view.setBigUint64(32, 10_000_000_000n, true);
    view.setBigInt64(40, 0n, true);
    // positions_len (u16) at offset 144
    view.setUint16(144, 0, true);
    // last_funding_checkpoint[0] (i128) at offset 920 (BPF: no 16-byte align pad)
    view.setBigUint64(920, 42n, true);
    view.setBigInt64(928, 0n, true);
    // last_batch_id (u64) at offset 1432
    view.setBigUint64(1432, 99n, true);
    // last_slot (u64) at offset 1440
    view.setBigUint64(1440, 888n, true);
    // bump (u8) at offset 1448
    view.setUint8(1448, 255);

    const decoded = decodePortfolio(buf);
    expect(decoded.user.toBase58()).toBe(user.toBase58());
    expect(decoded.equity).toBe(10_000_000_000n);
    expect(decoded.positionsLen).toBe(0);
    expect(decoded.lastFundingCheckpoint[0]).toBe(42n);
    expect(decoded.lastBatchId).toBe(99n);
    expect(decoded.lastSlot).toBe(888n);
    expect(decoded.bump).toBe(255);
  });
});

describe('decodeRevealedOrder (standalone)', () => {
  it('decodes a revealed order from a commitment-shaped buffer', () => {
    const c = sampleCommitmentState();
    const buf = encodeCommitment(c);
    const view = new DataView(buf.buffer);
    const r = decodeRevealedOrder(view, 96);
    expect(r.user.toBase58()).toBe(USER.toBase58());
    expect(r.price).toBe(c.revealed.price);
    expect(r.side).toBe(Side.Buy);
  });

  it('decodes a different user as the revealed-order user', () => {
    const c: CommitmentState = {
      ...sampleCommitmentState(),
      user: USER,
      revealed: { ...sampleRevealedOrder(), user: OTHER },
    };
    const buf = encodeCommitment(c);
    const view = new DataView(buf.buffer);
    const r = decodeRevealedOrder(view, 96);
    expect(r.user.toBase58()).toBe(OTHER.toBase58());
  });
});
