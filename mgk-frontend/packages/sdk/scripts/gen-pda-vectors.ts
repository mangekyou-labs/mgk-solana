/**
 * One-off: generate seed→pubkey vectors for the pda.test.ts known-vector tests.
 * Run with: pnpm -F @mgk/sdk exec tsx scripts/gen-pda-vectors.ts
 */
import { PublicKey } from '@solana/web3.js';
import {
  deriveBatchPda,
  deriveBookPda,
  deriveCommitmentPda,
  deriveInstrumentPda,
  derivePortfolioPda,
  deriveRegistryPda,
  deriveVaultPda,
} from '../src/pda.js';

const CORE = new PublicKey('CzWqtmcrm6sivjNHfNWhoMJfxP7ibm8KqXXjZpkswXy5');
const MATCHER = new PublicKey('AU4EKQAQupEbMWPK9fuJA7CZqfcjM5Bpgf6Ew9Y7o2FF');
const USER = new PublicKey('A6qbhK9mPRpFhX7D1kZsBpr2xNy8mfgU5J7Vu9xLE5Rp');
const SALT = 0x123456789abcdef0n;
const BATCH = 42n;
const INSTR = 1;

const cases = {
  CORE_PROGRAM: CORE.toBase58(),
  MATCHER_PROGRAM: MATCHER.toBase58(),
  USER: USER.toBase58(),
  SALT: SALT.toString(16),
  BATCH: BATCH.toString(),
  INSTR,
  portfolio: derivePortfolioPda(USER, CORE),
  instrument: deriveInstrumentPda(INSTR, CORE),
  vault: deriveVaultPda(CORE),
  registry: deriveRegistryPda(CORE),
  batch: deriveBatchPda(BATCH, CORE),
  commitment: deriveCommitmentPda(BATCH, USER, SALT, CORE),
  book: deriveBookPda(INSTR, MATCHER),
};

for (const [name, val] of Object.entries(cases)) {
  if (Array.isArray(val)) {
    const [pk, bump] = val;
    console.log(`${name}: ${pk.toBase58()} bump=${bump}`);
  } else {
    console.log(`${name}: ${String(val)}`);
  }
}
