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
//
// 2026-06-29: perps-core was fresh-deployed after closing CThnLgZ
// because that account only held the stale 36-byte placeholder state.

const DEVNET_DEFAULTS = {
  rpcUrl: 'https://solana-devnet.infura.io/v3/0d6f71edfd764dae8eda71f95e3782ce',
  coreProgramId: '3jYQ4mpWBBtwrzYQ4zzKhgqVcWWsG2HpXi9oXTBpekja',
  matcherProgramId: 'AU4EKQAQupEbMWPK9fuJA7CZqfcjM5Bpgf6Ew9Y7o2FF',
  oracleProgramId: '6M9eEiDKy8imbDi44ZqquyfknNbveRjD4j9VnvYaHtmA',
  bookAddress: '5nfbjqTYpsnHnmCifdFpwLwajhyb8n6orVvbMbSrGT6w', // devnet matcher-owned keypair book (no InitializeBook instruction yet)
  vaultAddress: '3FZS8JUn8FGz1CUroGYwrBVHqotaUquJMNnSuBCQxheT', // devnet core-owned keypair vault (Solana 4.x: PDA can't sign createAccount)
  registryAddress: 'F7zWN2XrVqNDBBYqsYpgxHa6AuPK1aQE33kHwM4f8ayV', // devnet core-owned keypair registry (not PDA)
  batchAddress: '', // current batch is keeper-created; prefer /api/batch/current unless explicitly overridden
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
