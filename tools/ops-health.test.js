'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  evaluateOpsHealth,
  sanitizeHealthPayload,
  shouldCloseCollecting,
  collectingWindowsPastDeadline,
} = require('./ops-health');

test('3 consecutive keeper failures is a warning; 10 is critical and stops the loop', () => {
  const warn = evaluateOpsHealth({ consecutiveFailures: 3 });
  assert.equal(warn.severity, 'warning');
  assert.equal(warn.stopLoop, false);
  assert.ok(warn.alerts.some((a) => a.metric === 'keeper_tx_failures' && a.level === 'warning'));

  const crit = evaluateOpsHealth({ consecutiveFailures: 10 });
  assert.equal(crit.ok, false);
  assert.equal(crit.severity, 'critical');
  assert.equal(crit.stopLoop, true);
  assert.ok(crit.alerts.some((a) => a.metric === 'keeper_tx_failures' && a.level === 'critical'));
});

test('collecting past deadline warns; three t_max windows without close is critical', () => {
  const warn = evaluateOpsHealth({ collectingWindowsPastDeadline: 1 });
  assert.equal(warn.severity, 'warning');
  assert.ok(warn.alerts.some((a) => a.metric === 'collecting_batch_age' && a.level === 'warning'));

  const crit = evaluateOpsHealth({ collectingWindowsPastDeadline: 3 });
  assert.equal(crit.severity, 'critical');
  assert.equal(crit.ok, false);
  assert.ok(crit.alerts.some((a) => a.metric === 'collecting_batch_age' && a.level === 'critical'));
});

test('mark_valid=false streak of 10 is a product warning, not a stop', () => {
  const h = evaluateOpsHealth({ markInvalidStreak: 10 });
  assert.equal(h.severity, 'warning');
  assert.equal(h.stopLoop, false);
  assert.ok(h.alerts.some((a) => a.metric === 'mark_valid_false_streak' && a.level === 'warning'));
});

test('Clearing batches crank immediately; Collecting waits for deadline', () => {
  const { shouldCrank } = require('./ops-health');
  assert.equal(
    shouldCrank({ status: 2, currentSlot: 1, commitDeadlineSlot: 100 }),
    true,
  );
  assert.equal(
    shouldCrank({ status: 0, currentSlot: 1, commitDeadlineSlot: 100 }),
    false,
  );
  assert.equal(
    shouldCrank({ status: 0, currentSlot: 100, commitDeadlineSlot: 100 }),
    true,
  );
  assert.equal(
    shouldCrank({ status: 3, currentSlot: 200, commitDeadlineSlot: 100 }),
    false,
  );
});

test('24/7 crank waits for the collecting deadline (does not early-close on n_min)', () => {
  assert.equal(
    shouldCloseCollecting({
      status: 0,
      currentSlot: 99,
      commitDeadlineSlot: 100,
      totalCommitments: 8,
      nMin: 1,
    }),
    false,
  );
  assert.equal(
    shouldCloseCollecting({
      status: 0,
      currentSlot: 100,
      commitDeadlineSlot: 100,
      totalCommitments: 0,
      nMin: 1,
    }),
    true,
  );
  assert.equal(
    shouldCloseCollecting({
      status: 2,
      currentSlot: 200,
      commitDeadlineSlot: 100,
    }),
    false,
  );
});

test('collectingWindowsPastDeadline counts t_max windows after deadline', () => {
  assert.equal(
    collectingWindowsPastDeadline({
      status: 0,
      currentSlot: 99,
      commitDeadlineSlot: 100,
      tMaxSlots: 50,
    }),
    0,
  );
  assert.equal(
    collectingWindowsPastDeadline({
      status: 0,
      currentSlot: 100,
      commitDeadlineSlot: 100,
      tMaxSlots: 50,
    }),
    1,
  );
  assert.equal(
    collectingWindowsPastDeadline({
      status: 0,
      currentSlot: 200,
      commitDeadlineSlot: 100,
      tMaxSlots: 50,
    }),
    3,
  );
  assert.equal(
    collectingWindowsPastDeadline({
      status: 3,
      currentSlot: 500,
      commitDeadlineSlot: 100,
      tMaxSlots: 50,
    }),
    0,
  );
});

test('successful collecting crank does not keep a stale past-deadline age alert', () => {
  const { windowsForHealth } = require('./ops-health');
  assert.equal(
    windowsForHealth({
      status: 0,
      currentSlot: 200,
      commitDeadlineSlot: 100,
      tMaxSlots: 50,
      crankedThisTick: true,
    }),
    0,
  );
  assert.equal(
    windowsForHealth({
      status: 0,
      currentSlot: 200,
      commitDeadlineSlot: 100,
      tMaxSlots: 50,
      crankedThisTick: false,
    }),
    3,
  );
});

test('health payload never includes rpc url, api-key, or keypair path', () => {
  const cleaned = sanitizeHealthPayload({
    ok: true,
    rpcUrl: 'https://example.invalid/?api-key=secret',
    RPC_URL: 'secret',
    keypairPath: '/Users/x/.config/solana/id.json',
    keeperKeypair: '[]',
    secretKey: [1, 2, 3],
    keeper: 'ECmGsGAAPJimTwLk3SzkQ39pUQbaBj7U5qgSRRgYSFy',
    consecutiveFailures: 0,
  });
  const blob = JSON.stringify(cleaned);
  assert.equal(cleaned.rpcUrl, undefined);
  assert.equal(cleaned.RPC_URL, undefined);
  assert.equal(cleaned.keypairPath, undefined);
  assert.equal(cleaned.keeperKeypair, undefined);
  assert.equal(cleaned.secretKey, undefined);
  assert.equal(cleaned.keeper, 'ECmGsGAAPJimTwLk3SzkQ39pUQbaBj7U5qgSRRgYSFy');
  assert.equal(/api-key|rpcUrl|keypair/i.test(blob), false);
});
