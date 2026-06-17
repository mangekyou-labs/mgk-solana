import { describe, expect, it } from 'vitest';
import * as sdk from '@mgk/sdk';

import {
  PHASE_LABEL,
  PHASE_TONE,
  deriveDeadline,
  formatSlotDuration,
  type DeadlineInfo,
} from './batchDisplay';

function makeBatchData(
  status: sdk.state.BatchStatus,
  overrides: Partial<{
    commitDeadlineSlot: bigint;
    revealDeadlineSlot: bigint;
    closeSlot: bigint;
  }> = {},
): sdk.state.BatchState {
  return {
    batchId: 7n,
    status,
    commitDeadlineSlot: overrides.commitDeadlineSlot ?? 100_000n,
    revealDeadlineSlot: overrides.revealDeadlineSlot ?? 100_100n,
    closeSlot: overrides.closeSlot ?? 100_200n,
    shuffleSeed: 0n,
    clearingPrice: 0n,
    totalCommitments: 0,
    totalRevealed: 0,
    totalSettled: 0,
    totalVolume: 0n,
    totalNotional: 0n,
    slashedDeposits: 0n,
    bump: 255,
  };
}

describe('PHASE_LABEL', () => {
  it('has a label for every BatchStatus variant', () => {
    for (const status of Object.values(sdk.state.BatchStatus)) {
      expect(PHASE_LABEL[status]).toBeTruthy();
    }
  });
});

describe('PHASE_TONE', () => {
  it('has a tone for every BatchStatus variant', () => {
    for (const status of Object.values(sdk.state.BatchStatus)) {
      expect(PHASE_TONE[status]).toBeTruthy();
    }
  });
});

describe('formatSlotDuration', () => {
  it('formats a positive slot count as HH:MM:SS', () => {
    // 100 slots × 0.4s = 40s → 00:00:40
    expect(formatSlotDuration(100)).toBe('00:00:40');
  });

  it('formats a multi-hour duration', () => {
    // 9000 slots × 0.4s = 3600s → 01:00:00
    expect(formatSlotDuration(9000)).toBe('01:00:00');
  });

  it('returns "past deadline" for zero or negative counts', () => {
    expect(formatSlotDuration(0)).toBe('past deadline');
    expect(formatSlotDuration(-5)).toBe('past deadline');
  });

  it('pads single-digit minutes and seconds', () => {
    // 5 slots × 0.4s = 2s → 00:00:02
    expect(formatSlotDuration(5)).toBe('00:00:02');
  });
});

describe('deriveDeadline', () => {
  it('uses commitDeadlineSlot for the Committing phase', () => {
    const d: DeadlineInfo = deriveDeadline(
      sdk.state.BatchStatus.Committing,
      makeBatchData(sdk.state.BatchStatus.Committing, { commitDeadlineSlot: 50_000n }),
      49_999,
    );
    expect(d.deadline).toBe(50_000n);
    expect(d.isPastDeadline).toBe(false);
    expect(d.deadlineLabel).toBe('commit deadline');
  });

  it('uses revealDeadlineSlot for the Revealing phase', () => {
    const d: DeadlineInfo = deriveDeadline(
      sdk.state.BatchStatus.Revealing,
      makeBatchData(sdk.state.BatchStatus.Revealing, { revealDeadlineSlot: 80_000n }),
      80_001,
    );
    expect(d.deadline).toBe(80_000n);
    expect(d.isPastDeadline).toBe(true);
    expect(d.deadlineLabel).toBe('reveal deadline');
  });

  it('uses closeSlot for the Clearing phase', () => {
    const d: DeadlineInfo = deriveDeadline(
      sdk.state.BatchStatus.Clearing,
      makeBatchData(sdk.state.BatchStatus.Clearing, { closeSlot: 90_000n }),
      90_000,
    );
    expect(d.deadline).toBe(90_000n);
    expect(d.isPastDeadline).toBe(false);
    expect(d.deadlineLabel).toBe('close slot');
  });

  it('returns no deadline for the Settled phase', () => {
    const d: DeadlineInfo = deriveDeadline(
      sdk.state.BatchStatus.Settled,
      makeBatchData(sdk.state.BatchStatus.Settled),
      999_999,
    );
    expect(d.deadline).toBeNull();
    expect(d.isPastDeadline).toBe(false);
    expect(d.deadlineLabel).toBe('');
  });

  it('treats null currentSlot as "not past deadline"', () => {
    const d: DeadlineInfo = deriveDeadline(
      sdk.state.BatchStatus.Committing,
      makeBatchData(sdk.state.BatchStatus.Committing, { commitDeadlineSlot: 50_000n }),
      null,
    );
    expect(d.isPastDeadline).toBe(false);
  });
});
