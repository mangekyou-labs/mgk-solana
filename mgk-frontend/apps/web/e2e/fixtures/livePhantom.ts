import { readFileSync } from 'node:fs';

import type { Page } from '@playwright/test';
import { Connection, Keypair, Transaction } from '@solana/web3.js';

export interface LiveWalletInitPayload {
  publicKeyBytes: number[];
  publicKeyBase58: string;
}

export interface SendRawConnection {
  sendRawTransaction(
    raw: Buffer | Uint8Array | number[],
    options?: unknown,
  ): Promise<string>;
}

export function loadKeypairFromPath(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as number[];
  if (!Array.isArray(raw)) {
    throw new Error(`Keypair file is not a JSON byte array: ${path}`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

export function liveWalletInitPayload(keypairPath: string): LiveWalletInitPayload {
  const keypair = loadKeypairFromPath(keypairPath);
  return {
    publicKeyBytes: Array.from(keypair.publicKey.toBytes()),
    publicKeyBase58: keypair.publicKey.toBase58(),
  };
}

export function signSerializedTransaction(
  keypairPath: string,
  serialized: Uint8Array | number[],
): Buffer {
  const keypair = loadKeypairFromPath(keypairPath);
  const tx = Transaction.from(Uint8Array.from(serialized));
  tx.partialSign(keypair);
  return tx.serialize();
}

export async function signAndSendSerializedTransaction(args: {
  keypairPath: string;
  connection: SendRawConnection;
  serialized: Uint8Array | number[];
}): Promise<string> {
  const raw = signSerializedTransaction(args.keypairPath, args.serialized);
  return args.connection.sendRawTransaction(raw);
}

/**
 * Inject a Phantom-compatible provider whose public key is visible in the
 * page, while signing and sendRawTransaction stay in this Node process.
 */
export async function installLiveSigningWallet(
  page: Page,
  options: { keypairPath: string; rpcUrl: string },
): Promise<{ publicKeyBase58: string }> {
  const payload = liveWalletInitPayload(options.keypairPath);
  const { keypairPath, rpcUrl } = options;

  await page.exposeFunction(
    '__mgkLiveSign',
    async (serialized: number[]) =>
      Array.from(signSerializedTransaction(keypairPath, serialized)),
  );
  await page.exposeFunction(
    '__mgkLiveSignAndSend',
    async (serialized: number[]) => {
      const connection = new Connection(rpcUrl, 'confirmed');
      return signAndSendSerializedTransaction({
        keypairPath,
        connection,
        serialized,
      });
    },
  );

  await page.addInitScript(
    ({ publicKeyBytes, publicKeyBase58 }) => {
      const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
      const emit = (event: string, ...args: unknown[]) => {
        for (const listener of listeners.get(event) ?? []) listener(...args);
      };

      const publicKey = {
        toBytes: () => new Uint8Array(publicKeyBytes),
        toBase58: () => publicKeyBase58,
        toString: () => publicKeyBase58,
        equals: (other: { toBase58?: () => string } | string) =>
          (typeof other === 'string' ? other : other?.toBase58?.()) ===
          publicKeyBase58,
      };

      const hopWindow = window as Window & {
        __mgkLiveSign?: (serialized: number[]) => Promise<number[]>;
        __mgkLiveSignAndSend?: (serialized: number[]) => Promise<string>;
      };

      const wallet = {
        isPhantom: true,
        isConnected: false,
        publicKey,
        on(event: string, listener: (...args: unknown[]) => void) {
          const eventListeners = listeners.get(event) ?? new Set();
          eventListeners.add(listener);
          listeners.set(event, eventListeners);
        },
        off(event: string, listener: (...args: unknown[]) => void) {
          listeners.get(event)?.delete(listener);
        },
        async connect() {
          wallet.isConnected = true;
          emit('connect', publicKey);
          return { publicKey };
        },
        async disconnect() {
          wallet.isConnected = false;
          emit('disconnect');
        },
        async signTransaction<T extends { serialize: (opts?: { requireAllSignatures: boolean }) => Uint8Array; constructor: { from?: (data: Uint8Array) => T } }>(
          transaction: T,
        ) {
          const hop = hopWindow.__mgkLiveSign;
          if (typeof hop !== 'function') {
            throw new Error('Live wallet sign hop is not installed');
          }
          const signed = await hop(
            Array.from(transaction.serialize({ requireAllSignatures: false })),
          );
          if (typeof transaction.constructor.from === 'function') {
            return transaction.constructor.from(Uint8Array.from(signed));
          }
          return transaction;
        },
        async signAllTransactions<T extends { serialize: (opts?: { requireAllSignatures: boolean }) => Uint8Array; constructor: { from?: (data: Uint8Array) => T } }>(transactions: T[]) {
          return Promise.all(
            transactions.map((tx) =>
              wallet.signTransaction(tx),
            ),
          );
        },
        async signAndSendTransaction(transaction: {
          serialize: (opts?: { requireAllSignatures: boolean }) => Uint8Array;
          constructor: { from?: (data: Uint8Array) => typeof transaction };
        }) {
          const signed = await wallet.signTransaction(transaction);
          const hop = hopWindow.__mgkLiveSignAndSend;
          if (typeof hop !== 'function') {
            throw new Error('Live wallet send hop is not installed');
          }
          const signature = await hop(Array.from(signed.serialize()));
          return { signature };
        },
        async signMessage() {
          throw new Error('Live persona wallet does not support signMessage');
        },
      };

      Object.defineProperty(window, 'isPhantomInstalled', {
        configurable: true,
        value: true,
      });
      Object.defineProperty(window, 'phantom', {
        configurable: true,
        value: { solana: wallet },
      });
      Object.defineProperty(window, 'solana', {
        configurable: true,
        value: wallet,
      });
      localStorage.setItem('walletName', JSON.stringify('Phantom'));
    },
    payload,
  );

  return { publicKeyBase58: payload.publicKeyBase58 };
}
