#!/usr/bin/env node
/**
 * mgk Keeper Crank -- CloseCollecting -> ClearBatch -> SettleBatch loop.
 *
 * Usage:
 *   node keeper-crank.js                    # one-shot crank
 *   node keeper-crank.js --close-only       # CloseCollecting, then stop (leave Clearing)
 *   node keeper-crank.js --skip-close       # ClearBatch + SettleBatch on an already-Clearing batch
 *   node keeper-crank.js --loop             # continuous polling
 *   node keeper-crank.js --loop --interval 5000  # poll every 5s (default 2s)
 *
 * Env vars:
 *   RPC_URL              -- Solana RPC endpoint (default: https://api.devnet.solana.com)
 *   KEEPER_KEYPAIR       -- path to keeper keypair JSON (default: ~/.config/solana/id.json)
 *   CURRENT_BATCH_PDA    -- override batch PDA (default: auto-derive from registry)
 *   BOOK_ADDRESS / BOOK_KEYPAIR -- matcher-owned book account
 *   PORTFOLIO_ADDRESSES  -- comma-separated portfolio PDAs to pass into SettleBatch
 *                          (required for fill application; omit for empty books)
 */
const {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, ComputeBudgetProgram,
} = require('@solana/web3.js');
const { readFileSync } = require('fs');
const { homedir } = require('os');
const { join } = require('path');
const { loadEnvLocal } = require('./inject-persona');

const CORE_ID = new PublicKey('C7w2mKz2KQgDroNNhACm9MutXhPiesVr9Gn2x8TDsRYx');
const MATCHER_ID = new PublicKey('7WiZuunbPGciCedsVTguvjezwwzrhmXG5HkdCuHizbNC');
const BATCH_STATUS_COLLECTING = 0;
const BATCH_STATUS_CLEARING = 2;
const BATCH_STATUS_SETTLED = 3;
const RESULTS_SIZE = 34 + 128 * 58;
const BOOK_ACCOUNT_SIZE = 27_704;
const CLEAR_CU_LIMIT = 1_400_000;

function loadKP(p) { return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p,'utf-8')))); }
function pda(seeds, prog) { return PublicKey.findProgramAddressSync(seeds, prog); }
function le16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v,0); return b; }
function le64(v) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v),0); return b; }

function decodeBatch(data) {
  return {
    batchId: Number(data.readBigUInt64LE(0)),
    status: data[8],
    commitDeadlineSlot: Number(data.readBigUInt64LE(16)),
    markValid: data[152],
    liqPaused: data[153],
  };
}

function decodeRegistry(data) {
  return { batchIdCounter: Number(data.readBigUInt64LE(36)) };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function sendRawWithRetry(conn, raw, label) {
  let lastErr;
  for (let i = 0; i < 6; i++) {
    try {
      const sig = await conn.sendRawTransaction(raw, { skipPreflight: false });
      await conn.confirmTransaction(sig, 'confirmed');
      console.log('  [' + label + '] TX: ' + sig);
      return sig;
    } catch (e) {
      lastErr = e;
      const msg = e && e.message ? e.message : String(e);
      if (msg.includes('429') && i < 5) {
        const wait = 1500 * Math.pow(2, i);
        console.log('  [' + label + '] 429, retry in ' + wait + 'ms');
        await sleep(wait);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

async function sendTx(conn, ix, signers, label) {
  const tx = new Transaction().add(ix);
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);
  return sendRawWithRetry(conn, tx.serialize(), label);
}

function buildCloseCollectingIx(batchPda, registryPda) {
  return new TransactionInstruction({
    keys: [
      { pubkey: batchPda, isSigner: false, isWritable: true },
      { pubkey: registryPda, isSigner: false, isWritable: false },
    ],
    programId: CORE_ID,
    data: Buffer.from([6]),
  });
}

function buildClearBatchIx(batchPda, bookPda, resultsPda, matcherId, registryPda, instrumentPda) {
  const data = Buffer.alloc(7);
  data[0] = 7;
  data.writeUInt16LE(0, 1);
  data.writeUInt16LE(1, 3);
  data.writeUInt16LE(0, 5);
  return new TransactionInstruction({
    keys: [
      { pubkey: batchPda, isSigner: false, isWritable: true },
      { pubkey: bookPda, isSigner: false, isWritable: true },
      { pubkey: resultsPda, isSigner: false, isWritable: true },
      { pubkey: matcherId, isSigner: false, isWritable: false },
      { pubkey: registryPda, isSigner: false, isWritable: false },
      { pubkey: instrumentPda, isSigner: false, isWritable: false },
    ],
    programId: CORE_ID,
    data,
  });
}

function buildSettleBatchIx(batchPda, registryPda, vaultPda, resultsPda, instrumentPda, bookPda, oraclePda, matcherId, nextBatchPda, payer, nextBatchBump, portfolioPdas) {
  const portfolios = portfolioPdas || [];
  // disc(1) + num_commitments(2) + num_portfolios(2) + next_batch_bump(1)
  const data = Buffer.alloc(6);
  data[0] = 8;
  data.writeUInt16LE(0, 1);
  data.writeUInt16LE(portfolios.length, 3);
  data[5] = nextBatchBump;
  const keys = [
    { pubkey: batchPda, isSigner: false, isWritable: true },
    { pubkey: registryPda, isSigner: false, isWritable: true },
    { pubkey: vaultPda, isSigner: false, isWritable: true },
    { pubkey: resultsPda, isSigner: false, isWritable: false },
    { pubkey: instrumentPda, isSigner: false, isWritable: true },
    { pubkey: bookPda, isSigner: false, isWritable: false },
    { pubkey: oraclePda, isSigner: false, isWritable: false },
    { pubkey: matcherId, isSigner: false, isWritable: false },
  ];
  // commitments: none for DFBA; portfolios next
  for (const p of portfolios) {
    keys.push({ pubkey: p, isSigner: false, isWritable: true });
  }
  keys.push(
    { pubkey: nextBatchPda, isSigner: false, isWritable: true },
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  );
  return new TransactionInstruction({ keys, programId: CORE_ID, data });
}

async function main() {
  loadEnvLocal();
  const loop = process.argv.includes('--loop');
  const closeOnly = process.argv.includes('--close-only');
  const skipClose = process.argv.includes('--skip-close');
  const intervalIdx = process.argv.indexOf('--interval');
  const interval = intervalIdx >= 0 ? parseInt(process.argv[intervalIdx + 1]) : 2000;
  if (closeOnly && skipClose) {
    console.error('Use only one of --close-only or --skip-close.');
    process.exit(1);
  }

  const rpc = process.env.RPC_URL || process.env.NEXT_PUBLIC_RPC_URL || 'https://api.devnet.solana.com';
  const kp = process.env.KEEPER_KEYPAIR || process.env.DEPLOYER_KEYPAIR || join(homedir(), '.config/solana/id.json');
  const conn = new Connection(rpc, 'confirmed');
  const keeper = loadKP(kp);
  let rpcHost = 'invalid-rpc';
  try { rpcHost = new URL(rpc).host; } catch { /* keep invalid-rpc */ }
  console.log('=== mgk Keeper Crank ===');
  console.log('RPC host:', rpcHost);
  console.log('Keeper:', keeper.publicKey.toBase58());
  console.log('Balance:', (await conn.getBalance(keeper.publicKey)) / 1e9, 'SOL');

  const [regPDA] = pda([Buffer.from('registry')], CORE_ID);
  const [instPDA] = pda([Buffer.from('instrument'), le16(0)], CORE_ID);
  const [vaultPDA] = pda([Buffer.from('vault')], CORE_ID);
  const [bookPdaFallback] = pda([Buffer.from('book'), le16(0)], MATCHER_ID);

  // Book: BOOK_ADDRESS env > keypair file > PDA fallback
  function resolveBook() {
    const bookEnv = process.env.BOOK_ADDRESS || process.env.NEXT_PUBLIC_BOOK_ADDRESS;
    if (bookEnv) {
      return new PublicKey(bookEnv);
    }
    const bookKeyPath = process.env.BOOK_KEYPAIR
      || join(homedir(), '.config/solana/mgk-book-keypair.json');
    try {
      const kp = loadKP(bookKeyPath);
      console.log('Book keypair:', kp.publicKey.toBase58(), '(' + bookKeyPath + ')');
      return kp.publicKey;
    } catch {
      console.log('Book PDA fallback:', bookPdaFallback.toBase58());
      return bookPdaFallback;
    }
  }
  const bookPDA = resolveBook();

  const regInfo = await conn.getAccountInfo(regPDA);
  if (!regInfo) { console.error('Registry not found. Run init-protocol.js first.'); process.exit(1); }
  const vaultInfo = await conn.getAccountInfo(vaultPDA);
  if (!vaultInfo) {
    console.error('Vault not found at', vaultPDA.toBase58(), '— run init-protocol.js first.');
    process.exit(1);
  }
  // Instrument account stores oracle at offset 60 (#[repr(C)] Instrument).
  const instInfo = await conn.getAccountInfo(instPDA);
  if (!instInfo || instInfo.data.length < 92) {
    console.error('Instrument not found. Run init-protocol.js first.');
    process.exit(1);
  }
  const oraclePda = new PublicKey(instInfo.data.slice(60, 92));

  // Ensure book is matcher-owned and large enough.
  async function ensureBook() {
    const info = await conn.getAccountInfo(bookPDA);
    if (info && info.data.length >= BOOK_ACCOUNT_SIZE && info.owner.equals(MATCHER_ID)) {
      return;
    }
    console.error('  Book not ready at', bookPDA.toBase58(),
      info
        ? '(owner=' + info.owner.toBase58() + ' len=' + info.data.length + ')'
        : '(missing)');
    console.error('  Re-run: node init-protocol.js  (creates a matcher-owned book keypair)');
    process.exit(1);
  }

  async function resolveOpenBatch() {
    if (process.env.CURRENT_BATCH_PDA) {
      const batchPda = new PublicKey(process.env.CURRENT_BATCH_PDA);
      const info = await conn.getAccountInfo(batchPda);
      if (!info) return null;
      return { batchPda, batch: decodeBatch(Buffer.from(info.data)) };
    }
    // Prefer the highest open (non-settled) batch. Counter can lag on older
    // deploys that had the SBF field-write bug; scan recent ids as fallback.
    const freshReg = await conn.getAccountInfo(regPDA);
    const counter = decodeRegistry(Buffer.from(freshReg.data)).batchIdCounter;
    const candidates = [];
    for (let id = Math.max(0, counter - 1); id <= counter + 2; id++) {
      candidates.push(id);
    }
    // Also try a small look-ahead / look-back window
    for (let id = 0; id < Math.max(counter + 3, 4); id++) {
      if (!candidates.includes(id)) candidates.push(id);
    }
    let best = null;
    for (const id of candidates) {
      const batchPda = pda([Buffer.from('batch'), le64(id)], CORE_ID)[0];
      const info = await conn.getAccountInfo(batchPda);
      if (!info || info.data.length < 160) continue;
      const batch = decodeBatch(Buffer.from(info.data));
      if (batch.status === BATCH_STATUS_SETTLED) continue;
      if (!best || batch.batchId > best.batch.batchId) {
        best = { batchPda, batch };
      }
    }
    return best;
  }

  async function crankOnce() {
    const open = await resolveOpenBatch();
    if (!open) {
      console.log('No open (non-settled) batch found.');
      return;
    }
    const { batchPda, batch } = open;
    console.log('\nBatch ' + batch.batchId + ': status=' + batch.status
      + ' markValid=' + batch.markValid + ' deadline=' + batch.commitDeadlineSlot
      + ' @ ' + batchPda.toBase58());

    if (batch.status === BATCH_STATUS_SETTLED) { console.log('  Already settled.'); return; }

    await ensureBook();

    if (batch.status === BATCH_STATUS_COLLECTING) {
      if (skipClose) {
        console.error('  Batch is still Collecting; --skip-close needs Clearing.');
        return;
      }
      console.log('  [1/3] CloseCollecting...');
      await sendTx(conn, buildCloseCollectingIx(batchPda, regPDA), [keeper], 'Close');
      if (closeOnly) {
        console.log('  --close-only: leaving batch in Clearing for UI observation.');
        return;
      }
    } else if (batch.status === BATCH_STATUS_CLEARING) {
      if (closeOnly) {
        console.log('  Already Clearing — --close-only is a no-op.');
        return;
      }
      console.log('  [1/3] Already Clearing — skip Close.');
    }

    // ClearBatch — create results keypair + CU budget for DFBA CPI
    const resultsKP = Keypair.generate();
    const resultsLamports = await conn.getMinimumBalanceForRentExemption(RESULTS_SIZE);
    console.log('  [2/3] ClearBatch (DFBA)...');
    console.log('  Results account:', resultsKP.publicKey.toBase58());
    const clearTx = new Transaction();
    clearTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: CLEAR_CU_LIMIT }));
    clearTx.add(SystemProgram.createAccount({
      fromPubkey: keeper.publicKey, newAccountPubkey: resultsKP.publicKey,
      lamports: resultsLamports, space: RESULTS_SIZE, programId: MATCHER_ID,
    }));
    clearTx.add(buildClearBatchIx(batchPda, bookPDA, resultsKP.publicKey, MATCHER_ID, regPDA, instPDA));
    clearTx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    clearTx.feePayer = keeper.publicKey;
    clearTx.sign(keeper, resultsKP);
    await sendRawWithRetry(conn, clearTx.serialize(), 'ClearBatch');

    // SettleBatch — creates next batch PDA via invoke_signed when missing
    const nextBatchId = batch.batchId + 1;
    const [nextBatchPda, nextBatchBump] = pda([Buffer.from('batch'), le64(nextBatchId)], CORE_ID);
    const portfolios = (process.env.PORTFOLIO_ADDRESSES || '')
      .split(',').map((s) => s.trim()).filter(Boolean).map((s) => new PublicKey(s));
    if (portfolios.length) {
      console.log('  Settle with', portfolios.length, 'portfolio account(s)');
    }
    console.log('  [3/3] SettleBatch (next batch ' + nextBatchId + ' @ ' + nextBatchPda.toBase58() + ')...');
    await sendTx(conn,
      buildSettleBatchIx(
        batchPda, regPDA, vaultPDA, resultsKP.publicKey, instPDA, bookPDA,
        oraclePda, MATCHER_ID, nextBatchPda, keeper.publicKey, nextBatchBump,
        portfolios,
      ),
      [keeper], 'Settle');

    const newBatchInfo = await conn.getAccountInfo(nextBatchPda);
    if (newBatchInfo) {
      const nb = decodeBatch(Buffer.from(newBatchInfo.data));
      console.log('  Next batch ' + nb.batchId + ': status=' + nb.status + ' deadline=' + nb.commitDeadlineSlot);
    }
    console.log('  Crank cycle complete.');
  }

  if (loop) {
    console.log('\nPolling every ' + interval + 'ms...');
    while (true) {
      try { await crankOnce(); } catch (e) { console.error('  Error:', e.message); }
      await new Promise(r => setTimeout(r, interval));
    }
  } else {
    await crankOnce();
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
