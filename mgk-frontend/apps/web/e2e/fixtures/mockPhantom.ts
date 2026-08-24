import type { Page, Route } from '@playwright/test';
import { PublicKey } from '@solana/web3.js';

import { config } from '../../lib/config';

const TEST_PUBLIC_KEY_BYTES = Array.from(
  { length: 32 },
  (_, index) => index + 1,
);

const TEST_SIGNATURE = '1'.repeat(64);
const TEST_BLOCKHASH = '1'.repeat(32);
const TEST_SLOT = 42;
const REGISTRY_SIZE = 86;
const PORTFOLIO_SIZE = 1_456;
const BATCH_SIZE = 160;
const COLLECTING_STATUS = 0;
const CLEARING_STATUS = 2;
const SETTLED_STATUS = 3;

export type MockBatchPhase =
  | 'collecting'
  | 'collecting-ready'
  | 'clearing'
  | 'settled-valid'
  | 'settled-invalid';

export interface MockRpcHandle {
  batchAddress: PublicKey;
  setBatchPhase: (phase: MockBatchPhase) => void;
  /** Set a deterministic position on the mock portfolio. */
  setPortfolioPosition: (instrumentId: number, qty: bigint, entryVwap?: bigint) => void;
}

export const TEST_WALLET_PUBLIC_KEY = new PublicKey(
  Uint8Array.from(TEST_PUBLIC_KEY_BYTES),
);

export interface CapturedInstruction {
  programId: string;
  data: number[];
  keys: Array<{
    pubkey: string;
    isSigner: boolean;
    isWritable: boolean;
  }>;
}

export interface CapturedTransaction {
  feePayer: string | null;
  recentBlockhash: string | null;
  instructions: CapturedInstruction[];
}

interface JsonRpcRequest {
  jsonrpc: string;
  id: string | number;
  method: string;
  params?: unknown[];
}

interface MockAccount {
  data: [string, 'base64'];
  executable: boolean;
  lamports: number;
  owner: string;
  rentEpoch: number;
  space: number;
}

function writeI128(view: DataView, offset: number, value: bigint): void {
  const mask = 0xffffffffffffffffn;
  view.setBigUint64(offset, value & mask, true);
  view.setBigInt64(offset + 8, value >> 64n, true);
}

function encodeRegistry(): Uint8Array {
  const data = new Uint8Array(REGISTRY_SIZE);
  const view = new DataView(data.buffer);
  data.set(TEST_WALLET_PUBLIC_KEY.toBytes(), 0);
  view.setUint16(32, 1, true);
  view.setBigUint64(36, 1n, true);
  view.setBigUint64(44, 10_000_000n, true);
  view.setBigUint64(56, 1n, true);
  view.setBigUint64(64, 4n, true);
  return data;
}

/** Portfolio layout: user(32) + equity(16) + principal(16) + pnl(16) + im(16) + mm(16) + free_collateral(16) + health(16) + positions_len(2) + positions(32*24) + ... */
const PORTFOLIO_OFFSETS = {
  user: 0,
  equity: 32,
  positionsLen: 144,
  positionsStart: 146,
} as const;

function encodePortfolio(): Uint8Array {
  const data = new Uint8Array(PORTFOLIO_SIZE);
  const view = new DataView(data.buffer);
  data.set(TEST_WALLET_PUBLIC_KEY.toBytes(), 0);
  writeI128(view, 32, 5_000_000_000n);
  writeI128(view, 48, 5_000_000_000n);
  writeI128(view, 112, 5_000_000_000n);
  writeI128(view, 128, 5_000_000_000n);
  return data;
}

function encodePortfolioWithPosition(
  instrumentId: number,
  qty: bigint,
  entryVwap: bigint,
): Uint8Array {
  const data = encodePortfolio();
  const view = new DataView(data.buffer);
  // positions_len = 1
  view.setUint16(PORTFOLIO_OFFSETS.positionsLen, 1, true);
  const off = PORTFOLIO_OFFSETS.positionsStart;
  view.setUint16(off, instrumentId, true);
  view.setBigInt64(off + 2, qty, true);
  view.setBigInt64(off + 10, entryVwap, true);
  return data;
}

function encodeBatch(phase: MockBatchPhase = 'collecting'): Uint8Array {
  const data = new Uint8Array(BATCH_SIZE);
  const view = new DataView(data.buffer);
  view.setBigUint64(0, 0n, true);
  view.setBigUint64(16, 100n, true);
  switch (phase) {
    case 'collecting':
      view.setUint8(8, COLLECTING_STATUS);
      break;
    case 'collecting-ready':
      view.setUint8(8, COLLECTING_STATUS);
      view.setBigUint64(16, 10n, true);
      break;
    case 'clearing':
      view.setUint8(8, CLEARING_STATUS);
      view.setBigUint64(32, BigInt(TEST_SLOT), true);
      break;
    case 'settled-valid':
      view.setUint8(8, SETTLED_STATUS);
      view.setUint8(152, 1);
      view.setUint8(153, 0);
      break;
    case 'settled-invalid':
      view.setUint8(8, SETTLED_STATUS);
      view.setUint8(152, 0);
      view.setUint8(153, 1);
      break;
  }
  return data;
}

function rpcAccount(data: Uint8Array, owner: PublicKey): MockAccount {
  return {
    data: [Buffer.from(data).toString('base64'), 'base64'],
    executable: false,
    lamports: 1_000_000,
    owner: owner.toBase58(),
    rentEpoch: 0,
    space: data.length,
  };
}

function createAccountFixtures(): {
  accounts: Map<string, MockAccount>;
  batchAddress: PublicKey;
} {
  const [portfolioAddress] = PublicKey.findProgramAddressSync(
    [Buffer.from('portfolio'), TEST_WALLET_PUBLIC_KEY.toBytes()],
    config.coreProgramId,
  );
  const batchId = Buffer.alloc(8);
  batchId.writeBigUInt64LE(0n);
  const [batchAddress] = PublicKey.findProgramAddressSync(
    [Buffer.from('batch'), batchId],
    config.coreProgramId,
  );
  if (!config.registryAddress || !config.bookAddress) {
    throw new Error('Playwright wallet fixture requires registry and book defaults');
  }

  return {
    accounts: new Map([
      [
        config.registryAddress.toBase58(),
        rpcAccount(encodeRegistry(), config.coreProgramId),
      ],
      [
        portfolioAddress.toBase58(),
        rpcAccount(encodePortfolio(), config.coreProgramId),
      ],
      [
        config.bookAddress.toBase58(),
        rpcAccount(new Uint8Array(27_704), config.matcherProgramId),
      ],
      [
        batchAddress.toBase58(),
        rpcAccount(encodeBatch('collecting'), config.coreProgramId),
      ],
    ]),
    batchAddress,
  };
}

function rpcResult(
  request: JsonRpcRequest,
  accounts: Map<string, MockAccount>,
): unknown {
  const context = { slot: TEST_SLOT };
  const params = request.params ?? [];

  switch (request.method) {
    case 'getAccountInfo':
      return {
        context,
        value: accounts.get(String(params[0])) ?? null,
      };
    case 'getMultipleAccounts': {
      const addresses = Array.isArray(params[0]) ? params[0] : [];
      return {
        context,
        value: addresses.map((address) => accounts.get(String(address)) ?? null),
      };
    }
    case 'getLatestBlockhash':
      return {
        context,
        value: {
          blockhash: TEST_BLOCKHASH,
          lastValidBlockHeight: 10_000,
        },
      };
    case 'getSignatureStatuses':
      return {
        context,
        value: [
          {
            slot: TEST_SLOT,
            confirmations: null,
            err: null,
            confirmationStatus: 'confirmed',
          },
        ],
      };
    case 'getBalance':
      return { context, value: 5_000_000_000 };
    case 'getFeeForMessage':
      return { context, value: 5_000 };
    case 'getSlot':
      return TEST_SLOT;
    case 'getBlockHeight':
      return TEST_SLOT;
    case 'getProgramAccounts':
    case 'getSignaturesForAddress':
    case 'getRecentPerformanceSamples':
      return [];
    case 'getTokenAccountsByOwner':
      return { context, value: [] };
    case 'sendTransaction':
      return TEST_SIGNATURE;
    case 'simulateTransaction':
      return {
        context,
        value: {
          err: null,
          logs: [],
          accounts: null,
          unitsConsumed: 10_000,
        },
      };
    default:
      return null;
  }
}

async function handleRpcRoute(
  route: Route,
  accounts: Map<string, MockAccount>,
): Promise<boolean> {
  const body = route.request().postData();
  if (!body) return false;

  let parsed: JsonRpcRequest | JsonRpcRequest[];
  try {
    parsed = JSON.parse(body) as JsonRpcRequest | JsonRpcRequest[];
  } catch {
    return false;
  }

  const requests = Array.isArray(parsed) ? parsed : [parsed];
  if (!requests.every((request) => request.jsonrpc === '2.0' && request.method)) {
    return false;
  }

  const responses = requests.map((request) => ({
    jsonrpc: '2.0',
    id: request.id,
    result: rpcResult(request, accounts),
  }));
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(Array.isArray(parsed) ? responses : responses[0]),
  });
  return true;
}

/** Serve deterministic registry, portfolio, book, batch, and RPC state. */
export async function installMockSolanaRpc(page: Page): Promise<MockRpcHandle> {
  const { accounts, batchAddress } = createAccountFixtures();

  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url === `${config.indexerUrl}/api/batch/current`) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          batchId: '0',
          batchAddress: batchAddress.toBase58(),
        }),
      });
      return;
    }
    if (url.startsWith(`${config.indexerUrl}/api/`)) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: '{}',
      });
      return;
    }
    if (await handleRpcRoute(route, accounts)) return;
    await route.fallback();
  });

  return {
    batchAddress,
    setBatchPhase(phase) {
      accounts.set(
        batchAddress.toBase58(),
        rpcAccount(encodeBatch(phase), config.coreProgramId),
      );
    },
    setPortfolioPosition(instrumentId, qty, entryVwap = 0n) {
      const [portfolioAddress] = PublicKey.findProgramAddressSync(
        [Buffer.from('portfolio'), TEST_WALLET_PUBLIC_KEY.toBytes()],
        config.coreProgramId,
      );
      accounts.set(
        portfolioAddress.toBase58(),
        rpcAccount(encodePortfolioWithPosition(instrumentId, qty, entryVwap), config.coreProgramId),
      );
    },
  };
}

/**
 * Inject a deterministic Phantom-compatible provider before the app loads.
 * It auto-approves connection and transaction requests, so Playwright never
 * opens an extension popup or exposes a real wallet key.
 */
export async function installMockPhantom(page: Page): Promise<void> {
  await page.addInitScript(
    ({ publicKeyBytes, signature }) => {
      type Listener = (...args: unknown[]) => void;
      const listeners = new Map<string, Set<Listener>>();

      const emit = (event: string, ...args: unknown[]) => {
        for (const listener of listeners.get(event) ?? []) listener(...args);
      };

      const publicKey = {
        toBytes: () => new Uint8Array(publicKeyBytes),
      };

      const testWindow = window as Window & {
        __mgkE2eTransactions?: CapturedTransaction[];
      };
      testWindow.__mgkE2eTransactions = [];

      const wallet = {
        isPhantom: true,
        isConnected: false,
        publicKey,
        on(event: string, listener: Listener) {
          const eventListeners = listeners.get(event) ?? new Set<Listener>();
          eventListeners.add(listener);
          listeners.set(event, eventListeners);
        },
        off(event: string, listener: Listener) {
          listeners.get(event)?.delete(listener);
        },
        async connect() {
          wallet.isConnected = true;
          emit('connect', publicKey);
        },
        async disconnect() {
          wallet.isConnected = false;
          emit('disconnect');
        },
        async signTransaction<T>(transaction: T) {
          return transaction;
        },
        async signAllTransactions<T>(transactions: T[]) {
          return transactions;
        },
        async signAndSendTransaction(transaction: {
          feePayer?: { toBase58(): string };
          recentBlockhash?: string;
          instructions?: Array<{
            programId: { toBase58(): string };
            data: Uint8Array;
            keys: Array<{
              pubkey: { toBase58(): string };
              isSigner: boolean;
              isWritable: boolean;
            }>;
          }>;
        }) {
          testWindow.__mgkE2eTransactions?.push({
            feePayer: transaction.feePayer?.toBase58() ?? null,
            recentBlockhash: transaction.recentBlockhash ?? null,
            instructions: (transaction.instructions ?? []).map((instruction) => ({
              programId: instruction.programId.toBase58(),
              data: Array.from(instruction.data),
              keys: instruction.keys.map((key) => ({
                pubkey: key.pubkey.toBase58(),
                isSigner: key.isSigner,
                isWritable: key.isWritable,
              })),
            })),
          });
          return { signature };
        },
        async signMessage() {
          return { signature: new Uint8Array(64) };
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
    { publicKeyBytes: TEST_PUBLIC_KEY_BYTES, signature: TEST_SIGNATURE },
  );
}

export async function readCapturedTransactions(
  page: Page,
): Promise<CapturedTransaction[]> {
  return page.evaluate(
    () =>
      (
        window as Window & {
          __mgkE2eTransactions?: CapturedTransaction[];
        }
      ).__mgkE2eTransactions ?? [],
  );
}
