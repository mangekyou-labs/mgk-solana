import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import * as sdk from '@mgk/sdk';

import {
  PHASE_LABEL,
  PHASE_TONE,
  describeBatchPhase,
  deriveDeadline,
  formatBatchCountdown,
  formatSlotDuration,
  isPastActionDeadline,
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
    bidClearingPrice: 0n,
    askClearingPrice: 0n,
    matchedBidQty: 0n,
    matchedAskQty: 0n,
    markValid: false,
    liqPaused: true,
  };
}

function makeRegistryState(
  overrides: Partial<{
    nMin: number;
  }> = {},
): sdk.state.RegistryState {
  return {
    governance: PublicKey.default,
    pauseFlags: 0,
    batchIdCounter: 8n,
    baseDeposit: 10_000_000n,
    nMin: overrides.nMin ?? 1,
    tMinSlots: 4n,
    tMaxSlots: 400n,
    tRevealSlots: 50n,
    instrumentCount: 1,
    volatilityMultiplier: 10_000,
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
  it('uses collection deadline for the Collecting phase', () => {
    const d: DeadlineInfo = deriveDeadline(
      sdk.state.BatchStatus.Collecting,
      makeBatchData(sdk.state.BatchStatus.Collecting, { commitDeadlineSlot: 50_000n }),
      49_999,
    );
    expect(d.deadline).toBe(50_000n);
    expect(d.isPastDeadline).toBe(false);
    expect(d.deadlineLabel).toBe('collection closes');
  });

  it('labels legacy reveal wire value as closed (DFBA skips reveal)', () => {
    const d: DeadlineInfo = deriveDeadline(
      sdk.state.BatchStatus.Revealing,
      makeBatchData(sdk.state.BatchStatus.Revealing, { revealDeadlineSlot: 80_000n }),
      80_001,
    );
    expect(d.deadline).toBe(80_000n);
    expect(d.isPastDeadline).toBe(true);
    expect(d.deadlineLabel).toBe('window closed');
  });

  it('uses auction label for the Clearing phase', () => {
    const d: DeadlineInfo = deriveDeadline(
      sdk.state.BatchStatus.Clearing,
      makeBatchData(sdk.state.BatchStatus.Clearing, { closeSlot: 90_000n }),
      90_000,
    );
    expect(d.deadline).toBe(90_000n);
    expect(d.isPastDeadline).toBe(false);
    expect(d.deadlineLabel).toBe('auction in progress');
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
      sdk.state.BatchStatus.Collecting,
      makeBatchData(sdk.state.BatchStatus.Collecting, { commitDeadlineSlot: 50_000n }),
      null,
    );
    expect(d.isPastDeadline).toBe(false);
  });
});

describe('formatBatchCountdown', () => {
  it('shows accepting orders for Collecting past deadline while below n_min', () => {
    const batch = makeBatchData(sdk.state.BatchStatus.Collecting, {
      commitDeadlineSlot: 50_000n,
    });
    batch.totalCommitments = 0;

    expect(
      formatBatchCountdown(
        sdk.state.BatchStatus.Collecting,
        batch,
        50_100,
        makeRegistryState({ nMin: 1 }),
      ),
    ).toBe('accepting orders');
    expect(
      isPastActionDeadline(
        sdk.state.BatchStatus.Collecting,
        batch,
        50_100,
        makeRegistryState({ nMin: 1 }),
      ),
    ).toBe(false);
  });

  it('keeps past deadline warning once Collecting has met n_min', () => {
    const batch = makeBatchData(sdk.state.BatchStatus.Collecting, {
      commitDeadlineSlot: 50_000n,
    });
    batch.totalCommitments = 1;

    expect(
      formatBatchCountdown(
        sdk.state.BatchStatus.Collecting,
        batch,
        50_100,
        makeRegistryState({ nMin: 1 }),
      ),
    ).toBe('past deadline');
    expect(
      isPastActionDeadline(
        sdk.state.BatchStatus.Collecting,
        batch,
        50_100,
        makeRegistryState({ nMin: 1 }),
      ),
    ).toBe(true);
  });

  it('shows dual auction for Clearing phase', () => {
    const batch = makeBatchData(sdk.state.BatchStatus.Clearing, {
      closeSlot: 50_000n,
    });
    expect(
      formatBatchCountdown(
        sdk.state.BatchStatus.Clearing,
        batch,
        49_000,
        makeRegistryState({ nMin: 1 }),
      ),
    ).toBe('dual auction…');
  });
});

describe('describeBatchPhase', () => {
  it('explains that Collecting accepts open orders before the close slot', () => {
    expect(
      describeBatchPhase(
        sdk.state.BatchStatus.Collecting,
        makeBatchData(sdk.state.BatchStatus.Collecting, {
          commitDeadlineSlot: 50_000n,
        }),
        49_900,
      ),
    ).toEqual({
      headline: 'Orders open',
      detail: 'Dual auction in 00:00:40',
    });
  });

  it('explains that an expired Collecting batch is waiting for a keeper', () => {
    expect(
      describeBatchPhase(
        sdk.state.BatchStatus.Collecting,
        makeBatchData(sdk.state.BatchStatus.Collecting, {
          commitDeadlineSlot: 50_000n,
        }),
        50_000,
      ),
    ).toEqual({
      headline: 'Ready to clear',
      detail: 'Waiting for keeper',
    });
  });

  it('shows how late the keeper is after the close slot', () => {
    expect(
      describeBatchPhase(
        sdk.state.BatchStatus.Collecting,
        makeBatchData(sdk.state.BatchStatus.Collecting, {
          commitDeadlineSlot: 50_000n,
        }),
        50_500,
      ),
    ).toEqual({
      headline: 'Ready to clear',
      detail: 'Waiting for keeper · 00:03:20 late',
    });
  });

  it('keeps an expired Collecting batch open until minimum flow is met', () => {
    const batch = makeBatchData(sdk.state.BatchStatus.Collecting, {
      commitDeadlineSlot: 50_000n,
    });

    expect(
      describeBatchPhase(
        sdk.state.BatchStatus.Collecting,
        batch,
        50_001,
        makeRegistryState({ nMin: 1 }),
      ),
    ).toEqual({
      headline: 'Orders open',
      detail: 'Waiting for minimum flow (0/1)',
    });
  });

  it('explains the dual uniform-price work during Clearing', () => {
    expect(
      describeBatchPhase(
        sdk.state.BatchStatus.Clearing,
        makeBatchData(sdk.state.BatchStatus.Clearing),
        50_001,
      ),
    ).toEqual({
      headline: 'Orders closed',
      detail: 'Matching maker and taker flow at uniform prices',
    });
  });

  it('explains a valid dual clear after settlement', () => {
    const batch = makeBatchData(sdk.state.BatchStatus.Settled);
    batch.markValid = true;
    batch.liqPaused = false;

    expect(
      describeBatchPhase(sdk.state.BatchStatus.Settled, batch, 50_001),
    ).toEqual({
      headline: 'Fills settled',
      detail: 'Mark updated',
    });
  });

  it('explains liquidation safety when settlement has no two-sided match', () => {
    const batch = makeBatchData(sdk.state.BatchStatus.Settled);
    batch.markValid = false;
    batch.liqPaused = true;

    expect(
      describeBatchPhase(sdk.state.BatchStatus.Settled, batch, 50_001),
    ).toEqual({
      headline: 'No two-sided match',
      detail: 'Mark unchanged · Liquidations paused',
    });
  });
});
