/**
 * Mirror of `programs/common/src/error.rs` `PercolatorError` enum.
 *
 * Wire format: codes come back from on-chain as u64 (`From<PercolatorError> for u64` in Rust).
 * The Rust enum is `#[repr(u32)]` and has 4 active ranges and 3 legacy ranges:
 *
 *   0–99    common         (in use)        — InvalidInstruction, InsufficientFunds, etc.
 *   100–199 router         (legacy, pre-strip)
 *   200–299 slab           (legacy, pre-strip)
 *   300–399 matching       (in use)        — InvalidSide, BookCorrupted, etc.
 *   400–499 risk           (in use)        — InsufficientMargin, etc.
 *   500–599 anti-toxicity  (legacy, unused)
 *   600–699 perps-core     (in use)        — RevealDeadlineExpired, etc.
 *   700–799 perps-matcher  (reserved)
 *
 * Legacy codes never appear in transactions from this build. The function
 * {@link humanizeError} still handles them defensively so log scrapers and
 * replay tools see a labelled message instead of an unhandled number.
 */

export const PercolatorError = {
  // Common (0-99)
  InvalidInstruction: 0,
  InvalidAccount: 1,
  InvalidAccountOwner: 2,
  InvalidMint: 3,
  InsufficientFunds: 4,
  Overflow: 5,
  Underflow: 6,
  Unauthorized: 7,

  // Matching (300-399)
  InvalidSide: 300,
  InvalidTimeInForce: 301,
  InvalidMakerClass: 302,
  InvalidOrderState: 303,
  BookCorrupted: 304,
  ReservedQtyExceeded: 305,

  // Risk (400-499)
  InsufficientMargin: 400,
  BelowMaintenanceMargin: 401,
  InvalidRiskParams: 402,

  // Perps-core (600-699)
  RevealDeadlineExpired: 600,
} as const;

export type PercolatorError = (typeof PercolatorError)[keyof typeof PercolatorError];

const HUMAN_MESSAGES: Record<PercolatorError, string> = {
  // Common
  [PercolatorError.InvalidInstruction]:
    'The transaction was malformed. Please try again.',
  [PercolatorError.InvalidAccount]:
    'An account in the transaction is invalid.',
  [PercolatorError.InvalidAccountOwner]:
    "An account has the wrong owner. Please reconnect your wallet.",
  [PercolatorError.InvalidMint]:
    'Token mint mismatch — wrong token type for this market.',
  [PercolatorError.InsufficientFunds]:
    "You don't have enough SOL for this trade.",
  [PercolatorError.Overflow]:
    'A number got too large. Reduce your order size.',
  [PercolatorError.Underflow]:
    'A number got too small. Please contact support.',
  [PercolatorError.Unauthorized]:
    "You're not allowed to perform this action.",

  // Matching
  [PercolatorError.InvalidSide]:
    'Order side is invalid (must be Buy or Sell).',
  [PercolatorError.InvalidTimeInForce]:
    'Time-in-force is invalid for this order type.',
  [PercolatorError.InvalidMakerClass]:
    'Order maker class is invalid.',
  [PercolatorError.InvalidOrderState]:
    "Order is in a state that can't accept this action.",
  [PercolatorError.BookCorrupted]:
    'Order book data is corrupted. Please refresh.',
  [PercolatorError.ReservedQtyExceeded]:
    'Order quantity exceeds the reserved size.',

  // Risk
  [PercolatorError.InsufficientMargin]:
    "You don't have enough margin for this order.",
  [PercolatorError.BelowMaintenanceMargin]:
    'Your position is below the maintenance margin requirement.',
  [PercolatorError.InvalidRiskParams]:
    'Risk parameters are invalid.',

  // Perps-core
  [PercolatorError.RevealDeadlineExpired]:
    'The reveal deadline has passed. Place a new order for the next batch.',
};

const LEGACY_RANGES: ReadonlyArray<readonly [number, number]> = [
  [100, 199], // router (pre-strip)
  [200, 299], // slab (pre-strip)
  [500, 599], // anti-toxicity (unused)
];

const LIVE_RANGE_NAMES: ReadonlyMap<number, string> = new Map([
  [0, 'common'],
  [300, 'matching'],
  [400, 'risk'],
  [600, 'perps-core'],
  [700, 'perps-matcher'],
]);

function isLegacyCode(code: number): boolean {
  for (const [lo, hi] of LEGACY_RANGES) {
    if (code >= lo && code <= hi) return true;
  }
  return false;
}

function liveRangeName(code: number): string | null {
  const rangeStart = Math.floor(code / 100) * 100;
  return LIVE_RANGE_NAMES.get(rangeStart) ?? null;
}

export function humanizeError(code: number | bigint): string {
  const n = typeof code === 'bigint' ? Number(code) : code;

  if (!Number.isInteger(n) || n < 0) {
    throw new Error(
      `humanizeError: invalid input ${String(code)} (must be a non-negative integer)`,
    );
  }

  if (n in HUMAN_MESSAGES) {
    return HUMAN_MESSAGES[n as PercolatorError];
  }

  if (isLegacyCode(n)) {
    return `Legacy code (${n}), not in use in this build.`;
  }

  const rangeName = liveRangeName(n);
  if (rangeName !== null) {
    return `Unknown ${rangeName} error (${n}).`;
  }

  return `Unknown program error (${n}).`;
}
