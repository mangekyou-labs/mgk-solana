import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import {
  SEEDS,
  deriveBatchPda,
  deriveBookPda,
  deriveCommitmentPda,
  deriveInstrumentPda,
  derivePortfolioPda,
  deriveRegistryPda,
  deriveVaultPda,
} from './pda.js';

const CORE = new PublicKey('J5fVjwm96cQxcSqUz4QAmRBT75x7aN9NgG4xcnMmcfSv');
const MATCHER = new PublicKey('AU4EKQAQupEbMWPK9fuJA7CZqfcjM5Bpgf6Ew9Y7o2FF');
const USER = new PublicKey('A6qbhK9mPRpFhX7D1kZsBpr2xNy8mfgU5J7Vu9xLE5Rp');
const SALT = 0x123456789abcdef0n;
const BATCH = 42n;
const INSTR = 1;

describe('SEEDS', () => {
  it('matches the Rust PDA seed constants', () => {
    expect(SEEDS.PORTFOLIO).toBe('portfolio');
    expect(SEEDS.INSTRUMENT).toBe('instrument');
    expect(SEEDS.VAULT).toBe('vault');
    expect(SEEDS.REGISTRY).toBe('registry');
    expect(SEEDS.BATCH).toBe('batch');
    expect(SEEDS.COMMITMENT).toBe('commitment');
    expect(SEEDS.BOOK).toBe('book');
  });
});

describe('derivePortfolioPda', () => {
  it('matches the known vector for (USER, CORE)', () => {
    const [pk, bump] = derivePortfolioPda(USER, CORE);
    expect(pk.toBase58()).toBe('3oXr8bQ8XhvtGJpmfxiJPgAjbVincwtQ1oGVbs2Y69mH');
    expect(bump).toBe(255);
  });

  it('is deterministic for the same input', () => {
    const [a] = derivePortfolioPda(USER, CORE);
    const [b] = derivePortfolioPda(USER, CORE);
    expect(a.toBase58()).toBe(b.toBase58());
  });

  it('changes when user changes', () => {
    const [a] = derivePortfolioPda(USER, CORE);
    const [b] = derivePortfolioPda(PublicKey.unique(), CORE);
    expect(a.toBase58()).not.toBe(b.toBase58());
  });
});

describe('deriveInstrumentPda', () => {
  it('matches the known vector for (INSTR=1, CORE)', () => {
    const [pk, bump] = deriveInstrumentPda(INSTR, CORE);
    expect(pk.toBase58()).toBe('6YyY1w4vzXC8MTq8BqGeeiyEGGR27XuyPyFz11KBrWYm');
    expect(bump).toBe(254);
  });

  it('changes when instrument id changes', () => {
    const [a] = deriveInstrumentPda(1, CORE);
    const [b] = deriveInstrumentPda(2, CORE);
    expect(a.toBase58()).not.toBe(b.toBase58());
  });
});

describe('deriveVaultPda', () => {
  it('matches the known vector for CORE', () => {
    const [pk, bump] = deriveVaultPda(CORE);
    expect(pk.toBase58()).toBe('5uzb4tEfDicoioE64ucvmyafWVwaURazYtPpasX7Zjah');
    expect(bump).toBe(252);
  });

  it('changes when program id changes', () => {
    const [a] = deriveVaultPda(CORE);
    const [b] = deriveVaultPda(MATCHER);
    expect(a.toBase58()).not.toBe(b.toBase58());
  });
});

describe('deriveRegistryPda', () => {
  it('matches the known vector for CORE', () => {
    const [pk, bump] = deriveRegistryPda(CORE);
    expect(pk.toBase58()).toBe('5NCK5ACLtFjANfGtZfqWRzDJhnPQGvEgJn7nLiMzuasv');
    expect(bump).toBe(252);
  });
});

describe('deriveBatchPda', () => {
  it('matches the known vector for (BATCH=42, CORE)', () => {
    const [pk, bump] = deriveBatchPda(BATCH, CORE);
    expect(pk.toBase58()).toBe('GLLshEaXwfkFc9ZouHdyDrQnSCtTMrTKKbZEgNVMbnBU');
    expect(bump).toBe(255);
  });

  it('changes when batch id changes', () => {
    const [a] = deriveBatchPda(42n, CORE);
    const [b] = deriveBatchPda(43n, CORE);
    expect(a.toBase58()).not.toBe(b.toBase58());
  });
});

describe('deriveCommitmentPda', () => {
  it('matches the known vector for (BATCH=42, USER, SALT, CORE)', () => {
    const [pk, bump] = deriveCommitmentPda(BATCH, USER, SALT, CORE);
    expect(pk.toBase58()).toBe('7acgCNhK481amg2M28gE6GoFE2NY65WhTSYpQkLJKREV');
    expect(bump).toBe(253);
  });

  it('changes when salt changes', () => {
    const [a] = deriveCommitmentPda(BATCH, USER, 1n, CORE);
    const [b] = deriveCommitmentPda(BATCH, USER, 2n, CORE);
    expect(a.toBase58()).not.toBe(b.toBase58());
  });

  it('changes when batch id changes', () => {
    const [a] = deriveCommitmentPda(42n, USER, SALT, CORE);
    const [b] = deriveCommitmentPda(43n, USER, SALT, CORE);
    expect(a.toBase58()).not.toBe(b.toBase58());
  });

  it('changes when user changes', () => {
    const [a] = deriveCommitmentPda(BATCH, USER, SALT, CORE);
    const [b] = deriveCommitmentPda(BATCH, PublicKey.unique(), SALT, CORE);
    expect(a.toBase58()).not.toBe(b.toBase58());
  });
});

describe('deriveBookPda', () => {
  it('matches the known vector for (INSTR=1, MATCHER)', () => {
    const [pk, bump] = deriveBookPda(INSTR, MATCHER);
    expect(pk.toBase58()).toBe('B9JLeQmYzuMxjA2Tv3R4xiERcNVR8AbNde1WEL3tzsgd');
    expect(bump).toBe(255);
  });

  it('uses the matcher program id (not core)', () => {
    // Same seeds but different program id should yield different addresses.
    const [bookOnMatcher] = deriveBookPda(INSTR, MATCHER);
    const [bookOnCore] = deriveBookPda(INSTR, CORE);
    expect(bookOnMatcher.toBase58()).not.toBe(bookOnCore.toBase58());
  });
});
