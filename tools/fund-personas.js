#!/usr/bin/env node
/**
 * Fund + InitPortfolio (disc 19) + Deposit for maker and taker personas.
 * Reuses tools/trade-e2e.js helpers. Does not post orders or crank.
 *
 *   node tools/fund-personas.js
 *
 * Env: RPC_URL, DEPLOYER_KEYPAIR, MGK_MAKER_KEYPAIR, MGK_TAKER_KEYPAIR
 */
const { Connection, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { homedir } = require('os');
const { join } = require('path');
const {
  loadKP,
  loadOrCreateTrader,
  ensureFunded,
  ensurePortfolio,
  deposit,
  pda,
  CORE_ID,
} = require('./trade-e2e');
const { loadEnvLocal } = require('./inject-persona');

async function main() {
  loadEnvLocal();
  const rpc = process.env.RPC_URL || process.env.NEXT_PUBLIC_RPC_URL || 'https://api.devnet.solana.com';
  const conn = new Connection(rpc, 'confirmed');
  const keeper = loadKP(
    process.env.DEPLOYER_KEYPAIR || join(homedir(), '.config/solana/id.json'),
  );
  const [vaultPda] = pda([Buffer.from('vault')], CORE_ID);
  const depositAmt = 100_000_000n;

  const rpcHost = (() => {
    try {
      return new URL(rpc).host;
    } catch {
      return 'invalid-rpc';
    }
  })();
  console.log('=== mgk persona funding ===');
  console.log('RPC host:', rpcHost);
  console.log('Keeper:', keeper.publicKey.toBase58());

  const results = [];
  for (const name of ['maker', 'taker']) {
    const user = loadOrCreateTrader(name);
    await ensureFunded(conn, keeper, user, 0.5 * LAMPORTS_PER_SOL);
    const port = await ensurePortfolio(conn, keeper, user);
    const info = await conn.getAccountInfo(port);
    const prin = info ? info.data.readBigInt64LE(32) : 0n;
    if (prin > 0n) {
      console.log('  ' + name + ' already deposited (principal low64=' + prin + ')');
    } else {
      await deposit(conn, user, port, vaultPda, depositAmt);
    }
    results.push({
      persona: name,
      pubkey: user.publicKey.toBase58(),
      portfolio: port.toBase58(),
    });
  }

  for (const row of results) {
    console.log(
      row.persona,
      row.pubkey,
      'portfolio',
      row.portfolio,
    );
  }
}

main().catch((e) => {
  console.error('Fatal:', e.message || e);
  process.exit(1);
});
