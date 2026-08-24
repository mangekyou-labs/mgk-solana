// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import {
  recoverOrderFormState,
  useOrderFormStore,
} from './useOrderFormStore';

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

  it('setStatus updates DFBA order statuses', () => {
    useOrderFormStore.getState().setStatus('submitting');
    expect(useOrderFormStore.getState().status).toBe('submitting');

    useOrderFormStore.getState().setStatus('failed');
    expect(useOrderFormStore.getState().status).toBe('failed');

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

  it('recovers persisted failed DFBA state', () => {
    const recovered = recoverOrderFormState(
      JSON.stringify({
        instrumentId: 0,
        side: 'sell',
        price: '999000000',
        qty: '1000000',
        reduceOnly: true,
        batchId: '5',
        salt: '7',
        hash: 'cafe',
        isMaker: false,
        status: 'failed',
      }),
    );
    expect(recovered).not.toBeNull();
    expect(recovered!.status).toBe('failed');
    expect(recovered!.side).toBe('sell');
    expect(recovered!.price).toBe(999_000_000n);
  });

  it('drops persisted slashed and commit-reveal statuses', () => {
    for (const status of [
      'slashed',
      'committing',
      'awaiting_reveal',
      'revealing',
    ] as const) {
      expect(
        recoverOrderFormState(
          JSON.stringify({
            instrumentId: 0,
            side: 'buy',
            price: '1',
            qty: '1',
            reduceOnly: false,
            batchId: '1',
            salt: '0',
            hash: '',
            isMaker: false,
            status,
          }),
        ),
      ).toBeNull();
    }
  });
});
