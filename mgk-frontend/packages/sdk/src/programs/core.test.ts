import { describe, it, expect } from 'vitest';
import {
  CORE_INSTRUCTION,
  MATCHER_INSTRUCTION,
  encodeCommitOrder,
  encodeDeposit,
  encodeDfbaClear,
  encodeInitPortfolio,
  encodePostOrder,
  encodePlaceResting,
  encodeRevealOrder,
  encodeSetFundingParams,
  encodeSetInstrumentFees,
  encodeSetInstrumentOracle,
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
    expect(CORE_INSTRUCTION.PostOrder).toBe(20);
    expect(CORE_INSTRUCTION.SetBatchParams).toBe(21);
    expect(CORE_INSTRUCTION.SetInstrumentFees).toBe(22);
    expect(CORE_INSTRUCTION.SetInstrumentOracle).toBe(23);
    expect(CORE_INSTRUCTION.SetFundingParams).toBe(24);
    expect(MATCHER_INSTRUCTION.DfbaClear).toBe(5);
    expect(MATCHER_INSTRUCTION.PlaceResting).toBe(6);
  });
});

describe('encodeSetFundingParams', () => {
  it('emits 25-byte disc-24 wire: coeff i64 + max_rate i64 + interval u64 LE', () => {
    const buf = encodeSetFundingParams(10_000, 50, 100);
    expect(buf.length).toBe(25);
    expect(buf[0]).toBe(CORE_INSTRUCTION.SetFundingParams);
    const view = new DataView(buf.buffer);
    expect(view.getBigInt64(1, true)).toBe(10_000n);
    expect(view.getBigInt64(9, true)).toBe(50n);
    expect(view.getBigUint64(17, true)).toBe(100n);
  });

  it('round-trips negative coefficient as i64 LE', () => {
    const buf = encodeSetFundingParams(-1, 50, 100);
    const view = new DataView(buf.buffer);
    expect(view.getBigInt64(1, true)).toBe(-1n);
  });
});

describe('encodeSetInstrumentOracle', () => {
  it('emits 1-byte disc-23 wire', () => {
    const buf = encodeSetInstrumentOracle();
    expect(buf.length).toBe(1);
    expect(buf[0]).toBe(23);
    expect(buf[0]).toBe(CORE_INSTRUCTION.SetInstrumentOracle);
  });
});

describe('encodeSetInstrumentFees', () => {
  it('emits 5-byte disc-22 wire: taker u16 + maker i16 LE', () => {
    const buf = encodeSetInstrumentFees(5, 0);
    expect(buf.length).toBe(5);
    expect(buf[0]).toBe(CORE_INSTRUCTION.SetInstrumentFees);
    const view = new DataView(buf.buffer);
    expect(view.getUint16(1, true)).toBe(5);
    expect(view.getInt16(3, true)).toBe(0);
  });
});

describe('encodePostOrder', () => {
  it('emits 22-byte DFBA post wire format', () => {
    const buf = encodePostOrder({
      side: Side.Buy,
      isMaker: true,
      price: 100_500_000n,
      qty: 10n,
      instrumentId: 1,
      reduceOnly: false,
    });
    expect(buf.length).toBe(22);
    expect(buf[0]).toBe(CORE_INSTRUCTION.PostOrder);
    expect(buf[1]).toBe(Side.Buy);
    expect(buf[2]).toBe(1); // maker
    const view = new DataView(buf.buffer);
    expect(view.getBigInt64(3, true)).toBe(100_500_000n);
    expect(view.getBigUint64(11, true)).toBe(10n);
    expect(view.getUint16(19, true)).toBe(1);
    expect(buf[21]).toBe(0);
  });

  it('defaults isMaker to taker', () => {
    const buf = encodePostOrder({
      side: Side.Sell,
      price: 1n,
      qty: 1n,
      instrumentId: 0,
    });
    expect(buf[2]).toBe(0);
  });
});

describe('encodeDfbaClear', () => {
  it('emits disc 5 + u64 max cap + zero orders', () => {
    const buf = encodeDfbaClear();
    expect(buf.length).toBe(11);
    expect(buf[0]).toBe(MATCHER_INSTRUCTION.DfbaClear);
    const view = new DataView(buf.buffer);
    expect(view.getBigUint64(1, true)).toBe(0xffffffffffffffffn);
    expect(view.getUint16(9, true)).toBe(0);
  });
});

describe('encodePlaceResting', () => {
  it('emits 54-byte matcher place wire', () => {
    const user = new Uint8Array(32).fill(7);
    const buf = encodePlaceResting(user, Side.Buy, true, 99n, 5n, 2, true);
    expect(buf.length).toBe(54);
    expect(buf[0]).toBe(MATCHER_INSTRUCTION.PlaceResting);
    expect(buf[1]).toBe(7);
    expect(buf[33]).toBe(Side.Buy);
    expect(buf[34]).toBe(1);
    expect(buf[53]).toBe(1);
  });
});

describe('encodeInitPortfolio', () => {
  it('emits discriminator + user pubkey + bump, 34 bytes total', () => {
    const user = new Uint8Array(32);
    user[0] = 0xde;
    user[31] = 0xad;
    const bump = 255;
    const buf = encodeInitPortfolio(user, bump);
    expect(buf.length).toBe(34);
    expect(buf[0]).toBe(CORE_INSTRUCTION.InitPortfolio);
    expect(buf[1]).toBe(0xde);
    expect(buf[32]).toBe(0xad);
    expect(buf[33]).toBe(255);
  });

  it('round-trips through InstructionReader', () => {
    const user = new Uint8Array(32).fill(0xcc);
    const bump = 7;
    const buf = encodeInitPortfolio(user, bump);
    const r = new InstructionReader(buf);
    expect(r.readU8()).toBe(CORE_INSTRUCTION.InitPortfolio);
    expect(r.readBytes(32)).toEqual(user);
    expect(r.readU8()).toBe(bump);
    expect(r.remaining).toBe(0);
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
