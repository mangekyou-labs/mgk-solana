/**
 * Node-side live wallet: load a keypair from a path, sign, sendRawTransaction.
 * Secrets stay in this process. Init-script payload is pubkey-only.
 */
const { readFileSync } = require('fs');
const { Keypair, Transaction } = require('@solana/web3.js');

function loadKeypairFromPath(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(raw)) {
    throw new Error(`Keypair file is not a JSON byte array: ${path}`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function liveWalletInitPayload(keypairPath) {
  const keypair = loadKeypairFromPath(keypairPath);
  return {
    publicKeyBytes: Array.from(keypair.publicKey.toBytes()),
    publicKeyBase58: keypair.publicKey.toBase58(),
  };
}

function signSerializedTransaction(keypairPath, serialized) {
  const keypair = loadKeypairFromPath(keypairPath);
  const tx = Transaction.from(Uint8Array.from(serialized));
  tx.partialSign(keypair);
  return tx.serialize();
}

async function signAndSendSerializedTransaction({
  keypairPath,
  connection,
  serialized,
}) {
  const raw = signSerializedTransaction(keypairPath, serialized);
  return connection.sendRawTransaction(raw);
}

/**
 * Injected in the page. Playwright serializes this function — close over
 * payload args only, never a secret key.
 */
function liveWalletPageInstaller({ publicKeyBytes, publicKeyBase58 }) {
  const listeners = new Map();

  const emit = (event, ...args) => {
    for (const listener of listeners.get(event) ?? []) listener(...args);
  };

  const publicKey = {
    toBytes: () => new Uint8Array(publicKeyBytes),
    toBase58: () => publicKeyBase58,
    toString: () => publicKeyBase58,
    equals: (other) => (other?.toBase58?.() ?? String(other)) === publicKeyBase58,
  };

  const signBytes = async (transaction) => {
    const serialized = transaction.serialize({ requireAllSignatures: false });
    const hop = window.__mgkLiveSign;
    if (typeof hop !== 'function') {
      throw new Error('Live wallet sign hop is not installed');
    }
    return hop(Array.from(serialized));
  };

  const wallet = {
    isPhantom: true,
    isConnected: false,
    publicKey,
    on(event, listener) {
      const eventListeners = listeners.get(event) ?? new Set();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
    },
    off(event, listener) {
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
    async signTransaction(transaction) {
      const signed = await signBytes(transaction);
      const Ctor = transaction.constructor;
      if (typeof Ctor.from === 'function') {
        return Ctor.from(Uint8Array.from(signed));
      }
      return transaction;
    },
    async signAllTransactions(transactions) {
      return Promise.all(transactions.map((tx) => wallet.signTransaction(tx)));
    },
    async signAndSendTransaction(transaction) {
      const signed = await wallet.signTransaction(transaction);
      const hop = window.__mgkLiveSignAndSend;
      if (typeof hop !== 'function') {
        throw new Error('Live wallet send hop is not installed');
      }
      const serialized = signed.serialize();
      const signature = await hop(Array.from(serialized));
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
}

module.exports = {
  loadKeypairFromPath,
  liveWalletInitPayload,
  signSerializedTransaction,
  signAndSendSerializedTransaction,
  liveWalletPageInstaller,
};
