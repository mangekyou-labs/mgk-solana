import * as sdk from '@mgk/sdk';

import type { PillTone } from '@/components/common/Pill';

/**
 * Pure helpers for rendering the batch phase pill + countdown.
 *
 * DFBA lifecycle (user-facing): Collecting → Clearing → Settled.
 * Wire value 0 is still `BatchStatus.Collecting` (== historical Committing).
 * Reveal is not a DFBA phase; wire 1 is labeled "Closed" if ever shown.
 *
 * Shared by `BatchTimeline` and `MarketHeader`. `SLOT_MS` is a UX
 * approximation — 0.4s/slot is good enough for v1.
 */
export const SLOT_MS = 400;

/** User-facing DFBA phase names (never "Committing" / "Revealing"). */
export const PHASE_LABEL: Record<number, string> = {
  [sdk.state.BatchStatus.Collecting]: 'Collecting',
  [sdk.state.BatchStatus.Revealing]: 'Closed', // DFBA skips reveal; rare if shown
  [sdk.state.BatchStatus.Clearing]: 'Clearing',
  [sdk.state.BatchStatus.Settled]: 'Settled',
};

export const PHASE_TONE: Record<number, PillTone> = {
  [sdk.state.BatchStatus.Collecting]: 'info',
  [sdk.state.BatchStatus.Revealing]: 'neutral',
  [sdk.state.BatchStatus.Clearing]: 'warn',
  [sdk.state.BatchStatus.Settled]: 'neutral',
};

/**
 * Format a slot-based duration as `HH:MM:SS`. Negative durations
 * return "past deadline" so the UI doesn't show a negative timer.
 */
function formatHms(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds]
    .map((n) => n.toString().padStart(2, '0'))
    .join(':');
}

/**
 * Format a slot-based duration as `HH:MM:SS`. Negative durations
 * return "past deadline" so the UI doesn't show a negative timer.
 */
export function formatSlotDuration(slotsRemaining: number): string {
  if (slotsRemaining <= 0) return 'past deadline';
  return formatHms(Math.floor((slotsRemaining * SLOT_MS) / 1000));
}

/** User-facing keeper wait, with elapsed time once the close slot has passed. */
export function formatKeeperWait(slotsLate: number): string {
  if (slotsLate <= 0) return 'Waiting for keeper';
  const totalSeconds = Math.max(1, Math.round((slotsLate * SLOT_MS) / 1000));
  return `Waiting for keeper · ${formatHms(totalSeconds)} late`;
}

/** Still accepting posts after t_max if posts < n_min (DFBA open window). */
export function isCollectingAcceptingAfterDeadline(
  status: sdk.state.BatchStatus,
  data: sdk.state.BatchState,
  registry?: sdk.state.RegistryState | null,
): boolean {
  return (
    status === sdk.state.BatchStatus.Collecting &&
    registry != null &&
    data.totalCommitments < registry.nMin
  );
}

/** @deprecated Use isCollectingAcceptingAfterDeadline */
export const isCommitAcceptingAfterDeadline = isCollectingAcceptingAfterDeadline;

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
    case sdk.state.BatchStatus.Collecting: {
      const d = data.commitDeadlineSlot;
      return {
        deadline: d,
        isPastDeadline: currentSlot != null && currentSlot > Number(d),
        deadlineLabel: 'collection closes',
      };
    }
    case sdk.state.BatchStatus.Revealing: {
      // DFBA does not use reveal; if shown, treat as close of collection.
      const d = data.revealDeadlineSlot;
      return {
        deadline: d,
        isPastDeadline: currentSlot != null && currentSlot > Number(d),
        deadlineLabel: 'window closed',
      };
    }
    case sdk.state.BatchStatus.Clearing: {
      const d = data.closeSlot;
      return {
        deadline: d,
        isPastDeadline: currentSlot != null && currentSlot > Number(d),
        deadlineLabel: 'auction in progress',
      };
    }
    case sdk.state.BatchStatus.Settled:
      return { deadline: null, isPastDeadline: false, deadlineLabel: '' };
    default:
      return { deadline: null, isPastDeadline: false, deadlineLabel: '' };
  }
}

export function formatBatchCountdown(
  status: sdk.state.BatchStatus,
  data: sdk.state.BatchState,
  currentSlot: number | null,
  registry?: sdk.state.RegistryState | null,
): string {
  const { deadline } = deriveDeadline(status, data, currentSlot);
  if (deadline == null || currentSlot == null) return '—';
  const slotsRemaining = Number(deadline) - currentSlot;
  if (slotsRemaining <= 0 && isCollectingAcceptingAfterDeadline(status, data, registry)) {
    return 'accepting orders';
  }
  if (status === sdk.state.BatchStatus.Clearing) {
    return 'dual auction…';
  }
  return formatSlotDuration(slotsRemaining);
}

export interface BatchPhaseCopy {
  headline: string;
  detail: string;
}

/**
 * Explain what the current DFBA phase means for a trader.
 *
 * The wire status alone is not enough: a Collecting batch whose close slot
 * has arrived may either be permissionlessly closeable or still accept orders
 * while it is below n_min. The registry state is optional for callers that
 * only have the batch account; when present, it keeps the copy aligned with
 * the core program's minimum-flow rule.
 */
export function describeBatchPhase(
  status: sdk.state.BatchStatus,
  data: sdk.state.BatchState,
  currentSlot: number | null,
  registry?: sdk.state.RegistryState | null,
): BatchPhaseCopy {
  switch (status) {
    case sdk.state.BatchStatus.Collecting: {
      const closeSlot = Number(data.commitDeadlineSlot);
      if (currentSlot != null && currentSlot >= closeSlot) {
        if (isCollectingAcceptingAfterDeadline(status, data, registry)) {
          return {
            headline: 'Orders open',
            detail: `Waiting for minimum flow (${data.totalCommitments}/${registry?.nMin})`,
          };
        }

        return {
          headline: 'Ready to clear',
          detail: formatKeeperWait(currentSlot - closeSlot),
        };
      }

      return {
        headline: 'Orders open',
        detail: currentSlot == null
          ? 'Waiting for close slot'
          : `Dual auction in ${formatSlotDuration(closeSlot - currentSlot)}`,
      };
    }
    case sdk.state.BatchStatus.Revealing:
      return {
        headline: 'Collection closed',
        detail: 'Waiting for clearing',
      };
    case sdk.state.BatchStatus.Clearing:
      return {
        headline: 'Orders closed',
        detail: 'Matching maker and taker flow at uniform prices',
      };
    case sdk.state.BatchStatus.Settled:
      return data.markValid && !data.liqPaused
        ? {
            headline: 'Fills settled',
            detail: 'Mark updated',
          }
        : {
            headline: 'No two-sided match',
            detail: 'Mark unchanged · Liquidations paused',
          };
    default:
      return {
        headline: 'Unknown batch state',
        detail: 'Refresh chain state',
      };
  }
}

export function isPastActionDeadline(
  status: sdk.state.BatchStatus,
  data: sdk.state.BatchState,
  currentSlot: number | null,
  registry?: sdk.state.RegistryState | null,
): boolean {
  const { isPastDeadline } = deriveDeadline(status, data, currentSlot);
  if (!isPastDeadline) return false;
  return !isCollectingAcceptingAfterDeadline(status, data, registry);
}
