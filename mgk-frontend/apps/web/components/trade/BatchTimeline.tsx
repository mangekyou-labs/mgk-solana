'use client';

import { useCallback, useMemo, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import {
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import * as sdk from '@mgk/sdk';

import { Pill } from '@/components/common/Pill';
import { useBatchPolling } from '@/lib/stores/useBatchStore';
import { useSlotPolling } from '@/lib/stores/useSlotPolling';
import { useDevtools } from '@/lib/hooks/useDevtools';
import { config } from '@/lib/config';
import { resolveRegistryAddress } from '@/lib/onchainAccounts';
import {
  PHASE_LABEL,
  PHASE_TONE,
  deriveDeadline,
  formatBatchCountdown,
  isPastActionDeadline,
} from '@/lib/trade/batchDisplay';

export function BatchTimeline() {
  const { data, registry, currentBatchId } = useBatchPolling(3000);
  const { slot: currentSlot } = useSlotPolling(1000);
  const devtools = useDevtools();
  const { publicKey, sendTransaction, connected } = useWallet();
  const { connection } = useConnection();
  const [cranking, setCranking] = useState(false);
  const [crankError, setCrankError] = useState<string | null>(null);

  const { deadline, isPastDeadline, deadlineLabel } = useMemo(() => {
    if (!data) return { deadline: null, isPastDeadline: false, deadlineLabel: '' };
    const info = deriveDeadline(data.status, data, currentSlot);
    return {
      ...info,
      isPastDeadline: isPastActionDeadline(data.status, data, currentSlot, registry),
    };
  }, [data, currentSlot, registry]);

  const countdown = useMemo(() => {
    if (!data || deadline == null || currentSlot == null) return '—';
    return formatBatchCountdown(data.status, data, currentSlot, registry);
  }, [data, deadline, currentSlot, registry]);

  const handleCrank = useCallback(async () => {
    if (!publicKey || !currentBatchId || !data) return;
    setCranking(true);
    setCrankError(null);
    try {
      // DFBA: batches are PDAs (or config override). Prefer configured address.
      const batchPda =
        config.batchAddress ??
        sdk.deriveBatchPda(currentBatchId, config.coreProgramId)[0];
      const registryPda = resolveRegistryAddress(config.coreProgramId);
      // CloseCollecting (disc 6): [writable] batch, [] registry
      const ix = new TransactionInstruction({
        programId: config.coreProgramId,
        keys: [
          { pubkey: batchPda, isSigner: false, isWritable: true },
          { pubkey: registryPda, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(sdk.programs.encodeCloseCommitting()),
      });
      const tx = new Transaction().add(ix);
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, 'confirmed');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setCrankError(msg);
      console.error('[BatchTimeline] crank failed:', e);
    } finally {
      setCranking(false);
    }
  }, [publicKey, currentBatchId, data, sendTransaction, connection]);

  if (!data) {
    return (
      <div
        data-testid="batch-timeline"
        data-state="no-data"
        className="flex items-center gap-2 border-b border-border bg-surface-1 px-4 py-2"
      >
        <Pill tone="neutral">Batch: —</Pill>
        <span className="text-xs text-text-muted">awaiting batch state…</span>
      </div>
    );
  }

  const phaseLabel = PHASE_LABEL[data.status];
  const phaseTone = PHASE_TONE[data.status];
  // Dev-only: ?devtools=1 + connected wallet + past the current
  // phase's deadline. T2.8 will add encodeClearBatch / encodeSettleBatch
  // so this can become state-aware (Crank → next phase, regardless of
  // which phase we're in).
  const showCrank = devtools && isPastDeadline && connected;

  return (
    <div
      data-testid="batch-timeline"
      data-state={phaseLabel.toLowerCase()}
      data-past-deadline={isPastDeadline ? 'true' : 'false'}
      className="flex items-center gap-2 border-b border-border bg-surface-1 px-4 py-2"
    >
      <Pill tone={phaseTone}>Batch: {phaseLabel}</Pill>
      <span
        className="font-mono text-xs tabular-nums text-text"
        data-testid="batch-countdown"
      >
        {countdown}
      </span>
      {deadlineLabel && !isPastDeadline && (
        <span className="text-xs text-text-muted">to {deadlineLabel}</span>
      )}
      {isPastDeadline && data.status !== sdk.state.BatchStatus.Settled && (
        <span
          className="text-xs text-warn"
          data-testid="batch-past-deadline"
        >
          {deadlineLabel} passed
        </span>
      )}
      {showCrank && (
        <button
          type="button"
          onClick={handleCrank}
          disabled={cranking}
          data-testid="crank-button"
          className="ml-auto rounded border border-accent/40 bg-surface-2 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-accent hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {cranking ? 'Cranking…' : 'Crank'}
        </button>
      )}
      {crankError && (
        <span
          className="text-xs text-bear"
          data-testid="crank-error"
          role="alert"
        >
          {crankError}
        </span>
      )}
    </div>
  );
}
