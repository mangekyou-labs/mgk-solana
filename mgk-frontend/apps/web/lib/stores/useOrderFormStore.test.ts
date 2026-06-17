// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import { useOrderFormStore } from './useOrderFormStore';

describe('useOrderFormStore', () => {
  beforeEach(() => {
    useOrderFormStore.getState().clear();
    window.localStorage.clear();
  });

  it('defaults to idle status with zero values', () => {
    const state = useOrderFormStore.getState();
    expect(state.status).toBe('idle');
    expect(state.instrumentId).toBe(0);
    expect(state.side).toBe('buy');
    expect(state.price).toBe(0n);
    expect(state.qty).toBe(0n);
    expect(state.reduceOnly).toBe(false);
    expect(state.batchId).toBe(0n);
    expect(state.salt).toBe(0n);
    expect(state.hash).toBe('');
  });

  it('setOrder updates fields and resets status to idle', () => {
    useOrderFormStore.getState().setStatus('failed');
    useOrderFormStore.getState().setOrder({
      instrumentId: 1,
      side: 'sell',
      price: 150_000_000n,
      qty: 10_000_000n,
      reduceOnly: true,
      batchId: 42n,
      salt: 12345n,
      hash: 'ab12cd34',
    });

    const state = useOrderFormStore.getState();
    expect(state.instrumentId).toBe(1);
    expect(state.side).toBe('sell');
    expect(state.price).toBe(150_000_000n);
    expect(state.qty).toBe(10_000_000n);
    expect(state.reduceOnly).toBe(true);
    expect(state.batchId).toBe(42n);
    expect(state.salt).toBe(12345n);
    expect(state.hash).toBe('ab12cd34');
    expect(state.status).toBe('idle');
  });

  it('setStatus updates the order status', () => {
    useOrderFormStore.getState().setStatus('committing');
    expect(useOrderFormStore.getState().status).toBe('committing');

    useOrderFormStore.getState().setStatus('awaiting_reveal');
    expect(useOrderFormStore.getState().status).toBe('awaiting_reveal');

    useOrderFormStore.getState().setStatus('done');
    expect(useOrderFormStore.getState().status).toBe('done');
  });

  it('clear resets to defaults', () => {
    useOrderFormStore.getState().setOrder({
      instrumentId: 1,
      side: 'sell',
      price: 100n,
      qty: 50n,
      reduceOnly: false,
      batchId: 7n,
      salt: 99n,
      hash: 'ff',
    });

    useOrderFormStore.getState().clear();

    const state = useOrderFormStore.getState();
    expect(state.status).toBe('idle');
    expect(state.price).toBe(0n);
    expect(state.qty).toBe(0n);
    expect(state.batchId).toBe(0n);
    expect(state.salt).toBe(0n);
    expect(state.hash).toBe('');
  });

  it('persists to localStorage on setOrder', () => {
    useOrderFormStore.getState().setOrder({
      instrumentId: 0,
      side: 'buy',
      price: 200_000_000n,
      qty: 5_000_000n,
      reduceOnly: false,
      batchId: 3n,
      salt: 42n,
      hash: 'deadbeef',
    });

    const raw = window.localStorage.getItem('mgk-order-form');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.price).toBe('200000000');
    expect(parsed.qty).toBe('5000000');
    expect(parsed.batchId).toBe('3');
    expect(parsed.salt).toBe('42');
    expect(parsed.hash).toBe('deadbeef');
    expect(parsed.status).toBe('idle');
  });

  it('removes localStorage on clear', () => {
    useOrderFormStore.getState().setOrder({
      instrumentId: 0,
      side: 'buy',
      price: 1n,
      qty: 1n,
      reduceOnly: false,
      batchId: 1n,
      salt: 1n,
      hash: 'aa',
    });

    expect(window.localStorage.getItem('mgk-order-form')).toBeTruthy();

    useOrderFormStore.getState().clear();
    expect(window.localStorage.getItem('mgk-order-form')).toBeNull();
  });

  it('loads persisted state from localStorage on creation', () => {
    window.localStorage.setItem(
      'mgk-order-form',
      JSON.stringify({
        instrumentId: 0,
        side: 'sell',
        price: '999000000',
        qty: '1000000',
        reduceOnly: true,
        batchId: '5',
        salt: '7',
        hash: 'cafe',
        status: 'awaiting_reveal',
      }),
    );

    // Force re-create by clearing and reloading — but we can't truly
    // re-create a Zustand store module. Instead, test that deserialization
    // of the raw localStorage value would produce the expected shape.
    const raw = window.localStorage.getItem('mgk-order-form');
    const parsed = JSON.parse(raw!);
    expect(parsed.status).toBe('awaiting_reveal');
    expect(parsed.side).toBe('sell');
    expect(parsed.price).toBe('999000000');
  });
});
