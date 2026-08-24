import { PublicKey } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// M9 DFBA deploy (2026-08-06) — must match lib/config.ts DEVNET_DEFAULTS
const CORE_DEVNET = 'C7w2mKz2KQgDroNNhACm9MutXhPiesVr9Gn2x8TDsRYx';
const MATCHER_DEVNET = '7WiZuunbPGciCedsVTguvjezwwzrhmXG5HkdCuHizbNC';
const ORACLE_DEVNET = 'CsSqVZMoXixNYstNhTtixeT4pyRgrYnXdpfoXQBgFPqZ';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const BOOK_DEVNET = 'J33Y6yo6AZM6JKLEw89tN1kPmyEADqWWjGxb1aAW915j';
const VAULT_DEVNET = '9qe7TkRxDXHo3dywPKiiY1jwSBnFuSPHmGTWhcP8ttXE';
const REGISTRY_DEVNET = 'CbsfrRS2rYE2qgJbi7MM6mLzARUy8cDiYmHW2o12jYJA';

describe('config', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('exposes the devnet defaults when no env vars are set', async () => {
    const { config } = await import('./config');
    expect(config.coreProgramId.toBase58()).toBe(CORE_DEVNET);
    expect(config.matcherProgramId.toBase58()).toBe(MATCHER_DEVNET);
    expect(config.oracleProgramId.toBase58()).toBe(ORACLE_DEVNET);
    expect(config.rpcUrl).toContain('devnet');
    expect(config.indexerUrl).toBe('http://localhost:4000');
  });

  it('returns PublicKey instances (not strings) for program IDs', async () => {
    const { config } = await import('./config');
    expect(config.coreProgramId).toBeInstanceOf(PublicKey);
    expect(config.matcherProgramId).toBeInstanceOf(PublicKey);
    expect(config.oracleProgramId).toBeInstanceOf(PublicKey);
  });

  it('defaults bookAddress to the devnet keypair book address', async () => {
    const { config } = await import('./config');
    expect(config.bookAddress).toBeInstanceOf(PublicKey);
    expect(config.bookAddress!.toBase58()).toBe(BOOK_DEVNET);
  });

  it('reads NEXT_PUBLIC_BOOK_ADDRESS override as a PublicKey', async () => {
    vi.stubEnv('NEXT_PUBLIC_BOOK_ADDRESS', SYSTEM_PROGRAM);
    const { config } = await import('./config');
    expect(config.bookAddress).toBeInstanceOf(PublicKey);
    expect(config.bookAddress!.toBase58()).toBe(SYSTEM_PROGRAM);
  });

  it('treats an empty NEXT_PUBLIC_BOOK_ADDRESS as unset (falls back to default)', async () => {
    vi.stubEnv('NEXT_PUBLIC_BOOK_ADDRESS', '');
    const { config } = await import('./config');
    expect(config.bookAddress!.toBase58()).toBe(BOOK_DEVNET);
  });

  it('defaults vaultAddress to the devnet keypair vault address', async () => {
    const { config } = await import('./config');
    expect(config.vaultAddress).toBeInstanceOf(PublicKey);
    expect(config.vaultAddress!.toBase58()).toBe(VAULT_DEVNET);
  });

  it('defaults registryAddress to the devnet keypair registry address', async () => {
    const { config } = await import('./config');
    expect(config.registryAddress).toBeInstanceOf(PublicKey);
    expect(config.registryAddress!.toBase58()).toBe(REGISTRY_DEVNET);
  });

  it('defaults batchAddress to null (derive from registry counter / indexer)', async () => {
    const { config } = await import('./config');
    expect(config.batchAddress).toBeNull();
  });

  it('reads NEXT_PUBLIC_VAULT_ADDRESS override as a PublicKey', async () => {
    vi.stubEnv('NEXT_PUBLIC_VAULT_ADDRESS', SYSTEM_PROGRAM);
    const { config } = await import('./config');
    expect(config.vaultAddress!.toBase58()).toBe(SYSTEM_PROGRAM);
  });

  it('reads NEXT_PUBLIC_REGISTRY_ADDRESS override as a PublicKey', async () => {
    vi.stubEnv('NEXT_PUBLIC_REGISTRY_ADDRESS', SYSTEM_PROGRAM);
    const { config } = await import('./config');
    expect(config.registryAddress!.toBase58()).toBe(SYSTEM_PROGRAM);
  });

  it('reads NEXT_PUBLIC_BATCH_ADDRESS override as a PublicKey', async () => {
    vi.stubEnv('NEXT_PUBLIC_BATCH_ADDRESS', SYSTEM_PROGRAM);
    const { config } = await import('./config');
    expect(config.batchAddress!.toBase58()).toBe(SYSTEM_PROGRAM);
  });

  it('reads NEXT_PUBLIC_RPC_URL override', async () => {
    vi.stubEnv('NEXT_PUBLIC_RPC_URL', 'https://my-rpc.example.com');
    const { config } = await import('./config');
    expect(config.rpcUrl).toBe('https://my-rpc.example.com');
  });

  it('reads NEXT_PUBLIC_CORE_PROGRAM_ID override', async () => {
    vi.stubEnv('NEXT_PUBLIC_CORE_PROGRAM_ID', SYSTEM_PROGRAM);
    const { config } = await import('./config');
    expect(config.coreProgramId.toBase58()).toBe(SYSTEM_PROGRAM);
  });

  it('reads NEXT_PUBLIC_MATCHER_PROGRAM_ID override', async () => {
    vi.stubEnv('NEXT_PUBLIC_MATCHER_PROGRAM_ID', SYSTEM_PROGRAM);
    const { config } = await import('./config');
    expect(config.matcherProgramId.toBase58()).toBe(SYSTEM_PROGRAM);
  });

  it('reads NEXT_PUBLIC_ORACLE_PROGRAM_ID override', async () => {
    vi.stubEnv('NEXT_PUBLIC_ORACLE_PROGRAM_ID', SYSTEM_PROGRAM);
    const { config } = await import('./config');
    expect(config.oracleProgramId.toBase58()).toBe(SYSTEM_PROGRAM);
  });

  it('reads NEXT_PUBLIC_INDEXER_URL override', async () => {
    vi.stubEnv('NEXT_PUBLIC_INDEXER_URL', 'https://indexer.example.com');
    const { config } = await import('./config');
    expect(config.indexerUrl).toBe('https://indexer.example.com');
  });

  it('treats an empty env var as unset and falls back to the default', async () => {
    vi.stubEnv('NEXT_PUBLIC_RPC_URL', '');
    const { config } = await import('./config');
    expect(config.rpcUrl).toContain('devnet');
  });

  it('throws a descriptive error when NEXT_PUBLIC_CORE_PROGRAM_ID is invalid', async () => {
    vi.stubEnv('NEXT_PUBLIC_CORE_PROGRAM_ID', 'not-a-pubkey');
    await expect(import('./config')).rejects.toThrow(/NEXT_PUBLIC_CORE_PROGRAM_ID/);
  });

  it('throws a descriptive error when NEXT_PUBLIC_MATCHER_PROGRAM_ID is invalid', async () => {
    vi.stubEnv('NEXT_PUBLIC_MATCHER_PROGRAM_ID', '!!!');
    await expect(import('./config')).rejects.toThrow(/NEXT_PUBLIC_MATCHER_PROGRAM_ID/);
  });

  it('throws a descriptive error when NEXT_PUBLIC_ORACLE_PROGRAM_ID is invalid', async () => {
    vi.stubEnv('NEXT_PUBLIC_ORACLE_PROGRAM_ID', '!!!');
    await expect(import('./config')).rejects.toThrow(/NEXT_PUBLIC_ORACLE_PROGRAM_ID/);
  });
});
