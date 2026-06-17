'use client';

import { useCallback } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import {
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import * as sdk from '@mgk/sdk';

import { config } from '@/lib/config';
import {
  useOrderFormStore,
  type OrderSide,
} from '@/lib/stores/useOrderFormStore';

function randomSalt(): bigint {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const view = new DataView(bytes.buffer);
  return view.getBigUint64(0, true);
}

export interface CommitParams {
  instrumentId: number;
  side: OrderSide;
  price: bigint;
  qty: bigint;
  reduceOnly: boolean;
  batchId: bigint;
}

export interface RevealParams {
  instrumentId: number;
  side: OrderSide;
  price: bigint;
  qty: bigint;
  reduceOnly: boolean;
  salt: bigint;
  batchId: bigint;
}

const CU_LIMIT_COMMIT = 200_000;
const CU_LIMIT_REVEAL = 200_000;

/**
 * Hook to commit an order: generates salt, computes commitment hash,
 * builds and sends CommitOrder tx, persists state to localStorage.
 */
export function useCommitOrder() {
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const setOrder = useOrderFormStore((s) => s.setOrder);
  const setStatus = useOrderFormStore((s) => s.setStatus);

  const commit = useCallback(
    async (params: CommitParams) => {
      if (!publicKey || !sendTransaction) {
        throw new Error('Wallet not connected');
      }

      setStatus('committing');

      try {
        const salt = randomSalt();
        const sideByte = params.side === 'buy' ? sdk.Side.Buy : sdk.Side.Sell;

        const hash = sdk.computeCommitmentHashHex(
          sdk.state.OrderType.LimitGTC,
          params.instrumentId,
          params.reduceOnly,
          sideByte,
          params.price,
          params.qty,
          salt,
          publicKey,
          params.batchId,
        );

        const [commitmentPda, commitmentBump] = sdk.deriveCommitmentPda(
          params.batchId,
          publicKey,
          salt,
          config.coreProgramId,
        );

        const ixData = sdk.programs.encodeCommitOrder({
          orderType: sdk.state.OrderType.LimitGTC,
          instrumentId: params.instrumentId,
          reduceOnly: params.reduceOnly,
          side: sideByte,
          price: params.price,
          qty: params.qty,
          salt,
          batchId: params.batchId,
          commitmentBump,
        });

        const ix = new TransactionInstruction({
          keys: [
            { pubkey: publicKey, isSigner: true, isWritable: false },
            { pubkey: commitmentPda, isSigner: false, isWritable: true },
          ],
          programId: config.coreProgramId,
          data: Buffer.from(ixData),
        });

        const tx = new Transaction().add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT_COMMIT }),
          ix,
        );

        const sig = await sendTransaction(tx, connection);
        await connection.confirmTransaction(sig, 'confirmed');

        setOrder({
          instrumentId: params.instrumentId,
          side: params.side,
          price: params.price,
          qty: params.qty,
          reduceOnly: params.reduceOnly,
          batchId: params.batchId,
          salt,
          hash,
        });

        setStatus('awaiting_reveal');

        return { sig, hash, salt, commitmentPda };
      } catch (e) {
        setStatus('failed');
        throw e;
      }
    },
    [publicKey, sendTransaction, connection, setOrder, setStatus],
  );

  return { commit };
}

/**
 * Hook to reveal a previously-committed order: reads state from the
 * order form store, builds and sends the RevealOrder tx.
 */
export function useRevealOrder() {
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const storeState = useOrderFormStore((s) => s);
  const setStatus = useOrderFormStore((s) => s.setStatus);
  const clear = useOrderFormStore((s) => s.clear);

  const reveal = useCallback(async (params?: RevealParams) => {
    if (!publicKey || !sendTransaction) {
      throw new Error('Wallet not connected');
    }

    const side = params?.side ?? storeState.side;
    const instrumentId = params?.instrumentId ?? storeState.instrumentId;
    const reduceOnly = params?.reduceOnly ?? storeState.reduceOnly;
    const price = params?.price ?? storeState.price;
    const qty = params?.qty ?? storeState.qty;
    const salt = params?.salt ?? storeState.salt;
    const batchId = params?.batchId ?? storeState.batchId;
    const sideByte = side === 'buy' ? sdk.Side.Buy : sdk.Side.Sell;

    setStatus('revealing');

    try {
      const ixData = sdk.programs.encodeRevealOrder({
        orderType: sdk.state.OrderType.LimitGTC,
        instrumentId,
        reduceOnly,
        side: sideByte,
        price,
        qty,
        salt,
        batchId,
      });

      const ix = new TransactionInstruction({
        keys: [
          { pubkey: publicKey, isSigner: true, isWritable: false },
        ],
        programId: config.coreProgramId,
        data: Buffer.from(ixData),
      });

      const tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT_REVEAL }),
        ix,
      );

      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, 'confirmed');

      setStatus('done');
      clear();

      return { sig };
    } catch (e) {
      setStatus('failed');
      throw e;
    }
  }, [publicKey, sendTransaction, connection, storeState, setStatus, clear]);

  return { reveal };
}
