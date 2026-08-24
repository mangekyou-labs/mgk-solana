#!/usr/bin/env node
/**
 * mgk DFBA dual-fill e2e on devnet.
 *
 * Flow:
 *   1. Fund maker + taker wallets
 *   2. InitPortfolioForUser (disc 19) for each
 *   3. Deposit SOL collateral
 *   4. PostOrder dual sides (bid + ask auctions) → mark_valid path
 *   5. Keeper crank Close → Clear → Settle (with portfolio accounts)
 *   6. Assert mark_valid=1 on settled batch
 *
 * Usage:
 *   node trade-e2e.js
 *
 * Env:
 *   RPC_URL, DEPLOYER_KEYPAIR, BOOK_ADDRESS / BOOK_KEYPAIR
 */
const {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, ComputeBudgetProgram, LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const { readFileSync, writeFileSync, mkdirSync, existsSync } = require('fs');
const { homedir } = require('os');
const { join } = require('path');

const CORE_ID = new PublicKey('C7w2mKz2KQgDroNNhACm9MutXhPiesVr9Gn2x8TDsRYx');
const MATCHER_ID = new PublicKey('7WiZuunbPGciCedsVTguvjezwwzrhmXG5HkdCuHizbNC');
const PORTFOLIO_SIZE = 1456; // BPF layout
const RESULTS_SIZE = 34 + 128 * 58;
const BOOK_ACCOUNT_SIZE = 27_704;
const CLEAR_CU_LIMIT = 1_400_000;
const SIDE_BUY = 0;
const SIDE_SELL = 1;
const PRICE = 100_000n; // i64 price units
const QTY = BigInt(process.env.TRADE_QTY || '10');

function loadKP(p) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, 'utf-8'))));
}
function saveKP(p, kp) {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, JSON.stringify(Array.from(kp.secretKey)));
}
function pda(seeds, prog) { return PublicKey.findProgramAddressSync(seeds, prog); }
function le16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v, 0); return b; }
function le64(v) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v), 0); return b; }
function lei64(v) { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v), 0); return b; }

async function send(conn, ixs, signers, label) {
  const tx = new Transaction();
  for (const ix of ixs) tx.add(ix);
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);
  try {
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await conn.confirmTransaction(sig, 'confirmed');
    console.log('  [' + label + '] ' + sig);
    return sig;
  } catch (e) {
    if (e.logs) console.error('  logs:', e.logs);
    else if (e.transactionLogs) console.error('  logs:', e.transactionLogs);
    throw e;
  }
}

function resolveBook() {
  if (process.env.BOOK_ADDRESS) return new PublicKey(process.env.BOOK_ADDRESS);
  const p = process.env.BOOK_KEYPAIR || join(homedir(), '.config/solana/mgk-book-keypair.json');
  return loadKP(p).publicKey;
}

function loadOrCreateTrader(name) {
  const path = join(homedir(), '.config/solana', 'mgk-trader-' + name + '.json');
  if (existsSync(path)) return loadKP(path);
  const kp = Keypair.generate();
  saveKP(path, kp);
  console.log('  Generated', name, '→', path, kp.publicKey.toBase58());
  return kp;
}

async function ensureFunded(conn, funder, user, minLamports) {
  const bal = await conn.getBalance(user.publicKey);
  if (bal >= minLamports) return;
  const need = minLamports - bal;
  console.log('  Funding', user.publicKey.toBase58().slice(0, 8), 'with', need / LAMPORTS_PER_SOL, 'SOL');
  await send(conn, [SystemProgram.transfer({
    fromPubkey: funder.publicKey,
    toPubkey: user.publicKey,
    lamports: need,
  })], [funder], 'Fund');
}

async function ensurePortfolio(conn, keeper, user) {
  const [portPda] = pda([Buffer.from('portfolio'), user.publicKey.toBuffer()], CORE_ID);
  const info = await conn.getAccountInfo(portPda);
  if (info && info.data.length >= PORTFOLIO_SIZE && info.owner.equals(CORE_ID)) {
    // Check user field matches
    const owner = new PublicKey(info.data.slice(0, 32));
    if (owner.equals(user.publicKey)) {
      console.log('  Portfolio OK', portPda.toBase58().slice(0, 8) + '…');
      return portPda;
    }
  }
  console.log('  InitPortfolioForUser', user.publicKey.toBase58().slice(0, 8) + '…');
  const data = Buffer.alloc(33);
  data[0] = 19; // disc
  user.publicKey.toBuffer().copy(data, 1);
  // System program must be present for CreateAccount CPI (even if unused by validation).
  await send(conn, [new TransactionInstruction({
    keys: [
      { pubkey: keeper.publicKey, isSigner: true, isWritable: true },
      { pubkey: portPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: CORE_ID,
    data,
  })], [keeper], 'InitPortfolio');
  return portPda;
}

async function deposit(conn, user, portPda, vaultPda, amount) {
  const data = Buffer.alloc(9);
  data[0] = 2; // Deposit
  le64(amount).copy(data, 1);
  await send(conn, [new TransactionInstruction({
    keys: [
      { pubkey: portPda, isSigner: false, isWritable: true },
      { pubkey: user.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: vaultPda, isSigner: false, isWritable: true },
    ],
    programId: CORE_ID,
    data,
  })], [user], 'Deposit');
}

function buildPostOrderIx(portPda, user, batchPda, regPda, bookPda, side, isMaker, price, qty) {
  const data = Buffer.alloc(22);
  data[0] = 20;
  data[1] = side;
  data[2] = isMaker ? 1 : 0;
  lei64(price).copy(data, 3);
  le64(qty).copy(data, 11);
  le16(0).copy(data, 19); // instrument_id
  data[21] = 0; // reduce_only
  return new TransactionInstruction({
    keys: [
      { pubkey: portPda, isSigner: false, isWritable: true },
      { pubkey: user.publicKey, isSigner: true, isWritable: false },
      { pubkey: batchPda, isSigner: false, isWritable: true },
      { pubkey: regPda, isSigner: false, isWritable: false },
      { pubkey: bookPda, isSigner: false, isWritable: true },
      { pubkey: MATCHER_ID, isSigner: false, isWritable: false },
    ],
    programId: CORE_ID,
    data,
  });
}

function decodeBatch(data) {
  // Offsets match @mgk/sdk decodeBatch / Batch #[repr(C)] (BATCH_SIZE=160)
  return {
    batchId: Number(data.readBigUInt64LE(0)),
    status: data[8],
    commitDeadlineSlot: Number(data.readBigUInt64LE(16)),
    clearingPrice: Number(data.readBigInt64LE(48)),
    totalCommitments: data.readUInt32LE(56),
    markValid: data[152],
    liqPaused: data[153],
    bidClear: Number(data.readBigInt64LE(120)),
    askClear: Number(data.readBigInt64LE(128)),
    matchedBid: Number(data.readBigUInt64LE(136)),
    matchedAsk: Number(data.readBigUInt64LE(144)),
  };
}

async function findOpenBatch(conn) {
  const [regPda] = pda([Buffer.from('registry')], CORE_ID);
  const reg = await conn.getAccountInfo(regPda);
  const counter = Number(Buffer.from(reg.data).readBigUInt64LE(36));
  let best = null;
  for (let id = 0; id <= counter + 2; id++) {
    const [batchPda] = pda([Buffer.from('batch'), le64(id)], CORE_ID);
    const info = await conn.getAccountInfo(batchPda);
    if (!info || info.data.length < 160) continue;
    const batch = decodeBatch(Buffer.from(info.data));
    if (batch.status === 3) continue; // Settled
    if (!best || batch.batchId > best.batch.batchId) {
      best = { batchPda, batch, regPda };
    }
  }
  return best;
}

async function crankWithPortfolios(conn, keeper, batchPda, batch, regPda, vaultPda, instPda, bookPda, oraclePda, portfolios) {
  // Close if collecting
  if (batch.status === 0) {
    console.log('  CloseCollecting...');
    await send(conn, [new TransactionInstruction({
      keys: [
        { pubkey: batchPda, isSigner: false, isWritable: true },
        { pubkey: regPda, isSigner: false, isWritable: false },
      ],
      programId: CORE_ID,
      data: Buffer.from([6]),
    })], [keeper], 'Close');
  }

  // ClearBatch
  console.log('  ClearBatch...');
  const resultsKP = Keypair.generate();
  const resultsLamports = await conn.getMinimumBalanceForRentExemption(RESULTS_SIZE);
  const clearData = Buffer.alloc(7);
  clearData[0] = 7;
  clearData.writeUInt16LE(0, 1);
  clearData.writeUInt16LE(1, 3);
  clearData.writeUInt16LE(0, 5);
  await send(conn, [
    ComputeBudgetProgram.setComputeUnitLimit({ units: CLEAR_CU_LIMIT }),
    SystemProgram.createAccount({
      fromPubkey: keeper.publicKey,
      newAccountPubkey: resultsKP.publicKey,
      lamports: resultsLamports,
      space: RESULTS_SIZE,
      programId: MATCHER_ID,
    }),
    new TransactionInstruction({
      keys: [
        { pubkey: batchPda, isSigner: false, isWritable: true },
        { pubkey: bookPda, isSigner: false, isWritable: true },
        { pubkey: resultsKP.publicKey, isSigner: false, isWritable: true },
        { pubkey: MATCHER_ID, isSigner: false, isWritable: false },
        { pubkey: regPda, isSigner: false, isWritable: false },
        { pubkey: instPda, isSigner: false, isWritable: false },
      ],
      programId: CORE_ID,
      data: clearData,
    }),
  ], [keeper, resultsKP], 'Clear');

  // Read batch after clear
  const afterClear = decodeBatch(Buffer.from((await conn.getAccountInfo(batchPda)).data));
  console.log('  After clear: markValid=' + afterClear.markValid
    + ' bid=' + afterClear.bidClear + ' ask=' + afterClear.askClear
    + ' mBid=' + afterClear.matchedBid + ' mAsk=' + afterClear.matchedAsk
    + ' mid=' + afterClear.clearingPrice);

  // SettleBatch with portfolios
  const nextId = batch.batchId + 1;
  const [nextBatchPda, nextBump] = pda([Buffer.from('batch'), le64(nextId)], CORE_ID);
  console.log('  SettleBatch (next ' + nextId + ')...');
  const settleData = Buffer.alloc(6);
  settleData[0] = 8;
  settleData.writeUInt16LE(0, 1); // commitments
  settleData.writeUInt16LE(portfolios.length, 3); // portfolios
  settleData[5] = nextBump;
  const settleKeys = [
    { pubkey: batchPda, isSigner: false, isWritable: true },
    { pubkey: regPda, isSigner: false, isWritable: true },
    { pubkey: vaultPda, isSigner: false, isWritable: true },
    { pubkey: resultsKP.publicKey, isSigner: false, isWritable: false },
    { pubkey: instPda, isSigner: false, isWritable: true },
    { pubkey: bookPda, isSigner: false, isWritable: false },
    { pubkey: oraclePda, isSigner: false, isWritable: false },
    { pubkey: MATCHER_ID, isSigner: false, isWritable: false },
  ];
  // portfolios at indices 8..8+P-1
  for (const p of portfolios) {
    settleKeys.push({ pubkey: p, isSigner: false, isWritable: true });
  }
  // next batch, payer, system
  settleKeys.push(
    { pubkey: nextBatchPda, isSigner: false, isWritable: true },
    { pubkey: keeper.publicKey, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  );
  await send(conn, [new TransactionInstruction({
    keys: settleKeys,
    programId: CORE_ID,
    data: settleData,
  })], [keeper], 'Settle');

  return { afterClear, nextBatchPda };
}

async function main() {
  const rpc = process.env.RPC_URL || 'https://api.devnet.solana.com';
  const conn = new Connection(rpc, 'confirmed');
  const keeper = loadKP(process.env.DEPLOYER_KEYPAIR || join(homedir(), '.config/solana/id.json'));
  const bookPda = resolveBook();

  let rpcHost = 'invalid-rpc';
  try { rpcHost = new URL(rpc).host; } catch { /* keep invalid-rpc */ }
  console.log('=== mgk DFBA dual-fill e2e ===');
  console.log('RPC host:', rpcHost);
  console.log('Keeper:', keeper.publicKey.toBase58());
  console.log('Book:', bookPda.toBase58());

  const [regPda] = pda([Buffer.from('registry')], CORE_ID);
  const [vaultPda] = pda([Buffer.from('vault')], CORE_ID);
  const [instPda] = pda([Buffer.from('instrument'), le16(0)], CORE_ID);

  const bookInfo = await conn.getAccountInfo(bookPda);
  if (!bookInfo || bookInfo.data.length < BOOK_ACCOUNT_SIZE || !bookInfo.owner.equals(MATCHER_ID)) {
    console.error('Book not ready. Run: node init-protocol.js');
    process.exit(1);
  }

  // Traders
  console.log('\n[1/5] Setup traders...');
  const maker = loadOrCreateTrader('maker');
  const taker = loadOrCreateTrader('taker');
  await ensureFunded(conn, keeper, maker, 0.5 * LAMPORTS_PER_SOL);
  await ensureFunded(conn, keeper, taker, 0.5 * LAMPORTS_PER_SOL);

  console.log('\n[2/5] Portfolios...');
  const makerPort = await ensurePortfolio(conn, keeper, maker);
  const takerPort = await ensurePortfolio(conn, keeper, taker);

  console.log('\n[3/5] Deposits...');
  // Check principal — deposit 0.1 SOL each if low
  const depositAmt = 100_000_000n; // 0.1 SOL
  for (const [label, user, port] of [['maker', maker, makerPort], ['taker', taker, takerPort]]) {
    const info = await conn.getAccountInfo(port);
    // principal at offset 32 as i128 LE — rough check: non-zero means funded
    const prin = info.data.readBigInt64LE(32); // low 8 of i128
    if (prin > 0n) {
      console.log('  ' + label + ' already deposited (principal low64=' + prin + ')');
    } else {
      await deposit(conn, user, port, vaultPda, depositAmt);
    }
  }

  // Open batch
  console.log('\n[4/5] PostOrder dual sides...');
  const open = await findOpenBatch(conn);
  if (!open) {
    console.error('No open batch. Run keeper-crank.js first.');
    process.exit(1);
  }
  console.log('  Open batch', open.batch.batchId, 'status=' + open.batch.status, open.batchPda.toBase58());
  if (open.batch.status !== 0) {
    console.error('  Batch not Collecting (status=' + open.batch.status + '). Crank or wait for next.');
    process.exit(1);
  }

  // Dual auction for mark_valid:
  //   Bid auction: maker-buy × taker-sell @ PRICE
  //   Ask auction: maker-sell × taker-buy @ PRICE
  const posts = [
    [maker, makerPort, SIDE_BUY, true, 'maker-buy'],
    [taker, takerPort, SIDE_SELL, false, 'taker-sell'],
    [maker, makerPort, SIDE_SELL, true, 'maker-sell'],
    [taker, takerPort, SIDE_BUY, false, 'taker-buy'],
  ];
  for (const [user, port, side, isMaker, label] of posts) {
    console.log('  Posting', label, '@', PRICE.toString(), 'qty', QTY.toString());
    await send(conn, [
      buildPostOrderIx(port, user, open.batchPda, regPda, bookPda, side, isMaker, PRICE, QTY),
    ], [user], 'Post:' + label);
  }

  // Oracle from instrument @60
  const instInfo = await conn.getAccountInfo(instPda);
  const oraclePda = new PublicKey(instInfo.data.slice(60, 92));

  console.log('\n[5/5] Crank Clear+Settle...');
  const { afterClear } = await crankWithPortfolios(
    conn, keeper, open.batchPda, open.batch, regPda, vaultPda, instPda,
    bookPda, oraclePda, [makerPort, takerPort],
  );

  // Final assertions
  const settled = decodeBatch(Buffer.from((await conn.getAccountInfo(open.batchPda)).data));
  console.log('\n=== Results ===');
  console.log('Batch', settled.batchId, 'status=' + settled.status,
    'markValid=' + settled.markValid, 'liqPaused=' + settled.liqPaused);
  console.log('Clearing mid:', settled.clearingPrice,
    'bid:', settled.bidClear, 'ask:', settled.askClear);
  console.log('Matched bid/ask:', settled.matchedBid, settled.matchedAsk);

  // Portfolio positions peek: positions start after header — skip deep decode, just report equity
  for (const [label, port] of [['maker', makerPort], ['taker', takerPort]]) {
    const d = Buffer.from((await conn.getAccountInfo(port)).data);
    // BPF portfolio: user@0, equity is somewhere — print first 80 bytes hex for debug
    console.log(label, 'port bytes[32..64]:', d.slice(32, 64).toString('hex'));
  }

  const ok = settled.status === 3 && settled.markValid === 1
    && afterClear.matchedBid > 0 && afterClear.matchedAsk > 0;
  if (ok) {
    console.log('\nPASS: dual fill + mark_valid settle');
    process.exit(0);
  } else {
    console.error('\nFAIL: expected Settled+mark_valid with dual matched qty');
    console.error('  afterClear.markValid=', afterClear.markValid,
      'mBid=', afterClear.matchedBid, 'mAsk=', afterClear.matchedAsk);
    process.exit(1);
  }
}

module.exports = {
  loadKP,
  loadOrCreateTrader,
  ensureFunded,
  ensurePortfolio,
  deposit,
  pda,
  CORE_ID,
  LAMPORTS_PER_SOL: require('@solana/web3.js').LAMPORTS_PER_SOL,
};

if (require.main === module) {
  main().catch((e) => {
    console.error('Fatal:', e.message || e);
    process.exit(1);
  });
}
