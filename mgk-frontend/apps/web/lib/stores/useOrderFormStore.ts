'use client';

import { create } from 'zustand';

export type OrderFormStatus =
  | 'idle'
  | 'committing'
  | 'awaiting_reveal'
  | 'revealing'
  | 'done'
  | 'failed'
  | 'slashed';

export type OrderSide = 'buy' | 'sell';

export interface OrderFormState {
  instrumentId: number;
  side: OrderSide;
  price: bigint;
  qty: bigint;
  reduceOnly: boolean;
  batchId: bigint;
  salt: bigint;
  hash: string;
  status: OrderFormStatus;
}

interface OrderFormStore extends OrderFormState {
  setOrder: (params: {
    instrumentId: number;
    side: OrderSide;
    price: bigint;
    qty: bigint;
    reduceOnly: boolean;
    batchId: bigint;
    salt: bigint;
    hash: string;
  }) => void;
  setStatus: (status: OrderFormStatus) => void;
  clear: () => void;
}

const STORAGE_KEY = 'mgk-order-form';

function serialize(state: OrderFormState): string {
  return JSON.stringify({
    ...state,
    price: state.price.toString(),
    qty: state.qty.toString(),
    batchId: state.batchId.toString(),
    salt: state.salt.toString(),
  });
}

function deserialize(json: string | null): OrderFormState | null {
  if (!json) return null;
  try {
    const raw = JSON.parse(json);
    return {
      instrumentId: raw.instrumentId ?? 0,
      side: raw.side ?? 'buy',
      price: BigInt(raw.price ?? '0'),
      qty: BigInt(raw.qty ?? '0'),
      reduceOnly: raw.reduceOnly ?? false,
      batchId: BigInt(raw.batchId ?? '0'),
      salt: BigInt(raw.salt ?? '0'),
      hash: raw.hash ?? '',
      status: raw.status ?? 'idle',
    };
  } catch {
    return null;
  }
}

function loadInitialState(): OrderFormState {
  if (typeof window === 'undefined') return getDefaultState();
  return deserialize(window.localStorage.getItem(STORAGE_KEY)) ?? getDefaultState();
}

function getDefaultState(): OrderFormState {
  return {
    instrumentId: 0,
    side: 'buy',
    price: 0n,
    qty: 0n,
    reduceOnly: false,
    batchId: 0n,
    salt: 0n,
    hash: '',
    status: 'idle',
  };
}

export const useOrderFormStore = create<OrderFormStore>((set) => ({
  ...loadInitialState(),

  setOrder: (params) =>
    set((state) => {
      const next = {
        ...state,
        ...params,
        status: 'idle' as OrderFormStatus,
      };
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(STORAGE_KEY, serialize(next));
      }
      return next;
    }),

  setStatus: (status) =>
    set((state) => {
      const next = { ...state, status };
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(STORAGE_KEY, serialize(next));
      }
      return next;
    }),

  clear: () =>
    set(() => {
      if (typeof window !== 'undefined') {
        window.localStorage.removeItem(STORAGE_KEY);
      }
      return getDefaultState();
    }),
}));
