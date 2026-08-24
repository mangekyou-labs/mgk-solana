'use client';

import { create } from 'zustand';

export type OrderFormStatus = 'idle' | 'submitting' | 'done' | 'failed';

export type OrderSide = 'buy' | 'sell';

export interface OrderFormState {
  instrumentId: number;
  side: OrderSide;
  price: bigint;
  qty: bigint;
  reduceOnly: boolean;
  batchId: bigint;
  /** @deprecated DFBA has no salt */
  salt: bigint;
  /** @deprecated DFBA has no commitment hash */
  hash: string;
  isMaker: boolean;
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
    salt?: bigint;
    hash?: string;
    isMaker?: boolean;
  }) => void;
  setStatus: (status: OrderFormStatus) => void;
  clear: () => void;
}

const STORAGE_KEY = 'mgk-order-form';
const IN_FLIGHT_STATUSES: OrderFormStatus[] = ['submitting'];
const LEGACY_STATUSES: ReadonlySet<string> = new Set([
  'slashed',
  'committing',
  'awaiting_reveal',
  'revealing',
]);

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
    const rawStatus = typeof raw.status === 'string' ? raw.status : 'idle';
    // Drop commit-reveal / slashed recovery; DFBA has no salt/hash resume.
    if (LEGACY_STATUSES.has(rawStatus)) {
      return null;
    }
    const status = rawStatus as OrderFormStatus;
    const state: OrderFormState = {
      instrumentId: raw.instrumentId ?? 0,
      side: raw.side ?? 'buy',
      price: BigInt(raw.price ?? '0'),
      qty: BigInt(raw.qty ?? '0'),
      reduceOnly: raw.reduceOnly ?? false,
      batchId: BigInt(raw.batchId ?? '0'),
      salt: BigInt(raw.salt ?? '0'),
      hash: raw.hash ?? '',
      isMaker: raw.isMaker ?? false,
      status,
    };
    if (!isRecoverableState(state)) return null;
    return state;
  } catch {
    return null;
  }
}

function loadInitialState(): OrderFormState {
  if (typeof window === 'undefined') return getDefaultState();
  const state = deserialize(window.localStorage.getItem(STORAGE_KEY));
  if (!state) {
    window.localStorage.removeItem(STORAGE_KEY);
    return getDefaultState();
  }
  return state;
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
    isMaker: false,
    status: 'idle',
  };
}

function isRecoverableState(state: OrderFormState): boolean {
  if (!IN_FLIGHT_STATUSES.includes(state.status)) return true;
  return state.price > 0n && state.qty > 0n;
}

/** Test/helper: parse persisted order-form JSON (null if unusable or legacy). */
export function recoverOrderFormState(
  json: string | null,
): OrderFormState | null {
  return deserialize(json);
}

export const useOrderFormStore = create<OrderFormStore>((set) => ({
  ...loadInitialState(),

  setOrder: (params) =>
    set((state) => {
      const next = {
        ...state,
        ...params,
        salt: params.salt ?? 0n,
        hash: params.hash ?? '',
        isMaker: params.isMaker ?? false,
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
