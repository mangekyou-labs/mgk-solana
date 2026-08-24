#!/usr/bin/env node
/**
 * T9.10.1 — governance SetInstrumentFees (disc 22).
 *
 * Usage:
 *   node set-instrument-fees.js              # default locked D3: taker 5 / maker 0
 *   node set-instrument-fees.js --taker 5 --maker 0
 *
 * Env: RPC_URL, DEPLOYER_KEYPAIR
 * Logs RPC **host** only — never the full URL or api-key.
 */
const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } = require('@solana/web3.js');
const { readFileSync } = require('fs');
const { homedir } = require('os');
const { join } = require('path');
const { loadEnvLocal } = require('./inject-persona');

const CORE_ID = new PublicKey('C7w2mKz2KQgDroNNhACm9MutXhPiesVr9Gn2x8TDsRYx');
const TAKER_FEE_OFFSET = 52;
const MAKER_FEE_OFFSET = 54;

function loadKP(p) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, 'utf-8'))));
}
function pda(seeds, prog) {
  return PublicKey.findProgramAddressSync(seeds, prog);
}
function le16(v) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v, 0);
  return b;
}

function decodeFees(data) {
  return {
    takerFeeBps: data.readUInt16LE(TAKER_FEE_OFFSET),
    makerFeeBps: data.readInt16LE(MAKER_FEE_OFFSET),
  };
}

function parseArgs(argv) {
  let taker = 5;
  let maker = 0;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--taker' && argv[i + 1] != null) {
      taker = Number(argv[++i]);
    } else if (argv[i] === '--maker' && argv[i + 1] != null) {
      maker = Number(argv[++i]);
    }
  }
  if (!Number.isInteger(taker) || taker < 0 || taker > 0xffff) {
    throw new Error('taker fee must be u16');
  }
  if (!Number.isInteger(maker) || maker < -32768 || maker > 32767) {
    throw new Error('maker fee must be i16');
  }
  return { taker, maker };
}

async function main() {
  loadEnvLocal();
  const { taker, maker } = parseArgs(process.argv);
  const rpc = process.env.RPC_URL || process.env.NEXT_PUBLIC_RPC_URL || 'https://api.devnet.solana.com';
  let rpcHost = 'invalid-rpc';
  try { rpcHost = new URL(rpc).host; } catch { /* keep invalid-rpc */ }
  const kp = process.env.DEPLOYER_KEYPAIR || join(homedir(), '.config/solana/id.json');
  const conn = new Connection(rpc, 'confirmed');
  const gov = loadKP(kp);
  const [regPDA] = pda([Buffer.from('registry')], CORE_ID);
  const [instPDA] = pda([Buffer.from('instrument'), le16(0)], CORE_ID);

  console.log('=== SetInstrumentFees (disc 22) ===');
  console.log('RPC host:', rpcHost);
  console.log('Governance:', gov.publicKey.toBase58());
  console.log('Instrument:', instPDA.toBase58());
  console.log('Target: taker', taker, 'bps / maker', maker, 'bps');

  const beforeInfo = await conn.getAccountInfo(instPDA);
  if (!beforeInfo || beforeInfo.data.length < 56) {
    throw new Error('instrument account missing or too small');
  }
  const before = decodeFees(beforeInfo.data);
  console.log('Before: taker', before.takerFeeBps, 'bps / maker', before.makerFeeBps, 'bps');

  const data = Buffer.alloc(5);
  data[0] = 22;
  data.writeUInt16LE(taker, 1);
  data.writeInt16LE(maker, 3);

  const tx = new Transaction().add(new TransactionInstruction({
    keys: [
      { pubkey: instPDA, isSigner: false, isWritable: true },
      { pubkey: regPDA, isSigner: false, isWritable: false },
      { pubkey: gov.publicKey, isSigner: true, isWritable: false },
    ],
    programId: CORE_ID,
    data,
  }));
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.feePayer = gov.publicKey;
  tx.sign(gov);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction(sig, 'confirmed');
  console.log('TX:', sig);

  const afterInfo = await conn.getAccountInfo(instPDA);
  const after = decodeFees(afterInfo.data);
  console.log('After: taker', after.takerFeeBps, 'bps / maker', after.makerFeeBps, 'bps');
  if (after.takerFeeBps !== taker || after.makerFeeBps !== maker) {
    throw new Error('on-chain fees did not match target');
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
