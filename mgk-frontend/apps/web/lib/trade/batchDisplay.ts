import * as sdk from '@mgk/sdk';

import type { PillTone } from '@/components/common/Pill';

/**
 * Pure helpers for rendering the batch phase pill + countdown.
 *
 * Shared by `BatchTimeline` (T2.5) and `MarketHeader` (T2.10). The
 * `SLOT_MS` constant is a UX approximation — for a precision-grade
 * countdown we would need to track the wall-clock when slot N was
 * observed and extrapolate from there. 0.4s/slot is good enough for v1.
 */
export const SLOT_MS = 400;

export const PHASE_LABEL: Record<sdk.state.BatchStatus, string> = {
  [sdk.state.BatchStatus.Committing]: 'Committing',
  [sdk.state.BatchStatus.Revealing]: 'Revealing',
  [sdk.state.BatchStatus.Clearing]: 'Clearing',
  [sdk.state.BatchStatus.Settled]: 'Settled',
};

export const PHASE_TONE: Record<sdk.state.BatchStatus, PillTone> = {
  [sdk.state.BatchStatus.Committing]: 'info',
  [sdk.state.BatchStatus.Revealing]: 'accent',
  [sdk.state.BatchStatus.Clearing]: 'warn',
  [sdk.state.BatchStatus.Settled]: 'neutral',
};

/**
 * Format a slot-based duration as `HH:MM:SS`. Negative durations
 * return "past deadline" so the UI doesn't show a negative timer.
 */
export function formatSlotDuration(slotsRemaining: number): string {
  if (slotsRemaining <= 0) return 'past deadline';
  const totalSeconds = Math.floor((slotsRemaining * SLOT_MS) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds]
    .map((n) => n.toString().padStart(2, '0'))
    .join(':');
}

export interface DeadlineInfo {
  deadline: bigint | null;
  isPastDeadline: boolean;
  deadlineLabel: string;
}

/**
 * Per-phase deadline + label + "is this past deadline?" derivation.
 * Split out as a pure helper so it can be unit-tested without React.
 */
export function deriveDeadline(
  status: sdk.state.BatchStatus,
  data: sdk.state.BatchState,
  currentSlot: number | null,
): DeadlineInfo {
  switch (status) {
    case sdk.state.BatchStatus.Committing: {
      const d = data.commitDeadlineSlot;
      return {
        deadline: d,
        isPastDeadline: currentSlot != null && currentSlot > Number(d),
        deadlineLabel: 'commit deadline',
      };
    }
    case sdk.state.BatchStatus.Revealing: {
      const d = data.revealDeadlineSlot;
      return {
        deadline: d,
        isPastDeadline: currentSlot != null && currentSlot > Number(d),
        deadlineLabel: 'reveal deadline',
      };
    }
    case sdk.state.BatchStatus.Clearing: {
      const d = data.closeSlot;
      return {
        deadline: d,
        isPastDeadline: currentSlot != null && currentSlot > Number(d),
        deadlineLabel: 'close slot',
      };
    }
    case sdk.state.BatchStatus.Settled:
      return { deadline: null, isPastDeadline: false, deadlineLabel: '' };
  }
}
