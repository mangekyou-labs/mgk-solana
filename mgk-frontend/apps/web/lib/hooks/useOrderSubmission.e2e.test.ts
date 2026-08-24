// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import { InstructionReader, Side } from '@mgk/sdk';
import * as sdk from '@mgk/sdk';
import { recoverOrderFormState, useOrderFormStore } from '@/lib/stores/useOrderFormStore';

const STORAGE_KEY = 'mgk-order-form';

describe('PostOrder store lifecycle', () => {
  beforeEach(() => {
    useOrderFormStore.getState().clear();
    window.localStorage.clear();
  });

  it('persists a PostOrder to localStorage with bigint-safe serialization', () => {
    useOrderFormStore.getState().setOrder({
      instrumentId: 1,
      side: 'sell',
      price: 200_000_000n,
      qty: 50_000_000n,
      reduceOnly: true,
      batchId: 7n,
      isMaker: true,
    });

    const raw = window.localStorage.getItem(STORAGE_KEY);
    expect(raw).toBeTruthy();

    const parsed = JSON.parse(raw!);
    expect(parsed.price).toBe('200000000');
    expect(parsed.qty).toBe('50000000');
    expect(parsed.batchId).toBe('7');
    expect(parsed.status).toBe('idle');
    expect(parsed.reduceOnly).toBe(true);
    expect(parsed.side).toBe('sell');
    expect(parsed.isMaker).toBe(true);
  });

  it('transitions idle → submitting → done without commit-reveal statuses', () => {
    expect(useOrderFormStore.getState().status).toBe('idle');

    useOrderFormStore.getState().setStatus('submitting');
    expect(useOrderFormStore.getState().status).toBe('submitting');
    expect(window.localStorage.getItem(STORAGE_KEY)).toContain('submitting');

    useOrderFormStore.getState().setStatus('done');
    useOrderFormStore.getState().clear();

    expect(useOrderFormStore.getState().status).toBe('idle');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('does not recover slashed or commit-reveal records after a refresh', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        instrumentId: 1,
        side: 'buy',
        price: '150000000',
        qty: '10000000',
        reduceOnly: false,
        batchId: '3',
        salt: '1',
        hash: 'cafe',
        status: 'awaiting_reveal',
      }),
    );

    expect(recoverOrderFormState(window.localStorage.getItem(STORAGE_KEY))).toBeNull();
  });

  it('recovers failed state from localStorage after simulated refresh', () => {
    const json = JSON.stringify({
      instrumentId: 0,
      side: 'sell',
      price: '140000000',
      qty: '5000000',
      reduceOnly: true,
      batchId: '9',
      salt: '0',
      hash: '',
      isMaker: false,
      status: 'failed',
    });
    window.localStorage.setItem(STORAGE_KEY, json);

    const recovered = recoverOrderFormState(window.localStorage.getItem(STORAGE_KEY));
    expect(recovered).not.toBeNull();
    expect(recovered!.status).toBe('failed');
    expect(recovered!.reduceOnly).toBe(true);
    expect(recovered!.price).toBe(140_000_000n);
  });

  it('PostOrder encode → read round-trip preserves all fields', () => {
    const encoded = sdk.programs.encodePostOrder({
      instrumentId: 0,
      side: Side.Buy,
      price: 100_250_000n,
      qty: 2_500_000n,
      reduceOnly: false,
      isMaker: true,
    });

    expect(encoded).toHaveLength(22);
    const r = new InstructionReader(encoded);
    expect(r.readU8()).toBe(20);
    expect(r.readSide()).toBe(Side.Buy);
    expect(r.readU8()).toBe(1);
    expect(r.readI64()).toBe(100_250_000n);
    expect(r.readU64()).toBe(2_500_000n);
    expect(r.readU16()).toBe(0);
    expect(r.readU8()).toBe(0);
    expect(r.remaining).toBe(0);
  });

  it('failed status is recoverable (store retains params for retry)', () => {
    useOrderFormStore.getState().setOrder({
      instrumentId: 0,
      side: 'buy',
      price: 100n,
      qty: 200n,
      reduceOnly: false,
      batchId: 1n,
    });
    useOrderFormStore.getState().setStatus('failed');

    const state = useOrderFormStore.getState();
    expect(state.status).toBe('failed');
    expect(state.price).toBe(100n);
    expect(state.qty).toBe(200n);

    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!);
    expect(parsed.status).toBe('failed');
  });
});
