#!/usr/bin/env node
/**
 * mgk Protocol Devnet Init
 *
 * Creates (idempotent where possible):
 *   1. Registry + Instrument + Vault (core Initialize disc 0)
 *   2. Book PDA (matcher InitializeBook disc 7)
 *   3. SetBatchParams (disc 21)
 *   4. Batch 0 (CreateBatch disc 16) if missing
 *
 * Usage:
 *   node init-protocol.js
 * Env: RPC_URL, DEPLOYER_KEYPAIR
 */
const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram } = require('@solana/web3.js');
const { readFileSync } = require('fs');
const { homedir } = require('os');
const { join } = require('path');

const CORE_ID = new PublicKey('C7w2mKz2KQgDroNNhACm9MutXhPiesVr9Gn2x8TDsRYx');
const MATCHER_ID = new PublicKey('7WiZuunbPGciCedsVTguvjezwwzrhmXG5HkdCuHizbNC');
const ORACLE_ID = new PublicKey('CsSqVZMoXixNYstNhTtixeT4pyRgrYnXdpfoXQBgFPqZ');
const BOOK_ACCOUNT_SIZE = 27_704;
const VAULT_SIZE = 80;

const PARAMS = {
  baseDeposit: 10_000_000n, nMin: 1, tMinSlots: 2n, tMaxSlots: 150n,
  tRevealSlots: 0n, instrumentId: 0, tickSize: 1n, lotSize: 1n,
  imrBps: 100, mmrBps: 50, takerFeeBps: 5, makerFeeBps: 0,
  volatilityMultiplier: 10_000, maxOrdersPerBatch: 64, marginalSizeCap: 64,
};

function loadKP(p) { return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, 'utf-8')))); }
function pda(seeds, prog) { return PublicKey.findProgramAddressSync(seeds, prog); }
function le16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v, 0); return b; }
function le32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v, 0); return b; }
function le64(v) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v), 0); return b; }
function lei16(v) { const b = Buffer.alloc(2); b.writeInt16LE(v, 0); return b; }

async function send(conn, ix, signers, label) {
  const tx = new Transaction().add(ix);
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction(sig, 'confirmed');
  console.log('  [' + label + '] TX:', sig);
  return sig;
}

async function main() {
  const rpc = process.env.RPC_URL || 'https://api.devnet.solana.com';
  const kp = process.env.DEPLOYER_KEYPAIR || join(homedir(), '.config/solana/id.json');
  let rpcHost = 'invalid-rpc';
  try { rpcHost = new URL(rpc).host; } catch { /* keep invalid-rpc */ }
  console.log('=== mgk Protocol Init ===');
  console.log('RPC host:', rpcHost);
  const conn = new Connection(rpc, 'confirmed');
  const gov = loadKP(kp);
  console.log('Governance:', gov.publicKey.toBase58());
  console.log('Balance:', (await conn.getBalance(gov.publicKey)) / 1e9, 'SOL');

  const [regPDA, regBump] = pda([Buffer.from('registry')], CORE_ID);
  const [instPDA, instBump] = pda([Buffer.from('instrument'), le16(PARAMS.instrumentId)], CORE_ID);
  const [vaultPDA, vaultBump] = pda([Buffer.from('vault')], CORE_ID);
  const [batch0PDA, batch0Bump] = pda([Buffer.from('batch'), le64(0n)], CORE_ID);
  const [bookPDA, bookBump] = pda([Buffer.from('book'), le16(PARAMS.instrumentId)], MATCHER_ID);

  console.log('Registry:', regPDA.toBase58());
  console.log('Instrument:', instPDA.toBase58());
  console.log('Vault:', vaultPDA.toBase58());
  console.log('Book:', bookPDA.toBase58());
  console.log('Batch 0:', batch0PDA.toBase58());

  const regInfo = await conn.getAccountInfo(regPDA);
  const vaultInfo = await conn.getAccountInfo(vaultPDA);
  const vaultOk = vaultInfo && vaultInfo.data.length >= VAULT_SIZE;
  const regOk = regInfo && regInfo.data.length > 0 && regInfo.data.some((b) => b !== 0);

  // 1. Initialize (or re-run to create missing vault under existing registry)
  if (regOk && vaultOk) {
    console.log('\n[1/4] Registry + Vault already present — skip Initialize.');
  } else {
    console.log(regOk
      ? '\n[1/4] Registry exists but Vault missing/undersized — re-run Initialize to create Vault...'
      : '\n[1/4] Initialize (registry + instrument + vault)...');
    const d = Buffer.alloc(142); d[0] = 0;
    d.set(gov.publicKey.toBuffer(), 1);
    le16(1).copy(d, 33);
    le16(PARAMS.volatilityMultiplier).copy(d, 35);
    le64(0).copy(d, 37);
    le64(PARAMS.baseDeposit).copy(d, 45);
    le32(PARAMS.nMin).copy(d, 53);
    le64(PARAMS.tMinSlots).copy(d, 57);
    le64(PARAMS.tMaxSlots).copy(d, 65);
    le64(PARAMS.tRevealSlots).copy(d, 73);
    le16(PARAMS.instrumentId).copy(d, 81);
    le64(PARAMS.tickSize).copy(d, 83);
    le64(PARAMS.lotSize).copy(d, 91);
    le16(PARAMS.imrBps).copy(d, 99);
    le16(PARAMS.mmrBps).copy(d, 101);
    le16(PARAMS.takerFeeBps).copy(d, 103);
    lei16(PARAMS.makerFeeBps).copy(d, 105);
    d.set(ORACLE_ID.toBuffer(), 107);
    d[139] = regBump; d[140] = instBump; d[141] = vaultBump;

    await send(conn, new TransactionInstruction({
      keys: [
        { pubkey: regPDA, isSigner: false, isWritable: true },
        { pubkey: gov.publicKey, isSigner: true, isWritable: true },
        { pubkey: instPDA, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: vaultPDA, isSigner: false, isWritable: true },
      ],
      programId: CORE_ID,
      data: d,
    }), [gov], 'Initialize');
    console.log('  Registry + Instrument + Vault ready');
  }

  // 2. Book account (27_704 bytes).
  // CPI CreateAccount is limited to +10KB; top-level SystemProgram.createAccount
  // can allocate the full BookState. We use a keypair book (matcher-owned) and
  // persist it for the keeper/frontend. PDA multi-step realloc is future work
  // (matcher InitializeBook disc 7 is reserved for that path).
  const bookKeyPath = process.env.BOOK_KEYPAIR
    || join(homedir(), '.config/solana/mgk-book-keypair.json');
  let bookPubkey = bookPDA;
  const bookInfo = await conn.getAccountInfo(bookPDA);
  // Prefer existing PDA book if present and large enough
  if (bookInfo && bookInfo.data.length >= BOOK_ACCOUNT_SIZE
      && bookInfo.owner.equals(MATCHER_ID)) {
    console.log('\n[2/4] Book PDA already present — skip create.');
    bookPubkey = bookPDA;
  } else {
    // Keypair book path (client-side create, full size)
    const { writeFileSync, mkdirSync } = require('fs');
    mkdirSync(join(homedir(), '.config/solana'), { recursive: true });
    let bookKP = null;
    try {
      bookKP = loadKP(bookKeyPath);
      const existing = await conn.getAccountInfo(bookKP.publicKey);
      if (existing && existing.data.length >= BOOK_ACCOUNT_SIZE
          && existing.owner.equals(MATCHER_ID)) {
        console.log('\n[2/4] Book keypair ready:', bookKP.publicKey.toBase58());
        bookPubkey = bookKP.publicKey;
      } else if (existing) {
        console.log('\n[2/4] Stale book keypair (owner', existing.owner.toBase58().slice(0, 8),
          'len=' + existing.data.length + ') — generating new keypair.');
        bookKP = null;
      } else {
        console.log('\n[2/4] Loaded unused book keypair:', bookKP.publicKey.toBase58());
      }
    } catch {
      bookKP = null;
    }
    if (!bookPubkey || bookPubkey.equals(bookPDA)) {
      if (!bookKP) {
        bookKP = Keypair.generate();
        writeFileSync(bookKeyPath, JSON.stringify(Array.from(bookKP.secretKey)));
        console.log('  Generated book keypair →', bookKeyPath);
      }
      bookPubkey = bookKP.publicKey;
      const existing = await conn.getAccountInfo(bookPubkey);
      if (existing && existing.data.length >= BOOK_ACCOUNT_SIZE
          && existing.owner.equals(MATCHER_ID)) {
        console.log('  Book keypair account already funded.');
      } else if (existing) {
        // Account in use by another program — must rotate keypair
        bookKP = Keypair.generate();
        writeFileSync(bookKeyPath, JSON.stringify(Array.from(bookKP.secretKey)));
        bookPubkey = bookKP.publicKey;
        console.log('  Rotated to fresh keypair:', bookPubkey.toBase58());
        const lamports = await conn.getMinimumBalanceForRentExemption(BOOK_ACCOUNT_SIZE);
        const tx = new Transaction().add(SystemProgram.createAccount({
          fromPubkey: gov.publicKey,
          newAccountPubkey: bookKP.publicKey,
          lamports,
          space: BOOK_ACCOUNT_SIZE,
          programId: MATCHER_ID,
        }));
        tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
        tx.feePayer = gov.publicKey;
        tx.sign(gov, bookKP);
        const sig = await conn.sendRawTransaction(tx.serialize());
        await conn.confirmTransaction(sig, 'confirmed');
        console.log('  [CreateBook] TX:', sig);
      } else {
        console.log('  Creating matcher-owned book account (' + BOOK_ACCOUNT_SIZE + ' bytes)...');
        const lamports = await conn.getMinimumBalanceForRentExemption(BOOK_ACCOUNT_SIZE);
        const tx = new Transaction().add(SystemProgram.createAccount({
          fromPubkey: gov.publicKey,
          newAccountPubkey: bookKP.publicKey,
          lamports,
          space: BOOK_ACCOUNT_SIZE,
          programId: MATCHER_ID,
        }));
        tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
        tx.feePayer = gov.publicKey;
        tx.sign(gov, bookKP);
        const sig = await conn.sendRawTransaction(tx.serialize());
        await conn.confirmTransaction(sig, 'confirmed');
        console.log('  [CreateBook] TX:', sig);
      }
    }
  }

  // 3. SetBatchParams (disc 21)
  console.log('\n[3/4] SetBatchParams...');
  const pd = Buffer.alloc(23); pd[0] = 21;
  pd[1] = PARAMS.maxOrdersPerBatch; pd[2] = PARAMS.marginalSizeCap;
  le64(PARAMS.tMinSlots).copy(pd, 3);
  le64(PARAMS.tMaxSlots).copy(pd, 11);
  le32(PARAMS.nMin).copy(pd, 19);
  try {
    await send(conn, new TransactionInstruction({
      keys: [
        { pubkey: regPDA, isSigner: false, isWritable: true },
        { pubkey: gov.publicKey, isSigner: true, isWritable: false },
      ],
      programId: CORE_ID,
      data: pd,
    }), [gov], 'SetBatchParams');
    console.log('  Batch params set');
  } catch (e) {
    console.warn('  SetBatchParams failed (non-fatal if already set):', e.message);
  }

  // 4. CreateBatch 0 if missing
  const batchInfo = await conn.getAccountInfo(batch0PDA);
  if (batchInfo && batchInfo.data.length >= 160) {
    console.log('\n[4/4] Batch 0 already present — skip CreateBatch.');
    console.log('  status=', batchInfo.data[8],
      'batchId=', Number(batchInfo.data.readBigUInt64LE(0)));
  } else {
    console.log('\n[4/4] CreateBatch 0...');
    const cbd = Buffer.alloc(2); cbd[0] = 16; cbd[1] = batch0Bump;
    await send(conn, new TransactionInstruction({
      keys: [
        { pubkey: batch0PDA, isSigner: false, isWritable: true },
        { pubkey: regPDA, isSigner: false, isWritable: true },
        { pubkey: gov.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: CORE_ID,
      data: cbd,
    }), [gov], 'CreateBatch');
    console.log('  Batch 0 created (collecting window open)');
  }

  // Final account check
  console.log('\n=== Account check ===');
  for (const [name, addr, minLen, owner] of [
    ['Registry', regPDA, 86, CORE_ID],
    ['Instrument', instPDA, 336, CORE_ID],
    ['Vault', vaultPDA, VAULT_SIZE, CORE_ID],
    ['Book', bookPubkey, BOOK_ACCOUNT_SIZE, MATCHER_ID],
    ['Batch0', batch0PDA, 160, CORE_ID],
  ]) {
    const info = await conn.getAccountInfo(addr);
    if (!info) {
      console.log('  FAIL', name, 'MISSING', addr.toBase58());
    } else {
      const ok = info.data.length >= minLen && info.owner.equals(owner);
      console.log('  ' + (ok ? 'OK  ' : 'WARN'), name,
        'len=' + info.data.length, 'owner=' + info.owner.toBase58().slice(0, 8) + '...');
    }
  }

  console.log('\n=== Done ===');
  console.log('Registry:', regPDA.toBase58());
  console.log('Instrument:', instPDA.toBase58());
  console.log('Vault:', vaultPDA.toBase58());
  console.log('Book:', bookPubkey.toBase58());
  console.log('Batch 0:', batch0PDA.toBase58());
  console.log('\nExport for keeper/frontend:');
  console.log('  export BOOK_ADDRESS=' + bookPubkey.toBase58());
  console.log('\nNext: BOOK_ADDRESS=' + bookPubkey.toBase58() + ' node keeper-crank.js');
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
