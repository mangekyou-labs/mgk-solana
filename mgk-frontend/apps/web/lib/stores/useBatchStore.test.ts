// @vitest-environment node
import { PublicKey, type AccountInfo, type Connection } from '@solana/web3.js';
import * as sdk from '@mgk/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useBatchStore, type BatchPollParams } from './useBatchStore';

const CORE_PK = new PublicKey('J5fVjwm96cQxcSqUz4QAmRBT75x7aN9NgG4xcnMmcfSv');
const [REGISTRY_PDA] = sdk.deriveRegistryPda(CORE_PK);

function makeRegistryBuffer(
  batchIdCounter: bigint,
  overrides: Partial<{
    instrumentCount: number;
    volatilityMultiplier: number;
    baseDeposit: bigint;
    nMin: number;
    tMinSlots: bigint;
    tMaxSlots: bigint;
    tRevealSlots: bigint;
    bump: number;
  }> = {},
): Uint8Array {
  const buf = new Uint8Array(96);
  const view = new DataView(buf.buffer);
  // governance: 0..32 (filled zero)
  view.setUint16(32, overrides.instrumentCount ?? 0, true);
  view.setUint16(34, overrides.volatilityMultiplier ?? 10_000, true);
  // #[repr(C)]: governance(32)+instrument_count(2)+volatility(2)+batch_id_counter(8)+base_deposit(8)+n_min(4)+t_min_slots(8)+t_max_slots(8)+t_reveal_slots(8)+bump(1)+pause_flags(1)+padding(4)
  view.setBigUint64(36, batchIdCounter, true);
  view.setBigUint64(44, overrides.baseDeposit ?? 10_000_000n, true);
  view.setUint32(52, overrides.nMin ?? 5, true);
  view.setBigUint64(60, overrides.tMinSlots ?? 10n, true);
  view.setBigUint64(68, overrides.tMaxSlots ?? 150n, true);
  view.setBigUint64(76, overrides.tRevealSlots ?? 25n, true);
  view.setUint8(88, overrides.bump ?? 255);
  return buf;
}

function makeBatchBuffer(batchId: bigint): Uint8Array {
  const buf = new Uint8Array(120);
  const view = new DataView(buf.buffer);
  view.setBigUint64(0, batchId, true);
  view.setUint8(8, sdk.state.BatchStatus.Committing);
  view.setBigUint64(16, 100_000n, true);
  view.setBigUint64(24, 100_100n, true);
  view.setBigUint64(32, 100_200n, true);
  view.setBigUint64(40, 100_300n, true);
  view.setBigInt64(48, 150_000_000n, true);
  view.setUint32(56, 7, true);
  view.setUint32(60, 6, true);
  view.setUint32(64, 5, true);
  view.setBigUint64(72, 9_876_543_210n, true);
  return buf;
}

function makeAccountInfo(data: Uint8Array): AccountInfo<Buffer> {
  return {
    data: Buffer.from(data),
    executable: false,
    lamports: 1_000_000,
    owner: CORE_PK,
    rentEpoch: 0,
  };
}

type Resp = AccountInfo<Buffer> | null | Error;

class MockConnection {
  registryResponses: Resp[] = [];
  batchResponses: Resp[] = [];
  registryCalls: PublicKey[][] = [];
  batchCalls: PublicKey[][] = [];
  private registryIdx = 0;
  private batchIdx = 0;

  async getMultipleAccountsInfo(
    keys: PublicKey[],
  ): Promise<(AccountInfo<Buffer> | null)[]> {
    // Dispatch by PDA: the store always requests the Registry PDA
    // first and the Batch PDA second; we can tell them apart by
    // comparing the first requested key against REGISTRY_PDA and the
    // expected batch PDA (derived from the queued batchIdCounter).
    const first = keys[0];
    if (first && first.equals(REGISTRY_PDA)) {
      this.registryCalls.push(keys);
      const resp = this.registryResponses[this.registryIdx++] ?? null;
      if (resp instanceof Error) throw resp;
      return [resp];
    }
    if (first && this.expectedBatchPda && first.equals(this.expectedBatchPda)) {
      this.batchCalls.push(keys);
      const resp = this.batchResponses[this.batchIdx++] ?? null;
      if (resp instanceof Error) throw resp;
      return [resp];
    }
    return keys.map(() => null);
  }

  // Set by the test before each startPolling call: the Batch PDA the
  // store is expected to request next. Resetting to null between tests
  // prevents cross-test leakage.
  expectedBatchPda: PublicKey | null = null;
}

function buildParams(
  conn: Connection,
  overrides: Partial<BatchPollParams> = {},
): BatchPollParams {
  return {
    connection: conn,
    programId: CORE_PK,
    indexerUrl: '',
    intervalMs: 3000,
    ...overrides,
  };
}

function resetStore() {
  useBatchStore.setState({
    data: null,
    registry: null,
    currentBatchId: null,
    loading: false,
    error: null,
    lastFetchedAt: null,
    isPolling: false,
  });
  useBatchStore.getState().stopPolling();
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('useBatchStore', () => {
  beforeEach(() => {
    resetStore();
  });
  afterEach(() => {
    useBatchStore.getState().stopPolling();
  });

  it('reads Registry, resolves the active Batch account, and decodes the batch', async () => {
    const conn = new MockConnection();
    conn.expectedBatchPda = sdk.deriveBatchPda(41n, CORE_PK)[0];
    conn.registryResponses = [makeAccountInfo(makeRegistryBuffer(42n))];
    conn.batchResponses = [makeAccountInfo(makeBatchBuffer(41n))];

    await useBatchStore.getState().startPolling(
      buildParams(conn as unknown as Connection, { intervalMs: 50 }),
    );

    const state = useBatchStore.getState();
    expect(state.isPolling).toBe(true);
    expect(state.currentBatchId).toBe(41n);
    expect(state.registry?.batchIdCounter).toBe(42n);
    expect(state.data?.batchId).toBe(41n);
    expect(state.data?.status).toBe(sdk.state.BatchStatus.Committing);
    expect(state.error).toBeNull();
    // Two separate RPC calls: one for registry, one for batch.
    expect(conn.registryCalls.length).toBe(1);
    expect(conn.batchCalls.length).toBe(1);
  });

  it('handles batchIdCounter=0 (no batches created yet) — no batch fetch, no error', async () => {
    const conn = new MockConnection();
    conn.registryResponses = [makeAccountInfo(makeRegistryBuffer(0n))];

    await useBatchStore.getState().startPolling(
      buildParams(conn as unknown as Connection, { intervalMs: 50 }),
    );

    const state = useBatchStore.getState();
    expect(state.currentBatchId).toBe(0n);
    expect(state.registry?.batchIdCounter).toBe(0n);
    expect(state.data).toBeNull();
    expect(state.error).toBeNull();
    expect(conn.batchCalls.length).toBe(0);
  });

  it('handles Registry account missing — clears data, no error', async () => {
    const conn = new MockConnection();
    conn.registryResponses = [null];

    await useBatchStore.getState().startPolling(
      buildParams(conn as unknown as Connection, { intervalMs: 50 }),
    );

    const state = useBatchStore.getState();
    expect(state.registry).toBeNull();
    expect(state.data).toBeNull();
    expect(state.currentBatchId).toBeNull();
    expect(state.error).toBeNull();
    expect(conn.batchCalls.length).toBe(0);
  });

  it('handles active Batch account missing (counter > 0 but batch account uninitialized) — no error', async () => {
    const conn = new MockConnection();
    conn.expectedBatchPda = sdk.deriveBatchPda(6n, CORE_PK)[0];
    conn.registryResponses = [makeAccountInfo(makeRegistryBuffer(7n))];
    conn.batchResponses = [null];

    await useBatchStore.getState().startPolling(
      buildParams(conn as unknown as Connection, { intervalMs: 50 }),
    );

    const state = useBatchStore.getState();
    expect(state.registry?.batchIdCounter).toBe(7n);
    expect(state.currentBatchId).toBe(6n);
    expect(state.data).toBeNull();
    expect(state.error).toBeNull();
  });

  it('captures errors from getMultipleAccountsInfo on the registry call', async () => {
    const conn = new MockConnection();
    conn.registryResponses = [new Error('RPC timeout')];

    await useBatchStore.getState().startPolling(
      buildParams(conn as unknown as Connection, { intervalMs: 50 }),
    );

    const state = useBatchStore.getState();
    expect(state.data).toBeNull();
    expect(state.error).toMatch(/RPC timeout/);
    expect(state.loading).toBe(false);
  });

  it('captures errors from decodeBatch (truncated buffer)', async () => {
    const conn = new MockConnection();
    conn.expectedBatchPda = sdk.deriveBatchPda(2n, CORE_PK)[0];
    conn.registryResponses = [makeAccountInfo(makeRegistryBuffer(3n))];
    const short = new Uint8Array(64); // < BATCH_SIZE
    conn.batchResponses = [makeAccountInfo(short)];

    await useBatchStore.getState().startPolling(
      buildParams(conn as unknown as Connection, { intervalMs: 50 }),
    );

    const state = useBatchStore.getState();
    expect(state.data).toBeNull();
    expect(state.error).toMatch(/buffer too small/);
  });

  it('fires a refresh on every interval tick (Registry + Batch each tick)', async () => {
    const conn = new MockConnection();
    conn.expectedBatchPda = sdk.deriveBatchPda(10n, CORE_PK)[0];
    conn.registryResponses = Array.from({ length: 20 }, () =>
      makeAccountInfo(makeRegistryBuffer(11n)),
    );
    conn.batchResponses = Array.from({ length: 20 }, () =>
      makeAccountInfo(makeBatchBuffer(10n)),
    );

    await useBatchStore.getState().startPolling(
      buildParams(conn as unknown as Connection, { intervalMs: 25 }),
    );
    expect(conn.registryCalls.length).toBe(1);
    expect(conn.batchCalls.length).toBe(1);

    await wait(120);
    expect(conn.registryCalls.length).toBeGreaterThanOrEqual(5);
    expect(conn.batchCalls.length).toBeGreaterThanOrEqual(5);
  });

  it('stops polling: clears the interval and flips isPolling off', async () => {
    const conn = new MockConnection();
    conn.expectedBatchPda = sdk.deriveBatchPda(0n, CORE_PK)[0];
    conn.registryResponses = Array.from({ length: 100 }, () =>
      makeAccountInfo(makeRegistryBuffer(1n)),
    );
    conn.batchResponses = Array.from({ length: 100 }, () =>
      makeAccountInfo(makeBatchBuffer(0n)),
    );

    await useBatchStore.getState().startPolling(
      buildParams(conn as unknown as Connection, { intervalMs: 20 }),
    );
    expect(useBatchStore.getState().isPolling).toBe(true);

    useBatchStore.getState().stopPolling();
    expect(useBatchStore.getState().isPolling).toBe(false);

    const callsAfterStop = conn.registryCalls.length;
    await wait(100);
    expect(conn.registryCalls.length).toBe(callsAfterStop);
  });

  it('startPolling replaces any in-flight poll (no leaked intervals)', async () => {
    const conn1 = new MockConnection();
    conn1.expectedBatchPda = sdk.deriveBatchPda(0n, CORE_PK)[0];
    conn1.registryResponses = Array.from({ length: 100 }, () =>
      makeAccountInfo(makeRegistryBuffer(1n)),
    );
    conn1.batchResponses = Array.from({ length: 100 }, () =>
      makeAccountInfo(makeBatchBuffer(0n)),
    );
    const conn2 = new MockConnection();
    conn2.expectedBatchPda = sdk.deriveBatchPda(1n, CORE_PK)[0];
    conn2.registryResponses = Array.from({ length: 100 }, () =>
      makeAccountInfo(makeRegistryBuffer(2n)),
    );
    conn2.batchResponses = Array.from({ length: 100 }, () =>
      makeAccountInfo(makeBatchBuffer(1n)),
    );

    await useBatchStore.getState().startPolling(
      buildParams(conn1 as unknown as Connection, { intervalMs: 20 }),
    );
    const calls1 = conn1.registryCalls.length;
    expect(calls1).toBe(1);

    await useBatchStore.getState().startPolling(
      buildParams(conn2 as unknown as Connection, { intervalMs: 20 }),
    );
    expect(conn1.registryCalls.length).toBe(calls1);

    await wait(150);
    expect(conn1.registryCalls.length).toBe(calls1);
    expect(conn2.registryCalls.length).toBeGreaterThan(calls1);
  });

  it('refresh is a no-op when no polling is active', async () => {
    const conn = new MockConnection();
    await useBatchStore.getState().refresh();
    expect(conn.registryCalls.length).toBe(0);
    expect(conn.batchCalls.length).toBe(0);
    expect(useBatchStore.getState().loading).toBe(false);
  });
});
