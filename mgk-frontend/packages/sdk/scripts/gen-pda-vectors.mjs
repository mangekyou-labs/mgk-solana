/**
 * One-off: generate seed→pubkey vectors for the pda.test.ts known-vector tests.
 * Run with: node packages/sdk/scripts/gen-pda-vectors.mjs
 *
 * This re-implements the seed encoding inline (no TS) so it doesn't need tsx.
 * The pda.ts logic is mirrored exactly here. If the SDK's pda.ts drifts from
 * this script, the tests will catch it.
 */
import { PublicKey } from '@solana/web3.js';

const CORE = new PublicKey('DBrCzAMAJhxnPRQnBzEZGMhSALGfvQDDe6xEn2nU1uar');
const MATCHER = new PublicKey('9o2vTBBhEp6CYxNsDPsX79Euhzh8TtoLTSHR5R3jXebZ');
const USER = new PublicKey('A6qbhK9mPRpFhX7D1kZsBpr2xNy8mfgU5J7Vu9xLE5Rp');
const SALT = 0x123456789abcdef0n;
const BATCH = 42n;
const INSTR = 1;

const enc = new TextEncoder();
const u16 = (n) => {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n, true);
  return b;
};
const u64 = (n) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
};

const cases = {
  portfolio: PublicKey.findProgramAddressSync([enc.encode('portfolio'), USER.toBytes()], CORE),
  instrument: PublicKey.findProgramAddressSync([enc.encode('instrument'), u16(INSTR)], CORE),
  vault: PublicKey.findProgramAddressSync([enc.encode('vault')], CORE),
  registry: PublicKey.findProgramAddressSync([enc.encode('registry')], CORE),
  batch: PublicKey.findProgramAddressSync([enc.encode('batch'), u64(BATCH)], CORE),
  commitment: PublicKey.findProgramAddressSync([enc.encode('commitment'), u64(BATCH), USER.toBytes(), u64(SALT)], CORE),
  book: PublicKey.findProgramAddressSync([enc.encode('book'), u16(INSTR)], MATCHER),
};

for (const [name, [pk, bump]] of Object.entries(cases)) {
  console.log(`${name}: ${pk.toBase58()} bump=${bump}`);
}
