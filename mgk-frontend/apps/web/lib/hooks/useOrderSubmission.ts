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
import { resolveOpenBatch, resolveRegistryAddress } from '@/lib/onchainAccounts';
import {
  useOrderFormStore,
  type OrderFormStatus,
  type OrderSide,
} from '@/lib/stores/useOrderFormStore';

export interface PostOrderParams {
  instrumentId: number;
  side: OrderSide;
  price: bigint;
  qty: bigint;
  reduceOnly: boolean;
  /** false = taker (default), true = maker */
  isMaker?: boolean;
}

const CU_LIMIT_POST = 300_000;

export function activeBatchIdFromCounter(batchIdCounter: bigint): bigint {
  if (batchIdCounter === 0n) {
    throw new Error('No active batch. Wait for the keeper to open collecting.');
  }
  return batchIdCounter - 1n;
}

export function postOrderAccountCount(): number {
  return 6;
}

/** Match the wallet-adapter / web3.js error format for a custom program
 *  error, which surfaces in the message string as either:
 *    "custom program error: 0x258"
 *  or the older non-prefixed variant:
 *    "failed to send transaction: ... 0x1f7"
 */
function extractErrorCode(err: unknown): number | null {
  if (err == null) return null;
  if (typeof err === 'object' && 'code' in err) {
    const c = (err as { code?: unknown }).code;
    if (typeof c === 'number' && Number.isInteger(c) && c >= 0) return c;
  }
  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : (() => {
            try {
              return JSON.stringify(err);
            } catch {
              return '';
            }
          })();
  const hex = message.match(/custom program error:\s*0x([0-9a-fA-F]+)/);
  if (hex?.[1]) return parseInt(hex[1], 16);
  const plain = message.match(/custom program error:\s*(\d+)/);
  if (plain?.[1]) return Number(plain[1]);
  return null;
}

export interface DecodedProgramError {
  code: number | null;
  severity: sdk.ErrorSeverity;
  message: string;
}

export function decodeProgramError(err: unknown): DecodedProgramError {
  const code = extractErrorCode(err);
  if (code === null) {
    const message =
      err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown error';
    return { code: null, severity: 'unknown', message };
  }
  const severity = sdk.classifyError(code);
  const human = sdk.humanizeError(code);
  return { code, severity, message: human };
}

function applySeverity(
  severity: sdk.ErrorSeverity,
  setters: { setStatus: (s: OrderFormStatus) => void; clear: () => void },
): void {
  // DFBA PostOrder has no slash-on-reveal UI path. Keep params for retry.
  void severity;
  void setters.clear;
  setters.setStatus('failed');
}

/**
 * DFBA PostOrder: single-tx open limit post onto the resting book.
 * Replaces the commit-reveal two-tx flow.
 */
export function usePostOrder() {
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const setOrder = useOrderFormStore((s) => s.setOrder);
  const setStatus = useOrderFormStore((s) => s.setStatus);
  const clear = useOrderFormStore((s) => s.clear);

  const post = useCallback(
    async (params: PostOrderParams) => {
      if (!publicKey || !sendTransaction) {
        throw new Error('Wallet not connected');
      }

      try {
        const registryPda = resolveRegistryAddress(config.coreProgramId);
        const [portfolioPda] = sdk.derivePortfolioPda(
          publicKey,
          config.coreProgramId,
        );
        // M9: book is a matcher-owned keypair account (config.bookAddress).
        // PDA fallback only if no configured book (future multi-instrument).
        const bookPda =
          config.bookAddress ??
          sdk.deriveBookPda(params.instrumentId, config.matcherProgramId)[0];

        const [registryAcc, portfolioAcc, bookAcc] =
          await connection.getMultipleAccountsInfo([
            registryPda,
            portfolioPda,
            bookPda,
          ]);
        if (!registryAcc) {
          throw new Error('Registry not found on-chain. Is the program deployed?');
        }
        if (!portfolioAcc) {
          throw new Error(
            'Portfolio not found. Click Set Up Account first and wait for the keeper to create it.',
          );
        }
        if (!bookAcc) {
          throw new Error(
            'Book account not found. Set NEXT_PUBLIC_BOOK_ADDRESS to the matcher-owned book.',
          );
        }

        const registry = sdk.state.decodeRegistry(new Uint8Array(registryAcc.data));
        const { batchPda, batchId } = await resolveOpenBatch({
          connection,
          programId: config.coreProgramId,
          batchIdCounter: registry.batchIdCounter,
          batchAddress: config.batchAddress,
        });
        // Committing == open collection window for DFBA posts (checked in resolveOpenBatch).

        const sideByte = params.side === 'buy' ? sdk.Side.Buy : sdk.Side.Sell;
        const isMaker = params.isMaker ?? false;

        const ixData = sdk.programs.encodePostOrder({
          side: sideByte,
          isMaker,
          price: params.price,
          qty: params.qty,
          instrumentId: params.instrumentId,
          reduceOnly: params.reduceOnly,
        });

        // Accounts per process_post_order:
        // 0. portfolio  1. user  2. batch  3. registry  4. book  5. matcher
        const ix = new TransactionInstruction({
          keys: [
            { pubkey: portfolioPda, isSigner: false, isWritable: true },
            { pubkey: publicKey, isSigner: true, isWritable: false },
            { pubkey: batchPda, isSigner: false, isWritable: true },
            { pubkey: registryPda, isSigner: false, isWritable: false },
            { pubkey: bookPda, isSigner: false, isWritable: true },
            { pubkey: config.matcherProgramId, isSigner: false, isWritable: false },
          ],
          programId: config.coreProgramId,
          data: Buffer.from(ixData),
        });

        setOrder({
          instrumentId: params.instrumentId,
          side: params.side,
          price: params.price,
          qty: params.qty,
          reduceOnly: params.reduceOnly,
          batchId,
          salt: 0n,
          hash: '',
          isMaker,
        });
        setStatus('submitting');

        const tx = new Transaction().add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT_POST }),
          ix,
        );

        const sig = await sendTransaction(tx, connection);
        await connection.confirmTransaction(sig, 'confirmed');

        setStatus('done');
        clear();

        return { sig, batchId, isMaker };
      } catch (e) {
        const decoded = decodeProgramError(e);
        applySeverity(decoded.severity, { setStatus, clear });
        const enriched = new Error(decoded.message) as Error & {
          decoded: DecodedProgramError;
        };
        enriched.decoded = decoded;
        throw enriched;
      }
    },
    [publicKey, sendTransaction, connection, setOrder, setStatus, clear],
  );

  return { post };
}
