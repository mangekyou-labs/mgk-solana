import { PublicKey } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CORE_DEVNET = 'CzWqtmcrm6sivjNHfNWhoMJfxP7ibm8KqXXjZpkswXy5';
const MATCHER_DEVNET = 'AU4EKQAQupEbMWPK9fuJA7CZqfcjM5Bpgf6Ew9Y7o2FF';
const ORACLE_DEVNET = '6M9eEiDKy8imbDi44ZqquyfknNbveRjD4j9VnvYaHtmA';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

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
