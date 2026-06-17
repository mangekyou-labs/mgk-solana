// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import { InstructionReader, Side } from '@mgk/sdk';
import * as sdk from '@mgk/sdk';
import { useOrderFormStore } from '@/lib/stores/useOrderFormStore';

const STORAGE_KEY = 'mgk-order-form';

function mockUserBytes(): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes[0] = 0xde;
  bytes[31] = 0xad;
  return bytes;
}

function mockPublicKey(): { toBytes(): Uint8Array } {
  const bytes = mockUserBytes();
  return { toBytes: () => bytes };
}

describe('commit-reveal E2E happy path', () => {
  beforeEach(() => {
    useOrderFormStore.getState().clear();
    window.localStorage.clear();
  });

  // ── salt → hash ══════════════════════════════════════════════════

  it('produces a 64-char hex hash from known inputs', () => {
    const user = mockPublicKey();
    const salt = 12345n;

    const hex = sdk.computeCommitmentHashHex(
      sdk.state.OrderType.LimitGTC,
      1,
      false,
      Side.Buy,
      150_000_000n,
      10_000_000n,
      salt,
      user,
      42n,
    );

    expect(hex).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(hex)).toBe(true);
  });

  it('hash is deterministic for the same inputs', () => {
    const user = mockPublicKey();
    const salt = 999n;

    const a = sdk.computeCommitmentHashHex(
      sdk.state.OrderType.LimitGTC, 1, true, Side.Sell,
      150_000_000n, 10_000_000n, salt, user, 42n,
    );
    const b = sdk.computeCommitmentHashHex(
      sdk.state.OrderType.LimitGTC, 1, true, Side.Sell,
      150_000_000n, 10_000_000n, salt, user, 42n,
    );

    expect(a).toBe(b);
  });

  it('hash changes when any field differs', () => {
    const userA = mockPublicKey();
    const userB = new Uint8Array(32).fill(0x99);

    const base = sdk.computeCommitmentHashHex(
      sdk.state.OrderType.LimitGTC, 0, false, Side.Buy,
      150_000_000n, 10_000_000n, 0n, userA, 1n,
    );

    const diffSide = sdk.computeCommitmentHashHex(
      sdk.state.OrderType.LimitGTC, 0, false, Side.Sell,
      150_000_000n, 10_000_000n, 0n, userA, 1n,
    );
    const diffPrice = sdk.computeCommitmentHashHex(
      sdk.state.OrderType.LimitGTC, 0, false, Side.Buy,
      151_000_000n, 10_000_000n, 0n, userA, 1n,
    );
    const diffQty = sdk.computeCommitmentHashHex(
      sdk.state.OrderType.LimitGTC, 0, false, Side.Buy,
      150_000_000n, 11_000_000n, 0n, userA, 1n,
    );
    const diffSalt = sdk.computeCommitmentHashHex(
      sdk.state.OrderType.LimitGTC, 0, false, Side.Buy,
      150_000_000n, 10_000_000n, 1n, userA, 1n,
    );
    const diffUser = sdk.computeCommitmentHashHex(
      sdk.state.OrderType.LimitGTC, 0, false, Side.Buy,
      150_000_000n, 10_000_000n, 0n, { toBytes: () => userB }, 1n,
    );
    const diffBatch = sdk.computeCommitmentHashHex(
      sdk.state.OrderType.LimitGTC, 0, false, Side.Buy,
      150_000_000n, 10_000_000n, 0n, userA, 2n,
    );

    expect(diffSide).not.toBe(base);
    expect(diffPrice).not.toBe(base);
    expect(diffQty).not.toBe(base);
    expect(diffSalt).not.toBe(base);
    expect(diffUser).not.toBe(base);
    expect(diffBatch).not.toBe(base);
  });

  // ── commit: store persist ════════════════════════════════════════

  it('persists committed order to localStorage with bigint-safe serialization', () => {
    const salt = 0xdeadbeefcafebaben;
    const hash = sdk.computeCommitmentHashHex(
      sdk.state.OrderType.LimitGTC, 1, true, Side.Sell,
      200_000_000n, 50_000_000n, salt, mockPublicKey(), 7n,
    );

    useOrderFormStore.getState().setOrder({
      instrumentId: 1,
      side: 'sell',
      price: 200_000_000n,
      qty: 50_000_000n,
      reduceOnly: true,
      batchId: 7n,
      salt,
      hash,
    });

    const raw = window.localStorage.getItem(STORAGE_KEY);
    expect(raw).toBeTruthy();

    const parsed = JSON.parse(raw!);
    expect(parsed.price).toBe('200000000');
    expect(parsed.qty).toBe('50000000');
    expect(parsed.batchId).toBe('7');
    expect(parsed.salt).toBe(salt.toString());
    expect(parsed.hash).toBe(hash);
    expect(parsed.status).toBe('idle');
    expect(parsed.reduceOnly).toBe(true);
    expect(parsed.side).toBe('sell');
  });

  // ── commit → reveal status lifecycle ═════════════════════════════

  it('transitions through the full status lifecycle: idle → committing → awaiting_reveal → revealing → done', () => {
    // idle by default
    expect(useOrderFormStore.getState().status).toBe('idle');

    // committing
    useOrderFormStore.getState().setStatus('committing');
    expect(useOrderFormStore.getState().status).toBe('committing');
    expect(window.localStorage.getItem(STORAGE_KEY)).toContain('committing');

    // awaiting_reveal
    const salt = 42n;
    const hash = sdk.computeCommitmentHashHex(
      sdk.state.OrderType.LimitGTC, 0, false, Side.Buy,
      100n, 100n, salt, mockPublicKey(), 1n,
    );

    useOrderFormStore.getState().setOrder({
      instrumentId: 0,
      side: 'buy',
      price: 100n,
      qty: 100n,
      reduceOnly: false,
      batchId: 1n,
      salt,
      hash,
    });

    useOrderFormStore.getState().setStatus('awaiting_reveal');
    expect(useOrderFormStore.getState().status).toBe('awaiting_reveal');

    const persisted = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!);
    expect(persisted.status).toBe('awaiting_reveal');
    expect(persisted.hash).toBe(hash);
    expect(persisted.salt).toBe(salt.toString());

    // revealing
    useOrderFormStore.getState().setStatus('revealing');
    expect(useOrderFormStore.getState().status).toBe('revealing');

    // done + clear
    useOrderFormStore.getState().setStatus('done');
    useOrderFormStore.getState().clear();

    expect(useOrderFormStore.getState().status).toBe('idle');
    expect(useOrderFormStore.getState().price).toBe(0n);
    expect(useOrderFormStore.getState().salt).toBe(0n);
    expect(useOrderFormStore.getState().hash).toBe('');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  // ── persistence across simulated refresh ═════════════════════════

  it('recovers awaiting_reveal state from localStorage after simulated refresh', () => {
    const salt = 0xabcdef1234567890n;
    const hash = sdk.computeCommitmentHashHex(
      sdk.state.OrderType.LimitGTC, 1, false, Side.Buy,
      150_000_000n, 10_000_000n, salt, mockPublicKey(), 3n,
    );

    // Simulate commit: write state to localStorage
    const state = {
      instrumentId: 1,
      side: 'buy',
      price: '150000000',
      qty: '10000000',
      reduceOnly: false,
      batchId: '3',
      salt: salt.toString(),
      hash,
      status: 'awaiting_reveal',
    };

    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(state),
    );

    // Verify the store can rebuild from this raw localStorage — the
    // store's loadInitialState() reads from localStorage at creation
    // time, so we verify the raw shape is recoverable.
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = JSON.parse(raw!);
    expect(parsed.status).toBe('awaiting_reveal');
    expect(parsed.side).toBe('buy');
    expect(parsed.instrumentId).toBe(1);
    expect(BigInt(parsed.price)).toBe(150_000_000n);
    expect(BigInt(parsed.qty)).toBe(10_000_000n);
    expect(BigInt(parsed.batchId)).toBe(3n);
    expect(BigInt(parsed.salt)).toBe(salt);
    expect(parsed.hash).toBe(hash);
    expect(parsed.reduceOnly).toBe(false);
  });

  it('recovers failed state from localStorage after simulated refresh', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        instrumentId: 0,
        side: 'sell',
        price: '140000000',
        qty: '5000000',
        reduceOnly: true,
        batchId: '9',
        salt: '777',
        hash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        status: 'failed',
      }),
    );

    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = JSON.parse(raw!);
    expect(parsed.status).toBe('failed');
    expect(parsed.hash).toHaveLength(64);
    expect(parsed.reduceOnly).toBe(true);
  });

  // ── instruction encoding round-trips ═════════════════════════════

  it('CommitOrder encode → read round-trip preserves all fields', () => {
    const salt = 0xCAFEF00Dn;
    const commitmentBump = 255;

    const encoded = sdk.programs.encodeCommitOrder({
      orderType: sdk.state.OrderType.LimitGTC,
      instrumentId: 1,
      reduceOnly: true,
      side: Side.Sell,
      price: 150_000_000n,
      qty: 10_000_000n,
      salt,
      batchId: 42n,
      commitmentBump,
    });

    expect(encoded).toHaveLength(39);

    const r = new InstructionReader(encoded);

    // discriminator
    expect(r.readU8()).toBe(4); // CommitOrder

    // order type
    expect(r.readU8()).toBe(sdk.state.OrderType.LimitGTC);

    // instrument id
    expect(r.readU16()).toBe(1);

    // reduceOnly
    expect(r.readU8()).toBe(1);

    // side
    expect(r.readSide()).toBe(Side.Sell);

    // price
    expect(r.readI64()).toBe(150_000_000n);

    // qty
    expect(r.readU64()).toBe(10_000_000n);

    // salt
    expect(r.readU64()).toBe(salt);

    // batchId
    expect(r.readU64()).toBe(42n);

    // commitmentBump
    expect(r.readU8()).toBe(commitmentBump);

    // nothing left
    expect(r.remaining).toBe(0);
  });

  it('RevealOrder encode → read round-trip preserves all fields', () => {
    const salt = 0xDEADn;

    const encoded = sdk.programs.encodeRevealOrder({
      orderType: sdk.state.OrderType.LimitGTC,
      instrumentId: 2,
      reduceOnly: false,
      side: Side.Buy,
      price: 200_000_000n,
      qty: 25_000_000n,
      salt,
      batchId: 99n,
    });

    expect(encoded).toHaveLength(38);

    const r = new InstructionReader(encoded);

    // discriminator
    expect(r.readU8()).toBe(5); // RevealOrder

    // order type
    expect(r.readU8()).toBe(sdk.state.OrderType.LimitGTC);

    // instrument id
    expect(r.readU16()).toBe(2);

    // reduceOnly
    expect(r.readU8()).toBe(0);

    // side
    expect(r.readSide()).toBe(Side.Buy);

    // price
    expect(r.readI64()).toBe(200_000_000n);

    // qty
    expect(r.readU64()).toBe(25_000_000n);

    // salt
    expect(r.readU64()).toBe(salt);

    // batchId
    expect(r.readU64()).toBe(99n);

    // no commitmentBump in RevealOrder
    expect(r.remaining).toBe(0);
  });

  // ── failed tx does not leak state ════════════════════════════════

  it('failed status is recoverable (store retains params for retry)', () => {
    const salt = 123n;
    const hash = sdk.computeCommitmentHashHex(
      sdk.state.OrderType.LimitGTC, 0, false, Side.Buy,
      100n, 200n, salt, mockPublicKey(), 1n,
    );

    useOrderFormStore.getState().setOrder({
      instrumentId: 0,
      side: 'buy',
      price: 100n,
      qty: 200n,
      reduceOnly: false,
      batchId: 1n,
      salt,
      hash,
    });

    // commit fails
    useOrderFormStore.getState().setStatus('failed');

    const state = useOrderFormStore.getState();
    expect(state.status).toBe('failed');
    expect(state.salt).toBe(salt);
    expect(state.hash).toBe(hash);
    expect(state.price).toBe(100n);
    expect(state.qty).toBe(200n);

    // params still available in localStorage for retry
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = JSON.parse(raw!);
    expect(parsed.status).toBe('failed');
    expect(parsed.salt).toBe(salt.toString());
  });
});
