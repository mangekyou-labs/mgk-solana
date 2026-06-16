import { PublicKey, clusterApiUrl } from '@solana/web3.js';

// Devnet defaults — sourced from `.superstack/build-context.md` and
// `programs/common/src/program_ids.rs`. The core, matcher, and oracle IDs
// are the real deployed devnet pubkeys (see
// `programs/perps-core/tests/lifecycle.rs:36-38`).
//
// 2026-06-16: matcher ID changed from the broken canonical
// `9o2vTBBhEp6CYxNsDPsX79Euhzh8TtoLTSHR5R3jJebZ` (3 deploy txs finalized
// but account never appeared on devnet) to
// `AU4EKQAQupEbMWPK9fuJA7CZqfcjM5Bpgf6Ew9Y7o2FF`. The old keypair is
// backed up at /tmp/matcher-keypair-BROKEN-ID.json in case the canonical
// ID is reclaimable later. Oracle deployed at
// `6M9eEiDKy8imbDi44ZqquyfknNbveRjD4j9VnvYaHtmA` (was System Program
// placeholder).
const DEVNET_DEFAULTS = {
  rpcUrl: clusterApiUrl('devnet'),
  coreProgramId: 'DBrCzAMAJhxnPRQnBzEZGMhSALGfvQDDe6xEn2nU1uar',
  matcherProgramId: 'AU4EKQAQupEbMWPK9fuJA7CZqfcjM5Bpgf6Ew9Y7o2FF',
  oracleProgramId: '6M9eEiDKy8imbDi44ZqquyfknNbveRjD4j9VnvYaHtmA',
  indexerUrl: 'http://localhost:4000',
} as const;

function readEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw && raw.length > 0 ? raw : fallback;
}

function parsePkOrThrow(raw: string, envName: string): PublicKey {
  try {
    return new PublicKey(raw);
  } catch {
    throw new Error(
      `[mgk config] ${envName} is not a valid base58 public key: "${raw}"`,
    );
  }
}

const rpcUrl = readEnv('NEXT_PUBLIC_RPC_URL', DEVNET_DEFAULTS.rpcUrl);
const coreProgramId = parsePkOrThrow(
  readEnv('NEXT_PUBLIC_CORE_PROGRAM_ID', DEVNET_DEFAULTS.coreProgramId),
  'NEXT_PUBLIC_CORE_PROGRAM_ID',
);
const matcherProgramId = parsePkOrThrow(
  readEnv('NEXT_PUBLIC_MATCHER_PROGRAM_ID', DEVNET_DEFAULTS.matcherProgramId),
  'NEXT_PUBLIC_MATCHER_PROGRAM_ID',
);
const oracleProgramId = parsePkOrThrow(
  readEnv('NEXT_PUBLIC_ORACLE_PROGRAM_ID', DEVNET_DEFAULTS.oracleProgramId),
  'NEXT_PUBLIC_ORACLE_PROGRAM_ID',
);
const indexerUrl = readEnv('NEXT_PUBLIC_INDEXER_URL', DEVNET_DEFAULTS.indexerUrl);

export const config = {
  rpcUrl,
  coreProgramId,
  matcherProgramId,
  oracleProgramId,
  indexerUrl,
} as const;

export type AppConfig = typeof config;
