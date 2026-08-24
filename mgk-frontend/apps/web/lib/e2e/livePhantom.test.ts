/** @vitest-environment node */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  liveWalletInitPayload,
  loadKeypairFromPath,
  signAndSendSerializedTransaction,
} from '../../e2e/fixtures/livePhantom';

function writeKeypair(dir: string, name: string, keypair = Keypair.generate()) {
  const path = join(dir, `${name}.json`);
  writeFileSync(path, JSON.stringify(Array.from(keypair.secretKey)));
  return { path, keypair };
}

function unsignedTransfer(feePayer: Keypair): Uint8Array {
  const tx = new Transaction();
  tx.feePayer = feePayer.publicKey;
  tx.recentBlockhash = '11111111111111111111111111111111';
  tx.add(
    SystemProgram.transfer({
      fromPubkey: feePayer.publicKey,
      toPubkey: feePayer.publicKey,
      lamports: 1,
    }),
  );
  return tx.serialize({ requireAllSignatures: false });
}

describe('live-signing wallet helper', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mgk-live-wallet-'));

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads distinct pubkeys from two keypair paths', () => {
    const a = writeKeypair(dir, 'maker');
    const b = writeKeypair(dir, 'taker');

    expect(loadKeypairFromPath(a.path).publicKey.toBase58()).not.toBe(
      loadKeypairFromPath(b.path).publicKey.toBase58(),
    );
    expect(loadKeypairFromPath(a.path).publicKey.toBase58()).toBe(
      a.keypair.publicKey.toBase58(),
    );
  });

  it('init payload exposes public key bytes and never the secret, seed, or password', () => {
    const { path, keypair } = writeKeypair(dir, 'payload');
    const payload = liveWalletInitPayload(path);
    const serialized = JSON.stringify(payload);

    expect(payload.publicKeyBytes).toEqual(Array.from(keypair.publicKey.toBytes()));
    expect(payload.publicKeyBase58).toBe(keypair.publicKey.toBase58());
    expect(serialized).not.toMatch(/secretKey/i);
    expect(serialized).not.toMatch(/seed/i);
    expect(serialized).not.toMatch(/password/i);
    expect(serialized).not.toContain(JSON.stringify(Array.from(keypair.secretKey)));
    expect('secretKey' in payload).toBe(false);
  });

  it('signAndSend uses Connection.sendRawTransaction instead of capture-only return', async () => {
    const { path, keypair } = writeKeypair(dir, 'send');
    const sendRawTransaction = vi.fn().mockResolvedValue('5'.repeat(64));
    const connection = { sendRawTransaction };

    const signature = await signAndSendSerializedTransaction({
      keypairPath: path,
      connection,
      serialized: unsignedTransfer(keypair),
    });

    expect(sendRawTransaction).toHaveBeenCalledTimes(1);
    const raw = sendRawTransaction.mock.calls[0]?.[0] as Buffer | Uint8Array;
    expect(raw).toBeInstanceOf(Uint8Array);
    const signed = Transaction.from(raw);
    expect(signed.signatures[0]?.signature).not.toBeNull();
    expect(signed.verifySignatures()).toBe(true);
    expect(signature).toBe('5'.repeat(64));
  });
});
