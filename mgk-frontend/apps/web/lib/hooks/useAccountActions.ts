'use client';

import { useCallback } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import * as sdk from '@mgk/sdk';

import { config } from '@/lib/config';
import { usePortfolioStore } from '@/lib/stores/usePortfolioStore';

/** lamports in 1 SOL */
const SOL = 1_000_000_000n;

const CU_LIMIT = 200_000;

export interface AccountActionResult {
  sig: string;
}

/**
 * Hook for portfolio lifecycle operations: create, deposit, withdraw.
 *
 * Portfolio creation flow (Solana 4.x + Phantom compatibility):
 * - Browser wallets cannot sign SystemProgram.createAccount for PDA addresses
 *   (Phantom blocks at simulation time).
 * - Solution: keeper pre-creates AND initializes portfolio accounts via
 *   InitPortfolioForUser (disc 19). The user NEVER signs an InitPortfolio tx.
 * - The user's first signed tx is Deposit, which Phantom can simulate
 *   against the existing account → no simulation failure.
 */
export function useAccountActions() {
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();

  /**
   * Request portfolio creation from the keeper and poll on-chain until the
   * account exists. Does NOT send any user-signed transaction — the keeper
   * creates and initializes the portfolio via InitPortfolioForUser (disc 19).
   *
   * Once the account exists on-chain, refreshes the portfolio store so the
   * UI auto-flips from "Init Portfolio" to "Deposit / Withdraw".
   *
   * Returns a synthetic "sig" (the portfolio PDA address) for toast display.
   */
  const initPortfolio = useCallback(async (): Promise<AccountActionResult> => {
    if (!publicKey) {
      throw new Error('Wallet not connected');
    }

    const [portfolioPda] = sdk.derivePortfolioPda(
      publicKey,
      config.coreProgramId,
    );

    // Step 1: Notify keeper to pre-create portfolio account via InitPortfolioForUser.
    try {
      const res = await fetch(`${config.indexerUrl}/api/portfolio/request-creation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userPubkey: publicKey.toBase58() }),
      });
      if (!res.ok) {
        console.warn(`[portfolio-queue] request-creation failed: ${res.status}`);
      } else {
        const data = await res.json();
        console.log(`[portfolio-queue] requested (queue size: ${data.queueSize})`);
      }
    } catch (err) {
      // Non-fatal: keeper might be down; we'll still poll on-chain.
      console.warn(`[portfolio-queue] request-creation fetch failed:`, err);
    }

    // Step 2: Poll on-chain until the keeper creates the portfolio account.
    // We poll the actual cluster (via the frontend's RPC) because the account
    // must exist on-chain before the user's next signed tx (Deposit) will
    // pass Phantom's simulation. Polling the indexer DB is insufficient
    // because Phantom uses its own RPC.
    const MAX_WAIT_MS = 30_000;
    const POLL_INTERVAL_MS = 2_000;
    const deadline = Date.now() + MAX_WAIT_MS;

    while (Date.now() < deadline) {
      const acc = await connection.getAccountInfo(portfolioPda);
      if (acc) {
        console.log(
          `[initPortfolio] Portfolio created on-chain at ${portfolioPda.toBase58()}`,
        );
        // Refresh the portfolio store so the UI flips to Deposit/Withdraw.
        await usePortfolioStore.getState().refresh();
        return { sig: portfolioPda.toBase58() };
      }
      console.log(`[initPortfolio] Waiting for keeper to create portfolio...`);
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    throw new Error(
      'Portfolio creation timed out after 30s. Is the keeper running?',
    );
  }, [publicKey, connection]);

  const deposit = useCallback(
    async (amount: bigint): Promise<AccountActionResult> => {
      if (!publicKey || !sendTransaction) {
        throw new Error('Wallet not connected');
      }
      if (amount <= 0n) {
        throw new Error('Deposit amount must be greater than zero');
      }

      const [portfolioPda] = sdk.derivePortfolioPda(
        publicKey,
        config.coreProgramId,
      );
      // Vault is a keypair on devnet (Solana 4.x: PDA can't sign createAccount).
      // Fall back to PDA derivation if no explicit address is configured.
      const vaultPda =
        config.vaultAddress ?? sdk.deriveVaultPda(config.coreProgramId)[0];

      const ixData = sdk.programs.encodeDeposit(amount);

      const ix = new TransactionInstruction({
        keys: [
          { pubkey: portfolioPda, isSigner: false, isWritable: true },
          { pubkey: publicKey, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: vaultPda, isSigner: false, isWritable: true },
        ],
        programId: config.coreProgramId,
        data: Buffer.from(ixData),
      });

      const tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT }),
        ix,
      );

      // Skip RPC preflight — Phantom does its own simulation internally.
      // If Phantom's simulation fails (stale cache), user can confirm via
      // "Confirm (unsafe)" checkbox.
      const sig = await sendTransaction(tx, connection, {
        skipPreflight: true,
      });
      await connection.confirmTransaction(sig, 'confirmed');
      return { sig };
    },
    [publicKey, sendTransaction, connection],
  );

  const withdraw = useCallback(
    async (amount: bigint): Promise<AccountActionResult> => {
      if (!publicKey || !sendTransaction) {
        throw new Error('Wallet not connected');
      }
      if (amount <= 0n) {
        throw new Error('Withdraw amount must be greater than zero');
      }

      const [portfolioPda] = sdk.derivePortfolioPda(
        publicKey,
        config.coreProgramId,
      );
      // Vault and registry are keypairs on devnet (Solana 4.x).
      // Fall back to PDA derivation if no explicit addresses are configured.
      const vaultPda =
        config.vaultAddress ?? sdk.deriveVaultPda(config.coreProgramId)[0];
      const registryPda =
        config.registryAddress ?? sdk.deriveRegistryPda(config.coreProgramId)[0];

      const ixData = sdk.programs.encodeWithdraw(amount);

      const ix = new TransactionInstruction({
        keys: [
          { pubkey: portfolioPda, isSigner: false, isWritable: true },
          { pubkey: publicKey, isSigner: true, isWritable: true },
          { pubkey: vaultPda, isSigner: false, isWritable: true },
          { pubkey: registryPda, isSigner: false, isWritable: false },
        ],
        programId: config.coreProgramId,
        data: Buffer.from(ixData),
      });

      const tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT }),
        ix,
      );

      // Skip RPC preflight — same rationale as deposit.
      const sig = await sendTransaction(tx, connection, {
        skipPreflight: true,
      });
      await connection.confirmTransaction(sig, 'confirmed');
      return { sig };
    },
    [publicKey, sendTransaction, connection],
  );

  return { initPortfolio, deposit, withdraw, SOL };
}
