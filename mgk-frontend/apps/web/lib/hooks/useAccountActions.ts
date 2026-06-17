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

/** lamports in 1 SOL */
const SOL = 1_000_000_000n;

const CU_LIMIT = 200_000;

export interface AccountActionResult {
  sig: string;
}

/**
 * Hook for portfolio lifecycle operations: create, deposit, withdraw.
 */
export function useAccountActions() {
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();

  const initPortfolio = useCallback(async (): Promise<AccountActionResult> => {
    if (!publicKey || !sendTransaction) {
      throw new Error('Wallet not connected');
    }

    const [portfolioPda, bump] = sdk.derivePortfolioPda(
      publicKey,
      config.coreProgramId,
    );

    const ixData = sdk.programs.encodeInitPortfolio(
      publicKey.toBytes(),
      bump,
    );

    const ix = new TransactionInstruction({
      keys: [
        { pubkey: portfolioPda, isSigner: false, isWritable: true },
        { pubkey: publicKey, isSigner: true, isWritable: false },
      ],
      programId: config.coreProgramId,
      data: Buffer.from(ixData),
    });

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT }),
      ix,
    );

    const sig = await sendTransaction(tx, connection);
    await connection.confirmTransaction(sig, 'confirmed');
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
      const [vaultPda] = sdk.deriveVaultPda(config.coreProgramId);

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

      const sig = await sendTransaction(tx, connection);
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
      const [vaultPda] = sdk.deriveVaultPda(config.coreProgramId);
      const [registryPda] = sdk.deriveRegistryPda(config.coreProgramId);

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

      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, 'confirmed');
      return { sig };
    },
    [publicKey, sendTransaction, connection],
  );

  return { initPortfolio, deposit, withdraw, SOL };
}
