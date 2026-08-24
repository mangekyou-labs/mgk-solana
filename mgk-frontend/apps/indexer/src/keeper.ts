/**
 * Keeper: monitors and cranks batch lifecycle.
 *
 * Polls the current active batch, calling:
 *   - CloseCommitting  (when deadline reached + n_min met)
 *   - ClearBatch       (when reveal deadline reached, CPI to matcher)
 *   - SettleBatch      (after clear, creates next batch)
 *
 * Also posts oracle price from a CEX feed to the fallback oracle.
 *
 * Usage:
 *   RPC_URL=https://api.devnet.solana.com tsx src/keeper.ts
 *
 * Run AFTER init-protocol.ts has been executed.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type Signer,
} from '@solana/web3.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { state, programs } from '@mgk/sdk';
const { encodeInitPortfolioForUser } = programs;
import type { Store } from './store.js';
import { getPortfolioQueue } from './portfolio-queue.js';
import { isOwnedAccountWithMinimumSize } from './runtimeValidation.js';
import { selectActiveBatchCandidate, shouldCloseCommitting } from './keeperSelection.js';

const { decodeBatch, decodeRegistry, BATCH_SIZE, COMMITMENT_SIZE } = state;

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function encodeBase58(bytes: Uint8Array): string {
  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) {
    leadingZeros += 1;
  }

  const digits: number[] = [];
  for (let i = leadingZeros; i < bytes.length; i += 1) {
    let carry = bytes[i] ?? 0;
    for (let j = 0; j < digits.length; j += 1) {
      carry += (digits[j] ?? 0) * 256;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  let encoded = '1'.repeat(leadingZeros);
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    encoded += BASE58_ALPHABET[digits[i] ?? 0] ?? '';
  }
  return encoded;
}

/** Alchemy devnet doesn't support signatureSubscribe or getSignatureStatus.
 *  Use slot-waiting: after sendTransaction, wait for slot to advance by 2+.
 *  This is safe on devnet where block time is ~400ms. */
async function sendAndConfirmTransactionPolling(
  connection: Connection,
  tx: Transaction,
  signers: Signer[],
  opts: { commitment?: 'processed' | 'confirmed' | 'finalized' } = {},
): Promise<string> {
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  const signerKey = signers[0]?.publicKey;
  if (signerKey) tx.feePayer = tx.feePayer ?? signerKey;
  tx.sign(...signers);
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: opts.commitment ?? 'confirmed',
  });

  // Wait for 3 slots to advance with retry-on-error for RPC rate-limiting
  let startSlot: number;
  try {
    startSlot = await connection.getSlot();
  } catch {
    return sig; // Return sig even if slot fetch fails
  }
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const currentSlot = await connection.getSlot();
      if (currentSlot >= startSlot + 3) {
        return sig;
      }
    } catch {
      // RPC rate-limited — keep waiting
    }
    process.stdout.write('.');
  }
  return sig;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CLUSTER = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const HOME = process.env.HOME ?? '/root';
// Persist batch keypair so keeper survives restarts (Solana 4.x uses keypairs, not PDAs for batches)
const BATCH_KEYPAIR_PATH = join(HOME, '.config', 'solana', 'mgk-batch-keypair.json');
// Oracle keypair: created once by keeper (oracle PDA cannot be created via createAccount on Solana 4.x)
const ORACLE_KEYPAIR_PATH = join(HOME, '.config', 'solana', 'mgk-oracle-keypair.json');

// Account sizes
const BOOK_SIZE = 36_000;  // BookState (~36KB)
const VAULT_SIZE = 80;
const INSTRUMENT_SIZE = 336; // BPF layout: size_of::<Instrument>()
const PORTFOLIO_SPACE = 1456; // BPF layout: size_of::<Portfolio>() on sbf-solana-solana (i128 8-byte aligned)
const RESULTS_SIZE = 2 + 64 * 49; // header(2) + max_fills(64) * 49
const ORACLE_SIZE = 128;   // PriceOracle (verified against PRICE_ORACLE_SIZE in oracle state.rs)

// ---------------------------------------------------------------------------
// Encoding helpers (mirror SDK encode functions)
// ---------------------------------------------------------------------------

/** CreateBatch — disc(16) + bump(1). Entrypoint strips disc 16, passes bump to inner. */
function encodeCreateBatch(bump: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt8(16, 0);   // discriminator 16 → CreateBatch dispatch
  buf.writeUInt8(bump, 1);  // bump passed to inner
  return buf;
}

/** CloseCommitting — discriminator 6, no data. */
function encodeCloseCommitting(): Buffer {
  return Buffer.from([6]);
}

/** ClearBatch — disc(1) + num_commitments(2) + num_instruments(2) + num_portfolios(2) = 7 bytes. */
function encodeClearBatch(
  numCommitments: number,
  numInstruments: number,
  numPortfolios: number,
): Buffer {
  const buf = Buffer.alloc(7);
  buf.writeUInt8(7, 0);
  buf.writeUInt16LE(numCommitments, 1);
  buf.writeUInt16LE(numInstruments, 3);
  buf.writeUInt16LE(numPortfolios, 5);
  return buf;
}

/** SettleBatch — disc(1) + num_commitments(2) + num_portfolios(2) = 5 bytes. */
function encodeSettleBatch(numCommitments: number, numPortfolios: number): Buffer {
  const buf = Buffer.alloc(5);
  buf.writeUInt8(8, 0);
  buf.writeUInt16LE(numCommitments, 1);
  buf.writeUInt16LE(numPortfolios, 3);
  return buf;
}

// ---------------------------------------------------------------------------
// PDA helpers
// ---------------------------------------------------------------------------

function findPda(seeds: Buffer[], programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(seeds, programId);
}

function deriveBatchPda(batchId: bigint, programId: PublicKey): [PublicKey, number] {
  const idBuf = Buffer.alloc(8);
  idBuf.writeBigUInt64LE(batchId, 0);
  return findPda([Buffer.from('batch', 'utf8'), idBuf], programId);
}

function deriveVaultPda(programId: PublicKey): [PublicKey, number] {
  return findPda([Buffer.from('vault', 'utf8')], programId);
}

function deriveRegistryPda(programId: PublicKey): [PublicKey, number] {
  return findPda([Buffer.from('registry', 'utf8')], programId);
}

function deriveInstrumentPda(instrumentId: number, programId: PublicKey): [PublicKey, number] {
  const idBuf = Buffer.alloc(2);
  idBuf.writeUInt16LE(instrumentId, 0);
  return findPda([Buffer.from('instrument', 'utf8'), idBuf], programId);
}

function deriveBookPda(instrumentId: number, programId: PublicKey): [PublicKey, number] {
  const idBuf = Buffer.alloc(2);
  idBuf.writeUInt16LE(instrumentId, 0);
  return findPda([Buffer.from('book', 'utf8'), idBuf], programId);
}

function deriveOraclePda(programId: PublicKey): [PublicKey, number] {
  return findPda([Buffer.from('oracle', 'utf8')], programId);
}

function derivePortfolioPda(user: PublicKey, programId: PublicKey): [PublicKey, number] {
  return findPda([Buffer.from('portfolio', 'utf8'), user.toBuffer()], programId);
}

async function resolveInstrumentAccount(
  state: KeeperState,
  instrumentId: number,
  configuredAddress?: string,
): Promise<PublicKey | null> {
  const checkCandidate = async (candidate: PublicKey, source: string): Promise<PublicKey | null> => {
    const info = await state.connection.getAccountInfo(candidate);
    if (!info) return null;
    if (!info.owner.equals(state.corePid)) {
      console.log(
        `[keeper] Ignoring ${source} instrument ${candidate.toBase58()}: owner ${info.owner.toBase58()} != core`,
      );
      return null;
    }
    if (info.data.length < INSTRUMENT_SIZE) {
      console.log(
        `[keeper] Ignoring ${source} instrument ${candidate.toBase58()}: data ${info.data.length} < ${INSTRUMENT_SIZE}`,
      );
      return null;
    }
    const actualId = Buffer.from(info.data).readUInt16LE(0);
    if (actualId !== instrumentId) {
      console.log(
        `[keeper] Ignoring ${source} instrument ${candidate.toBase58()}: instrument_id ${actualId} != ${instrumentId}`,
      );
      return null;
    }
    return candidate;
  };

  if (configuredAddress) {
    const configured = await checkCandidate(new PublicKey(configuredAddress), 'configured');
    if (configured) return configured;
  }

  const derived = await checkCandidate(deriveInstrumentPda(instrumentId, state.corePid)[0], 'derived');
  if (derived) return derived;

  const idBuf = Buffer.alloc(2);
  idBuf.writeUInt16LE(instrumentId, 0);
  const accounts = await state.connection.getProgramAccounts(state.corePid, {
    filters: [
      { memcmp: { offset: 0, bytes: encodeBase58(idBuf) } },
      { dataSize: INSTRUMENT_SIZE },
    ],
    encoding: 'base64',
  });

  for (const { pubkey, account } of accounts) {
    const data = Buffer.from(account.data);
    if (data.length < INSTRUMENT_SIZE) continue;
    if (data.readUInt16LE(0) !== instrumentId) continue;
    state.instrumentAddress = pubkey.toBase58();
    console.log(`[keeper] Resolved live instrument #${instrumentId}: ${state.instrumentAddress}`);
    return pubkey;
  }

  console.log(`[keeper] Instrument #${instrumentId} not found; cannot crank batch lifecycle`);
  return null;
}

// ---------------------------------------------------------------------------
// Portfolio creation queue
// ---------------------------------------------------------------------------

/**
 * Request portfolio creation for a user.
 * Called by the REST API endpoint when a user tries to init portfolio but
 * the account doesn't exist yet.
 */
function requestPortfolioCreation(userPubkey: string): void {
  const queue = getPortfolioQueue();
  queue.add(userPubkey);
  console.log(`[portfolio-queue] Added ${userPubkey} (queue size: ${queue.size})`);
}

/**
 * Drain the portfolio creation queue — create portfolio accounts for all
 * queued users. Keeper signs for SystemProgram.createAccount (no invoke_signed).
 */
async function drainPortfolioQueue(state: KeeperState): Promise<void> {
  const queue = getPortfolioQueue();
  if (queue.size === 0) return;

  const { connection, corePid, keypair } = state;
  console.log(`[portfolio-queue] Draining ${queue.size} accounts`);

  const usersToProcess = [...queue];
  queue.clear();

  for (const userStr of usersToProcess) {
    const user = new PublicKey(userStr);

    // Check if we already have a portfolio for this user in DB
    const existingRow = state.store.getPortfolio.get(userStr) as { portfolio_pubkey: string } | undefined;
    if (existingRow) {
      console.log(`[portfolio-queue] ${userStr}: already in DB at ${existingRow.portfolio_pubkey}, skipping`);
      continue;
    }

    try {
      // InitPortfolioForUser (disc 19) creates the portfolio at the correct PDA
      // via invoke_signed + SystemProgram.createAccount CPI. The PDA address is
      // derived from [b"portfolio", user] — same as what the frontend derives.
      // Keeper provides the system program as an additional account for the CPI.
      const [expectedPda] = derivePortfolioPda(user, corePid);
      const initData = Buffer.from(encodeInitPortfolioForUser(user.toBuffer()));
      const initIxKeys = [
        { pubkey: keypair.publicKey, isWritable: true, isSigner: true },
        { pubkey: expectedPda, isWritable: true, isSigner: false },
        { pubkey: SystemProgram.programId, isWritable: false, isSigner: false },
      ];
      const initTx = new Transaction();
      initTx.add({ keys: initIxKeys, programId: corePid, data: initData });
      const initSig = await sendAndConfirmTransactionPolling(
        connection,
        initTx,
        [keypair],
        { commitment: 'confirmed' },
      );
      console.log(`[portfolio-queue] Portfolio initialized for ${userStr} at ${expectedPda.toBase58()}: ${initSig}`);

      // Store mapping in DB — front-end will look up by user pubkey via REST
      const slot = await connection.getSlot();
      (state.store.insertPortfolio.run as (...args: unknown[]) => unknown)(userStr, expectedPda.toBase58(), slot, initSig);
      console.log(`[portfolio-queue] Stored ${userStr} -> ${expectedPda.toBase58()}`);
    } catch (err) {
      console.error(`[portfolio-queue] Failed to create portfolio for ${userStr}:`, err);
      // Re-queue on failure so we retry next cycle
      queue.add(userStr);
    }
  }
}


// ---------------------------------------------------------------------------
// Batch keypair persistence (Solana 4.x: batches are keypairs, not PDAs)
// ---------------------------------------------------------------------------

function loadBatchKeypair(): Keypair | null {
  try {
    if (!existsSync(BATCH_KEYPAIR_PATH)) return null;
    const raw = JSON.parse(readFileSync(BATCH_KEYPAIR_PATH, 'utf8'));
    return Keypair.fromSecretKey(Buffer.from(raw));
  } catch {
    return null;
  }
}

function saveBatchKeypair(keypair: Keypair): void {
  try {
    writeFileSync(BATCH_KEYPAIR_PATH, JSON.stringify(Array.from(keypair.secretKey)));
    console.log(`[keeper] Batch keypair persisted to ${BATCH_KEYPAIR_PATH}`);
  } catch (err) {
    console.error(`[keeper] Failed to persist batch keypair:`, err);
  }
}

function loadOracleKeypair(): Keypair | null {
  try {
    if (!existsSync(ORACLE_KEYPAIR_PATH)) return null;
    const raw = JSON.parse(readFileSync(ORACLE_KEYPAIR_PATH, 'utf8'));
    return Keypair.fromSecretKey(Buffer.from(raw));
  } catch {
    return null;
  }
}

function saveOracleKeypair(keypair: Keypair): void {
  try {
    writeFileSync(ORACLE_KEYPAIR_PATH, JSON.stringify(Array.from(keypair.secretKey)));
    console.log(`[keeper] Oracle keypair persisted to ${ORACLE_KEYPAIR_PATH}`);
  } catch (err) {
    console.error(`[keeper] Failed to persist oracle keypair:`, err);
  }
}

type LiveBatchCandidate = {
  address: PublicKey;
  batch: ReturnType<typeof decodeBatch>;
  info: Awaited<ReturnType<Connection['getAccountInfo']>>;
};

/** Scan only when the persisted batch keypair is stale or unavailable. */
async function scanActiveBatchCandidates(
  connection: Connection,
  corePid: PublicKey,
): Promise<LiveBatchCandidate[]> {
  const accounts = await connection.getProgramAccounts(corePid, {
    filters: [{ dataSize: BATCH_SIZE }],
    encoding: 'base64',
  });

  return accounts.flatMap(({ pubkey, account }) => {
    try {
      const info = account as Awaited<ReturnType<Connection['getAccountInfo']>>;
      if (!info || !isOwnedAccountWithMinimumSize(info, corePid, BATCH_SIZE)) return [];
      return [{ address: pubkey, batch: decodeBatch(new Uint8Array(account.data)), info }];
    } catch {
      return [];
    }
  });
}

// ---------------------------------------------------------------------------

async function createTrackedBatch(
  state: KeeperState,
  registryPda: PublicKey,
  batchId: bigint,
  reason: string,
): Promise<PublicKey | null> {
  const batchKeypair = Keypair.generate();
  const batchPda = batchKeypair.publicKey;

  try {
    const batchLamports = await state.connection.getMinimumBalanceForRentExemption(BATCH_SIZE);
    const tx = new Transaction();
    tx.add(
      SystemProgram.createAccount({
        fromPubkey: state.keypair.publicKey,
        newAccountPubkey: batchPda,
        lamports: batchLamports,
        space: BATCH_SIZE,
        programId: state.corePid,
      }),
    );
    tx.add({
      keys: [
        { pubkey: batchPda, isWritable: true, isSigner: true },
        { pubkey: registryPda, isWritable: true, isSigner: false },
      ],
      programId: state.corePid,
      data: encodeCreateBatch(0),
    });

    const sig = await sendAndConfirmTransactionPolling(
      state.connection,
      tx,
      [state.keypair, batchKeypair],
      { commitment: 'confirmed' },
    );
    state.currentBatchKeypair = batchKeypair;
    saveBatchKeypair(batchKeypair);
    state.onCurrentBatchAddress?.(batchPda.toBase58());
    console.log(
      `[keeper] Batch #${batchId} created (${reason}): ${sig} (address: ${batchPda.toBase58()})`,
    );
    return batchPda;
  } catch (err) {
    console.error(`[keeper] Batch #${batchId} creation failed (${reason}):`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Batch status (matches SDK + Rust)
// ---------------------------------------------------------------------------

const BATCH_STATUS_COMMITTING = 0;
const BATCH_STATUS_REVEALING = 1;
const BATCH_STATUS_CLEARING = 2;
const BATCH_STATUS_SETTLED = 3;

// ---------------------------------------------------------------------------
// Commitment scanning
// ---------------------------------------------------------------------------

interface CommitmentAccount {
  pubkey: PublicKey;
  batchId: bigint;
  user: PublicKey;
  status: number; // 0=Pending, 1=Revealed, 2=Slashed, 3=Settled
}

/**
 * Find all commitment accounts for a given batch_id by scanning
 * program accounts with a memcmp filter on batch_id (offset 0, 8 bytes LE).
 * Commitment layout: batch_id(8) @0, user(32) @8, order_hash(32) @40,
 *   deposit(8) @72, status(1) @80, nonce(8) @88, revealed(72) @96.
 * instrument_id within revealed is at offset 152 (96 + 56).
 */
async function findCommitmentsForBatch(
  connection: Connection,
  programId: PublicKey,
  batchId: bigint,
): Promise<CommitmentAccount[]> {
  const batchIdBuf = Buffer.alloc(8);
  batchIdBuf.writeBigUInt64LE(batchId, 0);

  const accounts = await connection.getProgramAccounts(programId, {
    filters: [
      { memcmp: { offset: 0, bytes: encodeBase58(batchIdBuf) } },
      { dataSize: COMMITMENT_SIZE },
    ],
    encoding: 'base64',
  });

  const commitments: CommitmentAccount[] = [];
  for (const { pubkey, account } of accounts) {
    const data = Buffer.from(account.data);
    if (data.length < 81) continue;
    const bid = data.readBigUInt64LE(0);
    if (bid !== batchId) continue;
    const user = new PublicKey(data.subarray(8, 40));
    const status = data.readUInt8(80);
    commitments.push({ pubkey, batchId: bid, user, status });
  }
  return commitments;
}

// ---------------------------------------------------------------------------
// Oracle price fetching
// ---------------------------------------------------------------------------

interface OraclePrice {
  price: bigint;
  confidence: bigint;
}

async function fetchSolPrice(): Promise<OraclePrice | null> {
  try {
    const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT');
    if (!res.ok) return null;
    const json = await res.json() as { price: string };
    const price = BigInt(Math.round(parseFloat(json.price) * 1_000_000)); // 6 decimals
    return { price, confidence: 1_000_000n };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Keeper state
// ---------------------------------------------------------------------------

interface KeeperState {
  connection: Connection;
  corePid: PublicKey;
  matcherPid: PublicKey;
  oraclePid: PublicKey;
  keypair: Keypair;
  // Locally tracked current batch keypair (since Solana 4.x uses keypairs, not PDAs for batches)
  currentBatchKeypair: Keypair | null;
  // Oracle keypair (oracle account is keypair-controlled; PDA creation broken on Solana 4.x)
  oracleKeypair: Keypair;
  // Store for portfolio user->keypair mapping
  store: Store;
  // Optional env overrides passed from main.ts
  registryAddress?: string;
  vaultAddress?: string;
  batchAddress?: string;
  instrumentAddress?: string;
  bookAddress?: string;
  resultsAddress?: string;
  onCurrentBatchAddress?: (address: string) => void;
}

async function runKeeperCycle(state: KeeperState): Promise<void> {
  const {
    connection,
    corePid,
    matcherPid,
    keypair,
    registryAddress: registryAddr,
    vaultAddress: vaultAddr,
    batchAddress: batchAddr,
    instrumentAddress: instrumentAddr,
    bookAddress: bookAddr,
  } = state;

  // Solana 4.x: registry/vault are keypairs, not PDAs.
  const registryPda = registryAddr
    ? new PublicKey(registryAddr)
    : deriveRegistryPda(corePid)[0];
  const vaultPda = vaultAddr
    ? new PublicKey(vaultAddr)
    : deriveVaultPda(corePid)[0];
  const registryInfo = await connection.getAccountInfo(registryPda);
  if (!registryInfo) {
    console.log(`[keeper] Registry not found at ${registryPda.toBase58()} — run init-protocol.ts first`);
    return;
  }

  const rawData = registryInfo.data as Uint8Array;

  let registry;
  try {
    registry = decodeRegistry(rawData);
  } catch (e) {
    console.log(`[keeper] Failed to decode registry: ${e}`);
    return;
  }

  console.log(
    `[keeper] Registry: batch_id_counter=${registry.batchIdCounter}, instruments=${registry.instrumentCount}, n_min=${registry.nMin}`,
  );

  // Drain portfolio creation queue — pre-create accounts for users who requested init
  await drainPortfolioQueue(state);

  if (registry.batchIdCounter === 0n) {
    console.log('[keeper] No batch exists yet (batch_id_counter=0), creating first batch...');

    // Solana 4.x: batch must be a keypair (createAccount needs signer)
    const batchKeypair = Keypair.generate();
    const batchPda = batchKeypair.publicKey;

    try {
      const batchLamports = await connection.getMinimumBalanceForRentExemption(BATCH_SIZE);
      const tx = new Transaction();
      tx.add(
        SystemProgram.createAccount({
          fromPubkey: keypair.publicKey,
          newAccountPubkey: batchPda,
          lamports: batchLamports,
          space: BATCH_SIZE,
          programId: corePid,
        }),
      );
      tx.add({
        keys: [
          { pubkey: batchPda, isWritable: true, isSigner: true },
          { pubkey: registryPda, isWritable: true, isSigner: false },
        ],
        programId: corePid,
        data: encodeCreateBatch(0), // bump=0 for keypair-based batch
      });

      const sig = await sendAndConfirmTransactionPolling(
        connection,
        tx,
        [keypair, batchKeypair],
        { commitment: 'confirmed' },
      );
      console.log(`[keeper] CreateBatch success: ${sig} (batch: ${batchPda.toBase58()})`);
      // Track this batch keypair so subsequent cycles can find it
      state.currentBatchKeypair = batchKeypair;
      saveBatchKeypair(batchKeypair);
      state.onCurrentBatchAddress?.(batchPda.toBase58());
    } catch (err) {
      console.error(`[keeper] CreateBatch failed:`, err);
    }
    // Don't return — fall through to process the newly created batch
  }

  // batch_id_counter equals total batches created; current batch is batch_id_counter - 1
  const currentBatchId = registry.batchIdCounter - 1n;
  // Use tracked keypair if available (Solana 4.x keypair batches),
  // otherwise fall back to PDA derivation
  let batchPda: PublicKey;
  if (batchAddr) {
    batchPda = new PublicKey(batchAddr);
  } else if (state.currentBatchKeypair) {
    batchPda = state.currentBatchKeypair.publicKey;
  } else {
    [batchPda] = deriveBatchPda(currentBatchId, corePid);
  }
  let batchInfo = await connection.getAccountInfo(batchPda);
  let batch: ReturnType<typeof decodeBatch> | null = null;
  const trackedCandidate = isOwnedAccountWithMinimumSize(batchInfo, corePid, BATCH_SIZE)
    ? (() => {
        const decoded = decodeBatch(new Uint8Array(batchInfo!.data));
        return { address: batchPda.toBase58(), batchId: decoded.batchId };
      })()
    : null;

  if (trackedCandidate?.batchId === currentBatchId) {
    batch = decodeBatch(new Uint8Array(batchInfo!.data));
  } else {
    if (trackedCandidate) {
      console.log(
        `[keeper] Tracked batch address ${batchPda.toBase58()} contains batch #${trackedCandidate.batchId}, ` +
          `but registry active batch is #${currentBatchId}; scanning before creating.`,
      );
    }

    const discovered = await scanActiveBatchCandidates(connection, corePid);
    const selected = selectActiveBatchCandidate(
      currentBatchId,
      trackedCandidate,
      discovered.map(({ address, batch: discoveredBatch }) => ({
        address: address.toBase58(),
        batchId: discoveredBatch.batchId,
      })),
    );

    if (selected) {
      const live = discovered.find(({ address }) => address.toBase58() === selected.candidate.address);
      if (live) {
        batchPda = live.address;
        batchInfo = live.info;
        batch = live.batch;
        state.currentBatchKeypair = null;
        state.onCurrentBatchAddress?.(batchPda.toBase58());
        console.log(`[keeper] Using scanned active batch #${currentBatchId} at ${batchPda.toBase58()}`);
      }
    }

    if (!batch) {
      // No account for the registry's active ID exists. Create exactly the
      // counter value so the new account becomes the next active batch.
      const nextBatchId = registry.batchIdCounter;
      console.log(`[keeper] Batch #${currentBatchId} not found — creating batch #${nextBatchId}`);
      await createTrackedBatch(state, registryPda, nextBatchId, 'active batch account missing');
      return;
    }
  }

  if (!batchInfo || !batch) return;

  console.log(
    `[keeper] Batch #${currentBatchId}: status=${batch.status}, ` +
    `commitments=${batch.totalCommitments}, revealed=${batch.totalRevealed}, ` +
    `deadline_slot=${batch.commitDeadlineSlot}`,
  );

  const currentSlot = await connection.getSlot();

  // --- PHASE: Committing → CloseCollecting (DFBA: lands in Clearing) ---
  if (batch.status === BATCH_STATUS_COMMITTING) {
    const deadlineReached = currentSlot >= Number(batch.commitDeadlineSlot);
    const shouldClose = shouldCloseCommitting(
      BigInt(currentSlot),
      BigInt(batch.commitDeadlineSlot),
      BigInt(batch.totalCommitments),
      BigInt(registry.nMin),
    );

    if (shouldClose) {
      console.log(
        `[keeper] CloseCollecting (DFBA): slot ${currentSlot} >= ${batch.commitDeadlineSlot}, ` +
        `posts=${batch.totalCommitments} n_min=${registry.nMin}`,
      );
      try {
        const tx = new Transaction();
        tx.add({
          keys: [
            { pubkey: batchPda, isWritable: true, isSigner: false },
            { pubkey: registryPda, isWritable: false, isSigner: false },
          ],
          programId: corePid,
          data: encodeCloseCommitting(),
        });
        const sig = await sendAndConfirmTransactionPolling(connection, tx, [keypair], {
          commitment: 'confirmed',
        });
        console.log(`[keeper] CloseCommitting success: ${sig}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // "account data too small" = batch was created with wrong program ID (stale).
        // Create replacement batch and continue to process it in this cycle.
        if (msg.includes('account data too small')) {
          console.error(`[keeper] CloseCommitting failed: stale batch #${currentBatchId}. Creating replacement.`);
          const nextBatchId = registry.batchIdCounter; // = currentBatchId + 1 (counter never advanced)
          try {
            const nextBatchKeypair = Keypair.generate();
            const nextBatchPda = nextBatchKeypair.publicKey;
            const nextBatchLamports = await connection.getMinimumBalanceForRentExemption(BATCH_SIZE);
            const nextTx = new Transaction();
            nextTx.add(
              SystemProgram.createAccount({
                fromPubkey: keypair.publicKey,
                newAccountPubkey: nextBatchPda,
                lamports: nextBatchLamports,
                space: BATCH_SIZE,
                programId: corePid,
              }),
            );
            nextTx.add({
              keys: [
                { pubkey: nextBatchPda, isWritable: true, isSigner: true },
                { pubkey: registryPda, isWritable: true, isSigner: false },
              ],
              programId: corePid,
              data: encodeCreateBatch(0),
            });
            const sig = await sendAndConfirmTransactionPolling(
              connection,
              nextTx,
              [keypair, nextBatchKeypair],
              { commitment: 'confirmed' },
            );
            console.log(`[keeper] Replacement batch #${nextBatchId} created: ${sig}`);
            // Update state so subsequent cycles use the new batch
            state.currentBatchKeypair = nextBatchKeypair;
            saveBatchKeypair(nextBatchKeypair);
            state.onCurrentBatchAddress?.(nextBatchPda.toBase58());
            // Don't return — fall through to process the newly created batch below
            // by re-fetching batchInfo with the new keypair
            const newBatchInfo = await connection.getAccountInfo(nextBatchPda);
            if (newBatchInfo) {
              // Update local variables to process the new batch
              // eslint-disable-next-line @typescript-eslint/no-unused-vars
              const _newBatch = decodeBatch(new Uint8Array(newBatchInfo.data));
              // Use the new batch PDA for subsequent processing
              console.log(`[keeper] Processing replacement batch #${nextBatchId} in same cycle`);
              // Fall through to phase checks below with the new batch's data
            }
          } catch (createErr) {
            console.error(`[keeper] Replacement batch creation failed:`, createErr);
          }
        } else {
          console.error(`[keeper] CloseCommitting failed:`, err);
        }
      }
    } else {
      if (!deadlineReached)
        console.log(
          `[keeper] Waiting for commit deadline: slot ${currentSlot} < ${batch.commitDeadlineSlot}`,
        );
      if (deadlineReached)
        console.log('[keeper] Empty/underfilled batch remains open until the next keeper cycle');
    }
  }

  // --- PHASE: Clearing → DfbaClear (if no results yet) then Settle ---
  if (batch.status === BATCH_STATUS_CLEARING || batch.status === BATCH_STATUS_REVEALING) {
    if (!state.resultsAddress) {
      console.log(`[keeper] Calling ClearBatch (DFBA / book collect)...`);
      const instrumentId = 0;
      const bookPda = bookAddr
        ? new PublicKey(bookAddr)
        : deriveBookPda(instrumentId, matcherPid)[0];
      const instrumentPda = await resolveInstrumentAccount(state, instrumentId, instrumentAddr);
      if (!instrumentPda) return;
      const resultsKeypair = Keypair.generate();
      const resultsPda = resultsKeypair.publicKey;
      const clearIxData = encodeClearBatch(0, 1, 0);
      const clearIxKeys = [
        { pubkey: batchPda, isWritable: true, isSigner: false },
        { pubkey: bookPda, isWritable: true, isSigner: false },
        { pubkey: resultsPda, isWritable: true, isSigner: false },
        { pubkey: matcherPid, isWritable: false, isSigner: false },
        { pubkey: registryPda, isWritable: false, isSigner: false },
        { pubkey: instrumentPda, isWritable: false, isSigner: false },
      ];
      try {
        const dfbaResultsSize = Math.max(RESULTS_SIZE, 16 * 1024);
        const resultsLamports = await connection.getMinimumBalanceForRentExemption(dfbaResultsSize);
        const tx = new Transaction();
        tx.add(
          SystemProgram.createAccount({
            fromPubkey: keypair.publicKey,
            newAccountPubkey: resultsPda,
            lamports: resultsLamports,
            space: dfbaResultsSize,
            programId: matcherPid,
          }),
        );
        tx.add({ keys: clearIxKeys, programId: corePid, data: clearIxData });
        const sig = await sendAndConfirmTransactionPolling(connection, tx, [keypair, resultsKeypair], {
          commitment: 'confirmed',
        });
        state.resultsAddress = resultsPda.toBase58();
        console.log(`[keeper] ClearBatch (DFBA) success: ${sig}`);
        return;
      } catch (err) {
        console.error(`[keeper] ClearBatch (DFBA) failed:`, err);
        return;
      }
    }

    // resultsAddress set → settle (DFBA allows zero commitments).
    console.log(
      `[keeper] SettleBatch (DFBA): markValid=${batch.markValid} liqPaused=${batch.liqPaused}`,
    );

    const commitments = await findCommitmentsForBatch(connection, corePid, currentBatchId);
    const active = commitments.filter(c => c.status === 1 || c.status === 2);

    const userSet = new Set<string>();
    const portfolioMap = new Map<string, PublicKey>();
    const commitmentPubkeys: PublicKey[] = [];

    for (const c of active) {
      commitmentPubkeys.push(c.pubkey);
      const userStr = c.user.toBase58();
      if (!userSet.has(userStr)) {
        userSet.add(userStr);
        const [pda] = derivePortfolioPda(c.user, corePid);
        portfolioMap.set(userStr, pda);
      }
    }

    // DFBA allows zero commitments (orders rest on book).
    const instrumentPda = await resolveInstrumentAccount(state, 0, state.instrumentAddress);
    if (!instrumentPda) return;
    const bookPda = state.bookAddress
      ? new PublicKey(state.bookAddress)
      : deriveBookPda(0, matcherPid)[0];
    const oraclePda = state.oracleKeypair.publicKey;
    const nextBatchId = currentBatchId + 1n;
    // Solana 4.x: use keypair for next batch (PDA createAccount broken)
    const nextBatchKeypair = Keypair.generate();
    const nextBatchPda = nextBatchKeypair.publicKey;
    if (!state.resultsAddress) {
      console.log('[keeper] SettleBatch waiting for ClearBatch results account');
      return;
    }
    const resultsPda = new PublicKey(state.resultsAddress);

    // Accounts order (matches entrypoint): batch, registry, vault, results,
    //   instrument, book, oracle, matcher, commitments..., portfolios..., nextBatch
    const settleIxData = encodeSettleBatch(active.length, userSet.size);
    const settleIxKeys = [
      { pubkey: batchPda, isWritable: true, isSigner: false },
      { pubkey: registryPda, isWritable: true, isSigner: false },
      { pubkey: vaultPda, isWritable: true, isSigner: false },
      { pubkey: resultsPda, isWritable: true, isSigner: false },
      { pubkey: instrumentPda, isWritable: true, isSigner: false },
      { pubkey: bookPda, isWritable: false, isSigner: false },
      { pubkey: oraclePda, isWritable: false, isSigner: false },
      { pubkey: matcherPid, isWritable: false, isSigner: false },
      ...commitmentPubkeys.map(pk => ({ pubkey: pk, isWritable: true, isSigner: false })),
      ...[...userSet].map(u => ({ pubkey: portfolioMap.get(u)!, isWritable: true, isSigner: false })),
      { pubkey: nextBatchPda, isWritable: true, isSigner: true },
    ];

    try {
      const resultsLamports = await connection.getMinimumBalanceForRentExemption(RESULTS_SIZE);
      const nextBatchLamports = await connection.getMinimumBalanceForRentExemption(BATCH_SIZE);
      const tx = new Transaction();
      const resultsInfo = await connection.getAccountInfo(resultsPda);
      if (!resultsInfo) {
        console.log(`[keeper] SettleBatch results account missing: ${resultsPda.toBase58()}`);
        state.resultsAddress = undefined;
        return;
      }
      if (resultsInfo.lamports < resultsLamports) {
        console.log(`[keeper] SettleBatch results account is not rent exempt: ${resultsPda.toBase58()}`);
        return;
      }
      tx.add(
        SystemProgram.createAccount({
          fromPubkey: keypair.publicKey,
          newAccountPubkey: nextBatchPda,
          lamports: nextBatchLamports,
          space: BATCH_SIZE,
          programId: corePid,
        }),
      );
      tx.add({ keys: settleIxKeys, programId: corePid, data: settleIxData });

      const sig = await sendAndConfirmTransactionPolling(connection, tx, [keypair, nextBatchKeypair], {
        commitment: 'confirmed',
      });
      console.log(`[keeper] SettleBatch success: ${sig}`);
      // Track the new batch keypair for subsequent cycle processing
      state.currentBatchKeypair = nextBatchKeypair;
      saveBatchKeypair(nextBatchKeypair);
      state.onCurrentBatchAddress?.(nextBatchPda.toBase58());
      state.resultsAddress = undefined;
    } catch (err) {
      console.error(`[keeper] SettleBatch failed:`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Oracle initialization (one-time; oracle account is keypair-controlled)
// ---------------------------------------------------------------------------

async function ensureOracleInitialized(state: KeeperState): Promise<void> {
  const { connection, oraclePid, oracleKeypair, keypair } = state;
  const oraclePda = oracleKeypair.publicKey;

  const oracleInfo = await connection.getAccountInfo(oraclePda);
  if (isOwnedAccountWithMinimumSize(oracleInfo, oraclePid, ORACLE_SIZE)) {
    console.log(`[oracle] Already initialized: ${oraclePda.toBase58()}`);
    return;
  }

  if (oracleInfo !== null) {
    console.log(
      `[oracle] Replacing stale account ${oraclePda.toBase58()}: ` +
        `owner=${oracleInfo.owner.toBase58()} size=${oracleInfo.data.length}; ` +
        `expected owner=${oraclePid.toBase58()} size>=${ORACLE_SIZE}`,
    );
    state.oracleKeypair = Keypair.generate();
  }

  console.log(`[oracle] Creating oracle account...`);

  const activeOracleKeypair = state.oracleKeypair;
  const activeOraclePda = activeOracleKeypair.publicKey;

  // Derive instrument PDA to use as the instrument field
  const [instrumentPda] = deriveInstrumentPda(0, oraclePid);

  // Oracle Initialize: disc(0) + price(i64) + bump(u8) = 9 bytes
  // bump doesn't matter for keypair (any valid u8 works)
  const initData = Buffer.alloc(9);
  initData.writeBigInt64LE(0n, 0); // initial price 0 (will be updated immediately)
  initData.writeUInt8(255, 8);     // bump (ignored for keypair-owned)

  const initIxKeys = [
    { pubkey: activeOraclePda, isWritable: true, isSigner: true },     // oracle account (keypair signs createAccount)
    { pubkey: keypair.publicKey, isWritable: true, isSigner: true }, // authority (governance)
    { pubkey: instrumentPda, isWritable: false, isSigner: false },   // instrument (only .key() used)
  ];

  try {
    const rentExempt = await connection.getMinimumBalanceForRentExemption(ORACLE_SIZE);
    const tx = new Transaction();
    tx.add(
      SystemProgram.createAccount({
        fromPubkey: keypair.publicKey,
        newAccountPubkey: activeOraclePda,
        lamports: rentExempt,
        space: ORACLE_SIZE,
        programId: oraclePid,
      }),
    );
    tx.add({ keys: initIxKeys, programId: oraclePid, data: Buffer.concat([Buffer.from([0]), initData]) });

    const sig = await sendAndConfirmTransactionPolling(connection, tx, [keypair, activeOracleKeypair], {
      commitment: 'confirmed',
    });
    console.log(`[oracle] Initialized: ${sig} (oracle: ${activeOraclePda.toBase58()})`);
    saveOracleKeypair(activeOracleKeypair);
  } catch (err) {
    console.error(`[oracle] Initialization failed:`, err);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Oracle posting
// ---------------------------------------------------------------------------

async function runOracleCycle(state: KeeperState): Promise<void> {
  const { connection, oraclePid, oracleKeypair, keypair } = state;
  const oraclePda = oracleKeypair.publicKey;
  const price = await fetchSolPrice();
  if (!price) {
    console.log('[oracle] Failed to fetch SOL price');
    return;
  }

  console.log(`[oracle] Posting SOL price: ${price.price}`);
  // UpdatePrice: disc(1) + price(i64) + confidence(i64) = 17 bytes
  const data = Buffer.alloc(17);
  data.writeUInt8(1, 0); // discriminator 1 = UpdatePrice
  data.writeBigInt64LE(price.price, 1);
  data.writeBigInt64LE(price.confidence, 9);

  try {
    const tx = new Transaction();
    tx.add({
      keys: [
        { pubkey: oraclePda, isWritable: true, isSigner: false },
        { pubkey: keypair.publicKey, isWritable: true, isSigner: true },
      ],
      programId: oraclePid,
      data,
    });
    const sig = await sendAndConfirmTransactionPolling(connection, tx, [keypair], {
      commitment: 'confirmed',
    });
    console.log(`[oracle] SetPrice success: ${sig}`);
  } catch (err) {
    console.error(`[oracle] SetPrice failed:`, err);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export interface StartKeeperParams {
  connection: Connection;
  corePid: PublicKey;
  matcherPid: PublicKey;
  oraclePid: PublicKey;
  registryAddress?: string;
  vaultAddress?: string;
  batchAddress?: string;
  instrumentAddress?: string;
  bookAddress?: string;
  resultsAddress?: string;
  store: Store;
  pollIntervalMs?: number;
  oraclePollMs?: number;
  onCurrentBatchAddress?: (address: string) => void;
}

export function startKeeper(params: StartKeeperParams): void {
  const {
    connection,
    corePid,
    matcherPid,
    oraclePid,
    registryAddress,
    vaultAddress,
    batchAddress,
    instrumentAddress,
    bookAddress,
    resultsAddress,
    store,
    pollIntervalMs = 2_000,
    oraclePollMs = 10_000,
    onCurrentBatchAddress,
  } = params;

  const HOME_DIR = process.env.HOME ?? '/root';

  let keypair: Keypair;
  if (process.env.KEEPER_KEYPAIR) {
    try {
      const raw = JSON.parse(process.env.KEEPER_KEYPAIR);
      keypair = Keypair.fromSecretKey(Uint8Array.from(raw));
      console.log(`Keeper (from env): ${keypair.publicKey.toBase58()}`);
    } catch {
      console.error('ERROR: KEEPER_KEYPAIR env var is not valid JSON array of bytes');
      return;
    }
  } else {
    const keypairPath = join(HOME_DIR, '.config', 'solana', 'id.json');
    try {
      const raw = JSON.parse(readFileSync(keypairPath, 'utf8'));
      keypair = Keypair.fromSecretKey(Buffer.from(raw));
      console.log(`Keeper (from file): ${keypair.publicKey.toBase58()}`);
    } catch {
      console.error(`ERROR: Could not load keypair from ${keypairPath} and KEEPER_KEYPAIR not set`);
      return;
    }
  }

  // Load persisted batch keypair (survives keeper restarts)
  const batchKeypairPath = join(HOME_DIR, '.config', 'solana', 'mgk-batch-keypair.json');
  const persistedBatchKeypair = loadBatchKeypair();
  if (persistedBatchKeypair) {
    console.log(`Loaded persisted batch keypair: ${persistedBatchKeypair.publicKey.toBase58()}`);
    onCurrentBatchAddress?.(persistedBatchKeypair.publicKey.toBase58());
  } else if (batchAddress) {
    onCurrentBatchAddress?.(batchAddress);
  }

  // Load or create oracle keypair
  const oracleKeypairPath = join(HOME_DIR, '.config', 'solana', 'mgk-oracle-keypair.json');
  let oracleKeypair = loadOracleKeypair();
  if (!oracleKeypair) {
    oracleKeypair = Keypair.generate();
    console.log(`Generated new oracle keypair: ${oracleKeypair.publicKey.toBase58()}`);
  } else {
    console.log(`Loaded persisted oracle keypair: ${oracleKeypair.publicKey.toBase58()}`);
  }

  console.log(`Core program:     ${corePid}`);
  console.log(`Matcher program:  ${matcherPid}`);
  console.log(`Oracle program:   ${oraclePid}`);
  console.log(`Poll interval:    ${pollIntervalMs}ms`);
  console.log(`Oracle interval:  ${oraclePollMs}ms\n`);

  const keeperState: KeeperState = {
    connection,
    corePid,
    matcherPid,
    oraclePid,
    keypair,
    currentBatchKeypair: persistedBatchKeypair,
    oracleKeypair,
    store,
    // Store env overrides for the cycle
    registryAddress,
    vaultAddress,
    batchAddress,
    instrumentAddress,
    bookAddress,
    resultsAddress,
    onCurrentBatchAddress,
  };

  // One-time: ensure oracle account is initialized before posting prices
  ensureOracleInitialized(keeperState).catch((err) => {
    console.error('[keeper] Oracle init error:', err);
  });

  // Run initial cycles
  runKeeperCycle(keeperState)
    .catch((err) => console.error('[keeper] Initial cycle error:', err))
    .finally(() => drainPortfolioQueue(keeperState))
    .then(() => runOracleCycle(keeperState))
    .catch((err) => console.error('[oracle] Initial cycle error:', err));

  // Periodic keeper cycle
  setInterval(async () => {
    try {
      await runKeeperCycle(keeperState);
    } catch (err) {
      console.error('[keeper] Cycle error:', err);
    }
    // Portfolio queue drain runs regardless — keeper cycle failure shouldn't block it
    await drainPortfolioQueue(keeperState);
  }, pollIntervalMs);

  // Periodic oracle posting
  setInterval(async () => {
    try {
      await runOracleCycle(keeperState);
    } catch (err) {
      console.error('[oracle] Cycle error:', err);
    }
  }, oraclePollMs);
}
