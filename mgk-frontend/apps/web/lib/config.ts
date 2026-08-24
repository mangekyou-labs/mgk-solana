import { PublicKey } from '@solana/web3.js';

// Devnet defaults — M9 DFBA deploy (2026-08-06).
// Program IDs match `programs/common/src/program_ids.rs`.
// Registry/vault are core PDAs; book is a matcher-owned keypair account
// (27_704 B BookState — CPI create is 10KB-capped, so client-side create).
// See `docs/ai/deployment/2026-08-06-devnet-deploy-m9.md`.

const DEVNET_DEFAULTS = {
  rpcUrl: 'https://api.devnet.solana.com',
  coreProgramId: 'C7w2mKz2KQgDroNNhACm9MutXhPiesVr9Gn2x8TDsRYx',
  matcherProgramId: '7WiZuunbPGciCedsVTguvjezwwzrhmXG5HkdCuHizbNC',
  oracleProgramId: 'CsSqVZMoXixNYstNhTtixeT4pyRgrYnXdpfoXQBgFPqZ',
  // Matcher-owned keypair book (persisted at ~/.config/solana/mgk-book-keypair.json)
  bookAddress: 'J33Y6yo6AZM6JKLEw89tN1kPmyEADqWWjGxb1aAW915j',
  // Core PDAs (["vault"], ["registry"])
  vaultAddress: '9qe7TkRxDXHo3dywPKiiY1jwSBnFuSPHmGTWhcP8ttXE',
  registryAddress: 'CbsfrRS2rYE2qgJbi7MM6mLzARUy8cDiYmHW2o12jYJA',
  // Prefer indexer /api/batch/current or PDA derive from registry counter
  batchAddress: '',
  indexerUrl: 'http://localhost:4000',
  hermesUrl: 'https://hermes.pyth.network',
  // Pyth feed IDs (Hermes content-addressed, same across all networks)
  pythBtcFeedId: 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  pythEthFeedId: 'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  pythSolFeedId: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
} as const;

function parsePkOrThrow(raw: string, envName: string): PublicKey {
  try {
    return new PublicKey(raw);
  } catch {
    throw new Error(
      `[mgk config] ${envName} is not a valid base58 public key: "${raw}"`,
    );
  }
}

// Each NEXT_PUBLIC_* var must be accessed via a direct process.env property
// read (not through a wrapper function) so that Turbopack can statically
// replace them at build time.  Dynamic lookups like process.env[name] are
// not statically analysable and fall through to a runtime polyfill that
// returns undefined — causing the fallback to always win.
const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL || DEVNET_DEFAULTS.rpcUrl;
const coreProgramId = parsePkOrThrow(
  process.env.NEXT_PUBLIC_CORE_PROGRAM_ID || DEVNET_DEFAULTS.coreProgramId,
  'NEXT_PUBLIC_CORE_PROGRAM_ID',
);
const matcherProgramId = parsePkOrThrow(
  process.env.NEXT_PUBLIC_MATCHER_PROGRAM_ID || DEVNET_DEFAULTS.matcherProgramId,
  'NEXT_PUBLIC_MATCHER_PROGRAM_ID',
);
const oracleProgramId = parsePkOrThrow(
  process.env.NEXT_PUBLIC_ORACLE_PROGRAM_ID || DEVNET_DEFAULTS.oracleProgramId,
  'NEXT_PUBLIC_ORACLE_PROGRAM_ID',
);
const bookAddressRaw = process.env.NEXT_PUBLIC_BOOK_ADDRESS || DEVNET_DEFAULTS.bookAddress || '';
const bookAddress = bookAddressRaw ? parsePkOrThrow(bookAddressRaw, 'NEXT_PUBLIC_BOOK_ADDRESS') : null;
const vaultAddressRaw = process.env.NEXT_PUBLIC_VAULT_ADDRESS || DEVNET_DEFAULTS.vaultAddress || '';
const vaultAddress = vaultAddressRaw ? parsePkOrThrow(vaultAddressRaw, 'NEXT_PUBLIC_VAULT_ADDRESS') : null;
const registryAddressRaw = process.env.NEXT_PUBLIC_REGISTRY_ADDRESS || DEVNET_DEFAULTS.registryAddress || '';
const registryAddress = registryAddressRaw ? parsePkOrThrow(registryAddressRaw, 'NEXT_PUBLIC_REGISTRY_ADDRESS') : null;
const batchAddressRaw = process.env.NEXT_PUBLIC_BATCH_ADDRESS || DEVNET_DEFAULTS.batchAddress || '';
const batchAddress = batchAddressRaw ? parsePkOrThrow(batchAddressRaw, 'NEXT_PUBLIC_BATCH_ADDRESS') : null;
const indexerUrl = process.env.NEXT_PUBLIC_INDEXER_URL || DEVNET_DEFAULTS.indexerUrl;
const hermesUrl = process.env.NEXT_PUBLIC_HERMES_URL || DEVNET_DEFAULTS.hermesUrl;

export const config = {
  rpcUrl,
  coreProgramId,
  matcherProgramId,
  oracleProgramId,
  bookAddress,
  vaultAddress,
  registryAddress,
  batchAddress,
  indexerUrl,
  hermesUrl,
  pythBtcFeedId: DEVNET_DEFAULTS.pythBtcFeedId,
  pythEthFeedId: DEVNET_DEFAULTS.pythEthFeedId,
  pythSolFeedId: DEVNET_DEFAULTS.pythSolFeedId,
} as const;

export type AppConfig = typeof config;
