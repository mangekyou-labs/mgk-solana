'use client';

import { useCallback } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import * as sdk from '@mgk/sdk';

import { config } from '@/lib/config';
import { resolveBatchAddress, resolveRegistryAddress } from '@/lib/onchainAccounts';
import {
  useOrderFormStore,
  type OrderFormStatus,
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
}

export interface RevealParams {
  instrumentId: number;
  side: OrderSide;
  price: bigint;
  qty: bigint;
  reduceOnly: boolean;
  salt: bigint;
  batchId?: bigint;
}

const CU_LIMIT_COMMIT = 200_000;
const CU_LIMIT_REVEAL = 200_000;
const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');
const COMMITMENT_RECOVERY_WAIT_MS = 20_000;
const COMMITMENT_RECOVERY_POLL_MS = 1_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function activeBatchIdFromCounter(batchIdCounter: bigint): bigint {
  if (batchIdCounter === 0n) {
    throw new Error('No active batch. Wait for the keeper to open committing.');
  }
  return batchIdCounter - 1n;
}

export function commitOrderAccountCount(): number {
  return 6;
}

/** Match the wallet-adapter / web3.js error format for a custom program
 *  error, which surfaces in the message string as either:
 *    "custom program error: 0x258"   (decimal 600 = RevealDeadlineExpired)
 *  or the older non-prefixed variant in some wallet builds:
 *    "failed to send transaction: ... 0x1f7"  (decimal 503 = InvalidCommitment)
 *
 *  We also accept a pre-parsed integer in `code` if the caller already
 *  pulled it out of `error.transactionError`. */
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
  /** Raw on-chain error code, or null if this wasn't a program error. */
  code: number | null;
  /** Severity routing: slashed / retryable / fatal / unknown. */
  severity: sdk.ErrorSeverity;
  /** Human-friendly message, or the original error's message if not a program error. */
  message: string;
}

/** Decode a thrown wallet-adapter / web3.js error into a structured
 *  { code, severity, message } object. The severity drives the local
 *  state-machine (slashed → clear localStorage; retryable → keep state
 *  so the user can adjust and retry). */
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

/** Apply the severity decision to the order-form store: slashed → clear
 *  the in-flight commit-reveal state, retryable/fatal/unknown → mark
 *  failed so the user can see + retry without losing inputs. */
function applySeverity(
  severity: sdk.ErrorSeverity,
  setters: { setStatus: (s: OrderFormStatus) => void; clear: () => void },
): void {
  if (severity === 'slashed') {
    setters.setStatus('slashed');
    setters.clear();
  } else {
    setters.setStatus('failed');
  }
}

/**
 * Hook to commit an order: generates salt, computes commitment hash,
 * builds and sends CommitOrder tx, persists state to localStorage.
 *
 * On failure, the thrown error is augmented with a `decoded` property
 * (see {@link DecodedProgramError}) so callers (e.g. the trade page)
 * can show a friendly message and route by severity.
 */
export function useCommitOrder() {
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const setOrder = useOrderFormStore((s) => s.setOrder);
  const setStatus = useOrderFormStore((s) => s.setStatus);
  const clear = useOrderFormStore((s) => s.clear);

  const commit = useCallback(
    async (params: CommitParams) => {
      if (!publicKey || !sendTransaction) {
        throw new Error('Wallet not connected');
      }

      let pendingCommit:
        | {
            batchId: bigint;
            hash: string;
            salt: bigint;
            commitmentPda: PublicKey;
          }
        | null = null;

      try {
        // Re-fetch registry for live batch_id — the store may be stale by
        // the time the user clicks Buy (batch transitioned to Revealing).
        const registryPda = resolveRegistryAddress(config.coreProgramId);
        const [portfolioPda] = sdk.derivePortfolioPda(
          publicKey,
          config.coreProgramId,
        );

        // Batch registry + portfolio into a single RPC call to reduce
        // rate-limit pressure on the devnet endpoint.
        const [registryAcc, portfolioAcc] =
          await connection.getMultipleAccountsInfo([registryPda, portfolioPda]);
        if (!registryAcc) {
          throw new Error('Registry not found on-chain. Is the program deployed?');
        }
        if (!portfolioAcc) {
          throw new Error(
            'Portfolio not found. Click Set Up Account first and wait for the keeper to create it.',
          );
        }

        const registry = sdk.state.decodeRegistry(new Uint8Array(registryAcc.data));
        const batchId = activeBatchIdFromCounter(registry.batchIdCounter);

        // Fetch batch to verify it's in Committing phase.
        const batchPda = await resolveBatchAddress({
          batchId,
          programId: config.coreProgramId,
          batchAddress: config.batchAddress,
        });
        const batchAcc = await connection.getAccountInfo(batchPda);
        if (!batchAcc) {
          throw new Error('Batch account not found. Wait for the keeper to open committing.');
        }
        const batch = sdk.state.decodeBatch(new Uint8Array(batchAcc.data));
        if (batch.status !== sdk.state.BatchStatus.Committing) {
          throw new Error(
            `Batch is not accepting commits (status=${batch.status}). Wait for the next committing phase.`,
          );
        }

        const currentSlot = await connection.getSlot();
        if (BigInt(currentSlot) >= batch.commitDeadlineSlot) {
          throw new Error(
            'Commit deadline passed. Wait for the keeper to open a new batch.',
          );
        }

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
          batchId,
        );

        const [commitmentPda, commitmentBump] = sdk.deriveCommitmentPda(
          batchId,
          publicKey,
          salt,
          config.coreProgramId,
        );
        pendingCommit = { batchId, hash, salt, commitmentPda };

        const ixData = sdk.programs.encodeCommitOrder({
          orderType: sdk.state.OrderType.LimitGTC,
          instrumentId: params.instrumentId,
          reduceOnly: params.reduceOnly,
          side: sideByte,
          price: params.price,
          qty: params.qty,
          salt,
          batchId,
          commitmentBump,
        });

        // Full 5-account set per process_commit_order:
        // 0. commitment_pda   (writable) — stores the commitment hash
        // 1. user            (signer)   — wallet signing the tx
        // 2. portfolio_pda   (writable) — locks margin deposit
        // 3. batch_pda       (writable) — verifies batch and increments commitment count
        // 4. registry_pda     (read-only) — checks trading pause flag
        // 5. system_program   (read-only) — available for program-created commitment PDA
        const ix = new TransactionInstruction({
          keys: [
            { pubkey: commitmentPda, isSigner: false, isWritable: true },
            { pubkey: publicKey, isSigner: true, isWritable: false },
            { pubkey: portfolioPda, isSigner: false, isWritable: true },
            { pubkey: batchPda, isSigner: false, isWritable: true },
            { pubkey: registryPda, isSigner: false, isWritable: false },
            { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
          ],
          programId: config.coreProgramId,
          data: Buffer.from(ixData),
        });

        // Persist the reveal material before opening Phantom. Some wallet
        // unsafe-confirm paths can return "User rejected" even after the
        // transaction lands, and without the salt the order cannot be revealed.
        setOrder({
          instrumentId: params.instrumentId,
          side: params.side,
          price: params.price,
          qty: params.qty,
          reduceOnly: params.reduceOnly,
          batchId,
          salt,
          hash,
        });
        setStatus('committing');

        const tx = new Transaction().add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT_COMMIT }),
          ix,
        );

        const sig = await sendTransaction(tx, connection);
        await connection.confirmTransaction(sig, 'confirmed');

        setStatus('awaiting_reveal');

        return { sig, hash, salt, commitmentPda, batchId };
      } catch (e) {
        if (pendingCommit) {
          const startedAt = Date.now();
          while (Date.now() - startedAt < COMMITMENT_RECOVERY_WAIT_MS) {
            const commitmentAcc = await connection.getAccountInfo(
              pendingCommit.commitmentPda,
              'confirmed',
            );
            if (commitmentAcc) {
              setStatus('awaiting_reveal');
              return { sig: '', ...pendingCommit };
            }
            await sleep(COMMITMENT_RECOVERY_POLL_MS);
          }
        }

        const decoded = decodeProgramError(e);
        applySeverity(decoded.severity, { setStatus, clear });
        // Re-throw with the decoded payload attached so callers can
        // inspect it without re-parsing the message.
        const enriched = new Error(decoded.message) as Error & {
          decoded: DecodedProgramError;
        };
        enriched.decoded = decoded;
        throw enriched;
      }
    },
    [publicKey, sendTransaction, connection, setOrder, setStatus, clear],
  );

  return { commit };
}

/**
 * Hook to reveal a previously-committed order: reads state from the
 * order form store, builds and sends the RevealOrder tx.
 *
 * Same severity-aware failure routing as {@link useCommitOrder}.
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
    const storedBatchId = params?.batchId ?? storeState.batchId;

    if (storedBatchId === null) {
      throw new Error('No batchId in order state. Have you committed an order?');
    }

    setStatus('revealing');

    try {
      // Re-fetch registry to verify batch is still in Revealing phase.
      const registryPda = resolveRegistryAddress(config.coreProgramId);
      const registryAcc = await connection.getAccountInfo(registryPda);
      if (!registryAcc) {
        throw new Error('Registry not found on-chain.');
      }

      const batchPda = await resolveBatchAddress({
        batchId: storedBatchId,
        programId: config.coreProgramId,
        batchAddress: config.batchAddress,
      });
      const batchAcc = await connection.getAccountInfo(batchPda);
      if (!batchAcc) {
        throw new Error('Batch account not found.');
      }
      const batch = sdk.state.decodeBatch(new Uint8Array(batchAcc.data));
      if (batch.status !== sdk.state.BatchStatus.Revealing) {
        throw new Error(
          `Batch is not in revealing phase (status=${batch.status}).`,
        );
      }

      const [portfolioPda] = sdk.derivePortfolioPda(
        publicKey,
        config.coreProgramId,
      );

      const sideByte = side === 'buy' ? sdk.Side.Buy : sdk.Side.Sell;

      const ixData = sdk.programs.encodeRevealOrder({
        orderType: sdk.state.OrderType.LimitGTC,
        instrumentId,
        reduceOnly,
        side: sideByte,
        price,
        qty,
        salt,
        batchId: storedBatchId,
      });

      // Full 5-account set per process_reveal_order:
      // 0. commitment_pda   (writable) — confirms the hash matches
      // 1. user             (signer)   — wallet
      // 2. portfolio_pda    (writable) — records the revealed order
      // 3. batch_pda        (read-only) — verifies batch is in Revealing
      // 4. registry_pda     (read-only) — checks trading pause flag
      const [commitmentPda] = sdk.deriveCommitmentPda(
        storedBatchId,
        publicKey,
        salt,
        config.coreProgramId,
      );

      const ix = new TransactionInstruction({
        keys: [
          { pubkey: commitmentPda, isSigner: false, isWritable: true },
          { pubkey: publicKey, isSigner: true, isWritable: false },
          { pubkey: portfolioPda, isSigner: false, isWritable: true },
          { pubkey: batchPda, isSigner: false, isWritable: true },
          { pubkey: registryPda, isSigner: false, isWritable: false },
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
      const decoded = decodeProgramError(e);
      applySeverity(decoded.severity, { setStatus, clear });
      const enriched = new Error(decoded.message) as Error & {
        decoded: DecodedProgramError;
      };
      enriched.decoded = decoded;
      throw enriched;
    }
  }, [publicKey, sendTransaction, connection, storeState, setStatus, clear]);

  return { reveal };
}
