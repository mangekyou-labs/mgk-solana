'use client';

import { useCallback } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import {
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
 * Portfolio creation flow (T9.10 / DFBA):
 * - The connected wallet sends InitPortfolioForUser (disc 19) directly,
 *   signing as both payer and user. The on-chain instruction verifies that
 *   `requested_portfolio_user == signer` (i.e. the user can only create
 *   their own portfolio).
 * - The derived Portfolio PDA is included as the target account; the
 *   instruction creates it via SystemProgram.createAccount + init.
 * - Browser wallets (Phantom) can sign this because the PDA is derived
 *   from the connected wallet's pubkey, not a random keypair.
 */
export function useAccountActions() {
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();

  /**
   * Create and initialize the user's Portfolio PDA via InitPortfolioForUser
   * (disc 19). The wallet signs as payer and the instruction verifies the
   * requested user matches the signer — no indexer queue needed.
   */
  const initPortfolio = useCallback(async (): Promise<AccountActionResult> => {
    if (!publicKey) {
      throw new Error('Wallet not connected');
    }

    const [portfolioPda] = sdk.derivePortfolioPda(
      publicKey,
      config.coreProgramId,
    );

    // InitPortfolioForUser (disc 19): wallet sends tx directly.
    // Wire: disc(1) + user_pubkey(32) = 33 bytes.
    const ixData = sdk.programs.encodeInitPortfolioForUser(publicKey.toBuffer());

    const ix = new TransactionInstruction({
      keys: [
        { pubkey: publicKey, isSigner: true, isWritable: true },  // payer / fee-payer
        { pubkey: portfolioPda, isSigner: false, isWritable: true },  // Portfolio PDA (created by instruction)
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: config.coreProgramId,
      data: Buffer.from(ixData),
    });

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT }),
      ix,
    );

    const sig = await sendTransaction(tx, connection, {
      skipPreflight: true,
    });
    await connection.confirmTransaction(sig, 'confirmed');

    // Refresh the portfolio store so the UI flips to Deposit/Withdraw.
    await usePortfolioStore.getState().refresh();

    return { sig };
  }, [publicKey, sendTransaction, connection]);

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
