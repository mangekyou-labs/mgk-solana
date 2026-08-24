#!/usr/bin/env node
/**
 * T9.10.3 — governance SetInstrumentOracle (disc 23).
 *
 * Binds the core Instrument PDA to the PriceOracle data account.
 *
 * Usage:
 *   node set-instrument-oracle.js
 *   node set-instrument-oracle.js --oracle <ORACLE_PUBKEY> --instrument <INSTRUMENT_PUBKEY>
 *
 * Env: RPC_URL, DEPLOYER_KEYPAIR / KEEPER_KEYPAIR, ORACLE_ACCOUNT_ADDRESS, INSTRUMENT_ADDRESS
 * Logs RPC **host** only — never the full URL or api-key.
 */
'use strict';

const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } = require('@solana/web3.js');
const { readFileSync } = require('fs');
const { homedir } = require('os');
const { join } = require('path');
const { loadEnvLocal } = require('./inject-persona');

const CORE_ID = new PublicKey('C7w2mKz2KQgDroNNhACm9MutXhPiesVr9Gn2x8TDsRYx');
const ORACLE_ADDR_OFFSET = 60;
const ORACLE_ADDR_LEN = 32;

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

function decodeOracleAddr(data) {
  return new PublicKey(data.subarray(ORACLE_ADDR_OFFSET, ORACLE_ADDR_OFFSET + ORACLE_ADDR_LEN));
}

function parseArgs(argv) {
  let oracle = process.env.ORACLE_ACCOUNT_ADDRESS || null;
  let instrument = process.env.INSTRUMENT_ADDRESS || null;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--oracle' && argv[i + 1] != null) {
      oracle = argv[++i];
    } else if (argv[i] === '--instrument' && argv[i + 1] != null) {
      instrument = argv[++i];
    }
  }
  return {
    oraclePubkey: oracle ? new PublicKey(oracle) : null,
    instrumentPubkey: instrument ? new PublicKey(instrument) : null,
  };
}

async function setInstrumentOracle({
  connection,
  governanceKeypair,
  oracleAccount,
  instrumentAccount,
  coreProgramId = CORE_ID,
}) {
  const [regPDA] = pda([Buffer.from('registry')], coreProgramId);
  const instPDA = instrumentAccount || pda([Buffer.from('instrument'), le16(0)], coreProgramId)[0];

  const beforeInfo = await connection.getAccountInfo(instPDA);
  if (!beforeInfo || beforeInfo.data.length < ORACLE_ADDR_OFFSET + ORACLE_ADDR_LEN) {
    throw new Error('instrument account missing or too small');
  }

  const currentOracle = decodeOracleAddr(beforeInfo.data);
  if (currentOracle.equals(oracleAccount)) {
    console.log(`[set-instrument-oracle] Instrument already bound to oracle ${oracleAccount.toBase58()} (idempotent skip)`);
    return { sig: null, oracle: oracleAccount.toBase58(), updated: false };
  }

  console.log(`[set-instrument-oracle] Updating instrument ${instPDA.toBase58()} oracle: ${currentOracle.toBase58()} -> ${oracleAccount.toBase58()}`);

  const data = Buffer.from([23]); // CoreInstruction::SetInstrumentOracle = 23

  const tx = new Transaction().add(
    new TransactionInstruction({
      keys: [
        { pubkey: instPDA, isSigner: false, isWritable: true },
        { pubkey: regPDA, isSigner: false, isWritable: false },
        { pubkey: governanceKeypair.publicKey, isSigner: true, isWritable: false },
        { pubkey: oracleAccount, isSigner: false, isWritable: false },
      ],
      programId: coreProgramId,
      data,
    }),
  );

  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.feePayer = governanceKeypair.publicKey;
  tx.sign(governanceKeypair);

  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction(sig, 'confirmed');
  console.log('[set-instrument-oracle] TX:', sig);

  const afterInfo = await connection.getAccountInfo(instPDA);
  const after = decodeOracleAddr(afterInfo.data);
  if (!after.equals(oracleAccount)) {
    throw new Error(`on-chain oracle_addr ${after.toBase58()} did not match target ${oracleAccount.toBase58()}`);
  }

  return { sig, oracle: after.toBase58(), updated: true };
}

async function main() {
  loadEnvLocal();
  const { oraclePubkey, instrumentPubkey } = parseArgs(process.argv);
  if (!oraclePubkey) {
    throw new Error('ORACLE_ACCOUNT_ADDRESS or --oracle required');
  }

  const rpc = process.env.RPC_URL || process.env.NEXT_PUBLIC_RPC_URL || 'https://api.devnet.solana.com';
  let rpcHost = 'invalid-rpc';
  try {
    rpcHost = new URL(rpc).host;
  } catch {
    /* keep invalid-rpc */
  }

  const kpPath = process.env.DEPLOYER_KEYPAIR || process.env.KEEPER_KEYPAIR || join(homedir(), '.config/solana/id.json');
  const conn = new Connection(rpc, 'confirmed');
  const gov = loadKP(kpPath);

  console.log('=== SetInstrumentOracle (disc 23) ===');
  console.log('RPC host:', rpcHost);
  console.log('Governance:', gov.publicKey.toBase58());
  console.log('Target Oracle:', oraclePubkey.toBase58());

  await setInstrumentOracle({
    connection: conn,
    governanceKeypair: gov,
    oracleAccount: oraclePubkey,
    instrumentAccount: instrumentPubkey,
  });
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}

module.exports = {
  setInstrumentOracle,
  decodeOracleAddr,
};
