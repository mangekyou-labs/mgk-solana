/**
 * Install a live-signing injected Phantom wallet into a playwright-cli page.
 *
 * playwright-cli `run-code` runs in a vm with only `page` (no require/import).
 * The invoking shell's env does not reach an already-running CLI daemon, so
 * do not pass MGK_PERSONA via --filename inject. Operator path:
 *
 *   tools/persona-inject.sh maker
 *   playwright-cli -s=maker reload
 *   tools/persona-inject.sh taker
 *   playwright-cli -s=taker reload
 */
const { readFileSync } = require('fs');
const { homedir } = require('os');
const { join } = require('path');
const { Connection } = require('@solana/web3.js');
const {
  liveWalletInitPayload,
  signSerializedTransaction,
  signAndSendSerializedTransaction,
  liveWalletPageInstaller,
} = require('./live-wallet');

function loadEnvLocal() {
  const candidates = [
    join(__dirname, '../mgk-frontend/apps/web/.env.local'),
    join(__dirname, '../.env.local'),
  ];
  for (const envPath of candidates) {
    let text;
    try {
      text = readFileSync(envPath, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq);
      let value = trimmed.slice(eq + 1);
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

function personaKeypairPath(persona) {
  const envName = `MGK_${String(persona).toUpperCase()}_KEYPAIR`;
  return (
    process.env[envName] ||
    join(homedir(), '.config/solana', `mgk-trader-${persona}.json`)
  );
}

function rpcHost(rpcUrl) {
  try {
    return new URL(rpcUrl).host;
  } catch {
    return 'invalid-rpc';
  }
}

async function install(page, persona) {
  loadEnvLocal();
  const keypairPath = personaKeypairPath(persona);
  const rpcUrl =
    process.env.RPC_URL ||
    process.env.NEXT_PUBLIC_RPC_URL ||
    'https://api.devnet.solana.com';
  const payload = liveWalletInitPayload(keypairPath);

  await page.exposeFunction('__mgkLiveSign', async (serialized) =>
    Array.from(signSerializedTransaction(keypairPath, serialized)),
  );
  await page.exposeFunction('__mgkLiveSignAndSend', async (serialized) => {
    const connection = new Connection(rpcUrl, 'confirmed');
    return signAndSendSerializedTransaction({
      keypairPath,
      connection,
      serialized,
    });
  });
  await page.addInitScript(liveWalletPageInstaller, payload);
  return {
    persona,
    publicKeyBase58: payload.publicKeyBase58,
    rpcHost: rpcHost(rpcUrl),
  };
}

module.exports = { install, personaKeypairPath, loadEnvLocal };
