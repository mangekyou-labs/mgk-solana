import { PublicKey } from '@solana/web3.js';

export const SEEDS = {
  PORTFOLIO: 'portfolio',
  INSTRUMENT: 'instrument',
  VAULT: 'vault',
  REGISTRY: 'registry',
  BATCH: 'batch',
  COMMITMENT: 'commitment',
  BOOK: 'book',
} as const;

function seedBytes(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'utf-8'));
}

function u16Le(value: number): Uint8Array {
  const buf = new Uint8Array(2);
  new DataView(buf.buffer).setUint16(0, value, true);
  return buf;
}

function u64Le(value: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, value, true);
  return buf;
}

export function derivePortfolioPda(
  user: PublicKey,
  programId: PublicKey,
): readonly [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [seedBytes(SEEDS.PORTFOLIO), user.toBytes()],
    programId,
  );
}

export function deriveInstrumentPda(
  instrumentId: number,
  programId: PublicKey,
): readonly [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [seedBytes(SEEDS.INSTRUMENT), u16Le(instrumentId)],
    programId,
  );
}

export function deriveVaultPda(
  programId: PublicKey,
): readonly [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [seedBytes(SEEDS.VAULT)],
    programId,
  );
}

export function deriveRegistryPda(
  programId: PublicKey,
): readonly [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [seedBytes(SEEDS.REGISTRY)],
    programId,
  );
}

export function deriveBatchPda(
  batchId: bigint,
  programId: PublicKey,
): readonly [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [seedBytes(SEEDS.BATCH), u64Le(batchId)],
    programId,
  );
}

export function deriveCommitmentPda(
  batchId: bigint,
  user: PublicKey,
  salt: bigint,
  programId: PublicKey,
): readonly [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      seedBytes(SEEDS.COMMITMENT),
      u64Le(batchId),
      user.toBytes(),
      u64Le(salt),
    ],
    programId,
  );
}

export function deriveBookPda(
  instrumentId: number,
  programId: PublicKey,
): readonly [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [seedBytes(SEEDS.BOOK), u16Le(instrumentId)],
    programId,
  );
}
