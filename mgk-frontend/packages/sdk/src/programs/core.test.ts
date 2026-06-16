import { describe, it, expect } from 'vitest';
import {
  CORE_INSTRUCTION,
  encodeCommitOrder,
  encodeDeposit,
  encodeInitPortfolio,
  encodeRevealOrder,
  encodeWithdraw,
} from './core.js';
import { InstructionReader, Side } from '../instruction.js';
import { OrderType } from '../state/types.js';

describe('CORE_INSTRUCTION discriminator table', () => {
  it('matches the Rust CoreInstruction enum', () => {
    expect(CORE_INSTRUCTION.Initialize).toBe(0);
    expect(CORE_INSTRUCTION.InitPortfolio).toBe(1);
    expect(CORE_INSTRUCTION.Deposit).toBe(2);
    expect(CORE_INSTRUCTION.Withdraw).toBe(3);
    expect(CORE_INSTRUCTION.CommitOrder).toBe(4);
    expect(CORE_INSTRUCTION.RevealOrder).toBe(5);
    expect(CORE_INSTRUCTION.CloseCommitting).toBe(6);
    expect(CORE_INSTRUCTION.ClearBatch).toBe(7);
    expect(CORE_INSTRUCTION.SettleBatch).toBe(8);
    expect(CORE_INSTRUCTION.LiquidateUser).toBe(9);
    expect(CORE_INSTRUCTION.AddInstrument).toBe(10);
    expect(CORE_INSTRUCTION.CancelRestingOrder).toBe(11);
    expect(CORE_INSTRUCTION.ModifyRestingOrder).toBe(12);
  });
});

describe('encodeInitPortfolio', () => {
  it('emits a single discriminator byte', () => {
    const buf = encodeInitPortfolio();
    expect(buf.length).toBe(1);
    expect(buf[0]).toBe(CORE_INSTRUCTION.InitPortfolio);
  });
});

describe('encodeDeposit', () => {
  it('emits discriminator + u64 LE amount', () => {
    const amount = 1_500_000_000n;
    const buf = encodeDeposit(amount);
    expect(buf.length).toBe(9);
    expect(buf[0]).toBe(CORE_INSTRUCTION.Deposit);

    const view = new DataView(buf.buffer);
    expect(view.getBigUint64(1, true)).toBe(amount);
  });

  it('round-trips through InstructionReader', () => {
    const buf = encodeDeposit(0n);
    const r = new InstructionReader(buf);
    expect(r.readU8()).toBe(CORE_INSTRUCTION.Deposit);
    expect(r.readU64()).toBe(0n);
    expect(r.remaining).toBe(0);
  });
});

describe('encodeWithdraw', () => {
  it('emits discriminator + u64 LE amount', () => {
    const amount = 250_000_000n;
    const buf = encodeWithdraw(amount);
    expect(buf.length).toBe(9);
    expect(buf[0]).toBe(CORE_INSTRUCTION.Withdraw);
  });

  it('round-trips through InstructionReader', () => {
    const amount = 999_999_999_999n;
    const buf = encodeWithdraw(amount);
    const r = new InstructionReader(buf);
    expect(r.readU8()).toBe(CORE_INSTRUCTION.Withdraw);
    expect(r.readU64()).toBe(amount);
    expect(r.remaining).toBe(0);
  });
});

describe('encodeCommitOrder', () => {
  const params = {
    orderType: OrderType.LimitGTC,
    instrumentId: 1,
    reduceOnly: false,
    side: Side.Buy,
    price: 150_500_000n,
    qty: 1_000_000n,
    salt: 0x123456789abcdef0n,
    batchId: 42n,
    commitmentBump: 255,
  };

  it('emits 39 bytes total', () => {
    const buf = encodeCommitOrder(params);
    expect(buf.length).toBe(39);
  });

  it('starts with the CommitOrder discriminator', () => {
    const buf = encodeCommitOrder(params);
    expect(buf[0]).toBe(CORE_INSTRUCTION.CommitOrder);
  });

  it('round-trips through InstructionReader', () => {
    const buf = encodeCommitOrder(params);
    const r = new InstructionReader(buf);
    expect(r.readU8()).toBe(CORE_INSTRUCTION.CommitOrder);
    expect(r.readU8()).toBe(params.orderType);
    expect(r.readU16()).toBe(params.instrumentId);
    expect(r.readU8()).toBe(0); // reduceOnly=false
    expect(r.readSide()).toBe(Side.Buy);
    expect(r.readI64()).toBe(params.price);
    expect(r.readU64()).toBe(params.qty);
    expect(r.readU64()).toBe(params.salt);
    expect(r.readU64()).toBe(params.batchId);
    expect(r.readU8()).toBe(params.commitmentBump);
    expect(r.remaining).toBe(0);
  });

  it('encodes reduceOnly=true as byte 1', () => {
    const buf = encodeCommitOrder({ ...params, reduceOnly: true });
    expect(buf[4]).toBe(1);
  });

  it('encodes negative prices via i64 LE', () => {
    const buf = encodeCommitOrder({ ...params, price: -1n });
    const r = new InstructionReader(buf);
    r.readU8(); // disc
    r.readU8(); // orderType
    r.readU16(); // instrumentId
    r.readU8(); // reduceOnly
    r.readSide(); // side
    expect(r.readI64()).toBe(-1n);
  });

  it('encodes large u64 salts and qty without loss', () => {
    const buf = encodeCommitOrder({
      ...params,
      qty: 0xffffffffffffffffn,
      salt: 0xabcdef0123456789n,
    });
    const r = new InstructionReader(buf);
    r.readU8();
    r.readU8();
    r.readU16();
    r.readU8();
    r.readSide();
    r.readI64();
    expect(r.readU64()).toBe(0xffffffffffffffffn);
    expect(r.readU64()).toBe(0xabcdef0123456789n);
  });
});

describe('encodeRevealOrder', () => {
  const params = {
    orderType: OrderType.LimitGTC,
    instrumentId: 1,
    reduceOnly: false,
    side: Side.Sell,
    price: 150_500_000n,
    qty: 1_000_000n,
    salt: 0x123456789abcdef0n,
    batchId: 42n,
  };

  it('emits 38 bytes total (no commitment_bump)', () => {
    const buf = encodeRevealOrder(params);
    expect(buf.length).toBe(38);
  });

  it('starts with the RevealOrder discriminator', () => {
    const buf = encodeRevealOrder(params);
    expect(buf[0]).toBe(CORE_INSTRUCTION.RevealOrder);
  });

  it('round-trips through InstructionReader', () => {
    const buf = encodeRevealOrder(params);
    const r = new InstructionReader(buf);
    expect(r.readU8()).toBe(CORE_INSTRUCTION.RevealOrder);
    expect(r.readU8()).toBe(params.orderType);
    expect(r.readU16()).toBe(params.instrumentId);
    expect(r.readU8()).toBe(0); // reduceOnly=false
    expect(r.readSide()).toBe(Side.Sell);
    expect(r.readI64()).toBe(params.price);
    expect(r.readU64()).toBe(params.qty);
    expect(r.readU64()).toBe(params.salt);
    expect(r.readU64()).toBe(params.batchId);
    expect(r.remaining).toBe(0);
  });

  it('encodes reduceOnly=true as byte 1', () => {
    const buf = encodeRevealOrder({ ...params, reduceOnly: true });
    expect(buf[4]).toBe(1);
  });
});
