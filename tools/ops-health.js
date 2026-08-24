'use strict';

const BATCH_STATUS_COLLECTING = 0;

const SECRET_KEYS = [
  'rpcUrl',
  'RPC_URL',
  'NEXT_PUBLIC_RPC_URL',
  'keypairPath',
  'keeperKeypair',
  'secretKey',
  'privateKey',
  'apiKey',
];

function collectingWindowsPastDeadline({
  status,
  currentSlot,
  commitDeadlineSlot,
  tMaxSlots,
}) {
  if (status !== BATCH_STATUS_COLLECTING) return 0;
  if (currentSlot < commitDeadlineSlot) return 0;
  const window = tMaxSlots && tMaxSlots > 0 ? tMaxSlots : 1;
  return 1 + Math.floor((currentSlot - commitDeadlineSlot) / window);
}

const BATCH_STATUS_CLEARING = 2;

function shouldCloseCollecting({
  status,
  currentSlot,
  commitDeadlineSlot,
}) {
  if (status !== BATCH_STATUS_COLLECTING) return false;
  return currentSlot >= commitDeadlineSlot;
}

function shouldCrank(snapshot) {
  if (snapshot.status === BATCH_STATUS_CLEARING) return true;
  return shouldCloseCollecting(snapshot);
}

/** Age alert uses post-crank state: a successful close this tick is not overdue. */
function windowsForHealth(snapshot) {
  if (snapshot && snapshot.crankedThisTick) return 0;
  return collectingWindowsPastDeadline(snapshot);
}

function evaluateOpsHealth(snapshot) {
  const s = snapshot || {};
  const consecutiveFailures = s.consecutiveFailures || 0;
  const windows =
    s.collectingWindowsPastDeadline != null
      ? s.collectingWindowsPastDeadline
      : collectingWindowsPastDeadline(s);
  const markInvalidStreak = s.markInvalidStreak || 0;
  const slotLag = s.slotLag;
  const alerts = [];

  if (consecutiveFailures >= 10) {
    alerts.push({
      metric: 'keeper_tx_failures',
      level: 'critical',
      message: consecutiveFailures + ' consecutive keeper transaction failures',
    });
  } else if (consecutiveFailures >= 3) {
    alerts.push({
      metric: 'keeper_tx_failures',
      level: 'warning',
      message: consecutiveFailures + ' consecutive keeper transaction failures',
    });
  }

  if (windows >= 3) {
    alerts.push({
      metric: 'collecting_batch_age',
      level: 'critical',
      message: 'no close for ' + windows + ' t_max windows past deadline',
    });
  } else if (windows >= 1) {
    alerts.push({
      metric: 'collecting_batch_age',
      level: 'warning',
      message: 'collecting past deadline (' + windows + ' t_max window(s))',
    });
  }

  if (markInvalidStreak >= 10) {
    alerts.push({
      metric: 'mark_valid_false_streak',
      level: 'warning',
      message: markInvalidStreak + ' settled batches without dual-clear mark',
    });
  }

  if (slotLag != null && slotLag > 50) {
    alerts.push({
      metric: 'slot_lag',
      level: 'critical',
      message: 'slot lag ' + slotLag,
    });
  } else if (slotLag != null && slotLag > 10) {
    alerts.push({
      metric: 'slot_lag',
      level: 'warning',
      message: 'slot lag ' + slotLag,
    });
  }

  let severity = 'ok';
  for (const a of alerts) {
    if (a.level === 'critical') severity = 'critical';
    else if (a.level === 'warning' && severity !== 'critical') severity = 'warning';
  }

  return {
    ok: severity !== 'critical',
    severity,
    alerts,
    stopLoop: consecutiveFailures >= 10,
  };
}

function sanitizeHealthPayload(payload) {
  const out = {};
  if (!payload || typeof payload !== 'object') return out;
  for (const [k, v] of Object.entries(payload)) {
    if (SECRET_KEYS.includes(k)) continue;
    if (/rpcurl|api-key|apikey|keypair|secret/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

module.exports = {
  BATCH_STATUS_COLLECTING,
  BATCH_STATUS_CLEARING,
  collectingWindowsPastDeadline,
  windowsForHealth,
  shouldCloseCollecting,
  shouldCrank,
  evaluateOpsHealth,
  sanitizeHealthPayload,
};
