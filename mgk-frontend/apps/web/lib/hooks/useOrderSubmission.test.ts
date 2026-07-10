import { describe, expect, it } from 'vitest';

import {
  activeBatchIdFromCounter,
  commitOrderAccountCount,
  decodeProgramError,
} from './useOrderSubmission';

function makeSendTxError(message: string): Error & { code?: number } {
  const e = new Error(message) as Error & { code?: number };
  return e;
}

describe('G12 — decodeProgramError', () => {
  it('returns severity: slashed for RevealDeadlineExpired (600)', () => {
    const decoded = decodeProgramError(
      makeSendTxError('failed to send transaction: ... custom program error: 0x258'),
    );
    expect(decoded.code).toBe(600);
    expect(decoded.severity).toBe('slashed');
    expect(decoded.message).toMatch(/next batch/i);
  });

  it('returns severity: slashed for InvalidCommitment (503)', () => {
    const decoded = decodeProgramError(
      makeSendTxError('... custom program error: 0x1f7'),
    );
    expect(decoded.code).toBe(503);
    expect(decoded.severity).toBe('slashed');
    expect(decoded.message).toMatch(/slashed/i);
  });

  it('returns severity: retryable for InsufficientMargin (400)', () => {
    const decoded = decodeProgramError(
      makeSendTxError('... custom program error: 0x190'),
    );
    expect(decoded.code).toBe(400);
    expect(decoded.severity).toBe('retryable');
  });

  it('returns severity: retryable for PortfolioInsufficientMargin (107)', () => {
    const decoded = decodeProgramError(
      makeSendTxError('... custom program error: 0x6b'),
    );
    expect(decoded.code).toBe(107);
    expect(decoded.severity).toBe('retryable');
    expect(decoded.message).toMatch(/free collateral/i);
  });

  it('returns severity: fatal for OperationPaused (602)', () => {
    const decoded = decodeProgramError(
      makeSendTxError('... custom program error: 0x25a'),
    );
    expect(decoded.code).toBe(602);
    expect(decoded.severity).toBe('fatal');
    expect(decoded.message).toMatch(/paused/i);
  });

  it('parses the decimal form too (some wallet builds emit 503 not 0x1f7)', () => {
    const decoded = decodeProgramError(
      makeSendTxError('Transaction failed: custom program error: 503'),
    );
    expect(decoded.code).toBe(503);
    expect(decoded.severity).toBe('slashed');
  });

  it('returns severity: unknown + the original message for non-program errors', () => {
    const decoded = decodeProgramError(
      makeSendTxError('User rejected the request.'),
    );
    expect(decoded.code).toBeNull();
    expect(decoded.severity).toBe('unknown');
    expect(decoded.message).toMatch(/User rejected/);
  });

  it('returns severity: unknown when given a non-Error value', () => {
    const decoded = decodeProgramError('plain string');
    expect(decoded.code).toBeNull();
    expect(decoded.severity).toBe('unknown');
    expect(decoded.message).toBe('plain string');
  });

  it('returns severity: unknown when given null', () => {
    const decoded = decodeProgramError(null);
    expect(decoded.code).toBeNull();
    expect(decoded.severity).toBe('unknown');
  });

  it('accepts a pre-parsed `code` property on the error (newer wallet-adapter shape)', () => {
    const err = Object.assign(new Error('wrapper'), { code: 600 });
    const decoded = decodeProgramError(err);
    expect(decoded.code).toBe(600);
    expect(decoded.severity).toBe('slashed');
  });

  it('treats unknown high codes as severity: unknown', () => {
    const decoded = decodeProgramError(
      makeSendTxError('... custom program error: 0x270f'),
    );
    expect(decoded.code).toBe(9999);
    expect(decoded.severity).toBe('unknown');
  });
});

describe('devnet commit-order account construction', () => {
  it('uses the last created batch as the active batch', () => {
    expect(activeBatchIdFromCounter(1n)).toBe(0n);
    expect(activeBatchIdFromCounter(42n)).toBe(41n);
  });

  it('rejects commit when no batch has been created', () => {
    expect(() => activeBatchIdFromCounter(0n)).toThrow(/No active batch/i);
  });

  it('includes the system program account for program-created commitment PDAs', () => {
    expect(commitOrderAccountCount()).toBe(6);
  });
});
