'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  fetchBinance,
  fetchCoinbase,
  fetchOkx,
  fetchBybit,
  calculateMedian,
  aggregatePrices,
  fetchAllAndAggregate,
  parseScaledPrice,
} = require('./oracle-sources');
const {
  PRICE_ORACLE_SIZE,
  PRICE_ORACLE_MAGIC,
  decodePriceOracleAccount,
  evaluateOracleHealth,
  sanitizeHealthPayload,
} = require('./ops-oracle');

// ---------------------------------------------------------------------------
// 1. Adapter unit tests
// ---------------------------------------------------------------------------

test('fetchBinance parses valid response to 1e6 scale', async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({ symbol: 'SOLUSDT', price: '87.654321' }),
  });
  const price = await fetchBinance(1000, mockFetch);
  assert.equal(price, 87_654_321n);
});

test('fetchBinance rejects non-positive or malformed response', async () => {
  const mockBadPrice = async () => ({
    ok: true,
    json: async () => ({ symbol: 'SOLUSDT', price: '-10.0' }),
  });
  await assert.rejects(() => fetchBinance(1000, mockBadPrice), /Invalid non-positive price/);

  const mockZeroPrice = async () => ({
    ok: true,
    json: async () => ({ symbol: 'SOLUSDT', price: '0' }),
  });
  await assert.rejects(() => fetchBinance(1000, mockZeroPrice), /Invalid non-positive price/);

  const mockMissingPrice = async () => ({
    ok: true,
    json: async () => ({ symbol: 'SOLUSDT' }),
  });
  await assert.rejects(() => fetchBinance(1000, mockMissingPrice), /missing price field/);
});

test('fetchCoinbase parses valid response to 1e6 scale', async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({ price: '87.50', time: '2026-08-24T00:00:00Z' }),
  });
  const price = await fetchCoinbase(1000, mockFetch);
  assert.equal(price, 87_500_000n);
});

test('fetchCoinbase rejects HTTP errors and missing price', async () => {
  const mockHttpError = async () => ({
    ok: false,
    status: 503,
    statusText: 'Service Unavailable',
  });
  await assert.rejects(() => fetchCoinbase(1000, mockHttpError), /HTTP 503/);
});

test('fetchOkx parses valid response to 1e6 scale', async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      code: '0',
      data: [{ instId: 'SOL-USDT', last: '87.75', ts: '1600000000000' }],
    }),
  });
  const price = await fetchOkx(1000, mockFetch);
  assert.equal(price, 87_750_000n);
});

test('fetchOkx handles lastPx field and rejects error code', async () => {
  const mockLastPx = async () => ({
    ok: true,
    json: async () => ({
      code: '0',
      data: [{ instId: 'SOL-USDT', lastPx: '87.80' }],
    }),
  });
  const price = await fetchOkx(1000, mockLastPx);
  assert.equal(price, 87_800_000n);

  const mockErrorCode = async () => ({
    ok: true,
    json: async () => ({
      code: '50001',
      msg: 'Server error',
      data: [],
    }),
  });
  await assert.rejects(() => fetchOkx(1000, mockErrorCode), /OKX error code: 50001/);
});

test('fetchBybit parses valid response to 1e6 scale', async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      retCode: 0,
      retMsg: 'OK',
      result: {
        category: 'spot',
        list: [{ symbol: 'SOLUSDT', lastPrice: '87.60' }],
      },
    }),
  });
  const price = await fetchBybit(1000, mockFetch);
  assert.equal(price, 87_600_000n);
});

test('fetchBybit rejects non-zero retCode and empty list', async () => {
  const mockBadRetCode = async () => ({
    ok: true,
    json: async () => ({
      retCode: 10002,
      retMsg: 'Invalid request',
      result: { list: [] },
    }),
  });
  await assert.rejects(() => fetchBybit(1000, mockBadRetCode), /Bybit error retCode: 10002/);
});

test('timeout throws and is caught per venue', async () => {
  const mockSlowFetch = (url, opts) =>
    new Promise((resolve, reject) => {
      opts.signal?.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });

  await assert.rejects(() => fetchBinance(50, mockSlowFetch), /aborted/);
});

// ---------------------------------------------------------------------------
// 2. Median and Outlier Aggregation tests
// ---------------------------------------------------------------------------

test('calculateMedian handles odd and even arrays correctly', () => {
  // Odd length: 3 elements
  assert.equal(calculateMedian([85n, 87n, 90n]), 87n);
  assert.equal(calculateMedian([10n, 20n, 30n, 40n, 50n]), 30n);

  // Even length: 4 elements (integer average of middle two)
  assert.equal(calculateMedian([85n, 87n, 89n, 91n]), 88n); // (87 + 89) / 2 = 88
  assert.equal(calculateMedian([80n, 85n, 86n, 90n]), 85n); // (85 + 86) / 2 = 85 (floor)
});

test('aggregatePrices computes median and confidence for 4 tightly clustered venues', () => {
  const venuePrices = {
    binance: { price: 87_500_000n },
    coinbase: { price: 87_600_000n },
    okx: { price: 87_550_000n },
    bybit: { price: 87_650_000n },
  };

  const res = aggregatePrices(venuePrices, { minVenues: 3, maxDeviationBps: 100 });
  assert.equal(res.ok, true);
  // Sorted: 87.50, 87.55, 87.60, 87.65 -> median = (87.55 + 87.60)/2 = 87.575 (87_575_000)
  assert.equal(res.price, 87_575_000n);
  assert.equal(res.acceptedVenues.length, 4);
  assert.equal(res.rejectedVenues.length, 0);

  // Confidence is max absolute deviation from final median:
  // |87.50 - 87.575| = 75_000
  // |87.55 - 87.575| = 25_000
  // |87.60 - 87.575| = 25_000
  // |87.65 - 87.575| = 75_000
  assert.equal(res.confidence, 75_000n);
});

test('aggregatePrices rejects outliers exceeding maxDeviationBps (100 bps = 1%)', () => {
  const venuePrices = {
    binance: { price: 87_000_000n },
    coinbase: { price: 87_100_000n },
    okx: { price: 87_200_000n },
    bybit: { price: 100_000_000n }, // ~15% outlier
  };

  const res = aggregatePrices(venuePrices, { minVenues: 3, maxDeviationBps: 100 });
  assert.equal(res.ok, true);
  assert.equal(res.rejectedVenues.length, 1);
  assert.equal(res.rejectedVenues[0].venue, 'bybit');
  assert.equal(res.acceptedVenues.length, 3);
  assert.deepEqual(res.acceptedVenues.sort(), ['binance', 'coinbase', 'okx']);

  // Final median of [87.0, 87.1, 87.2] = 87.1
  assert.equal(res.price, 87_100_000n);
  // Confidence = max(|87.0 - 87.1|, |87.1 - 87.1|, |87.2 - 87.1|) = 100_000
  assert.equal(res.confidence, 100_000n);
});

test('aggregatePrices fails quorum when remaining venues < minVenues', () => {
  // 4 venues, but 2 are severe outliers
  const venuePrices = {
    binance: { price: 87_000_000n },
    coinbase: { price: 87_100_000n },
    okx: { price: 50_000_000n },  // outlier low
    bybit: { price: 120_000_000n }, // outlier high
  };

  const res = aggregatePrices(venuePrices, { minVenues: 3, maxDeviationBps: 100 });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'quorum_lost_to_outliers');
  assert.equal(res.acceptedVenues.length, 2);
  assert.equal(res.rejectedVenues.length, 2);
});

test('aggregatePrices fails when fewer than minVenues successful fetches', () => {
  const venuePrices = {
    binance: { price: 87_000_000n },
    coinbase: { price: 87_100_000n },
  };

  const res = aggregatePrices(venuePrices, { minVenues: 3 });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'insufficient_sources');
});

test('fetchAllAndAggregate handles mixed venue failures gracefully', async () => {
  const customFetch = async (url) => {
    if (url.includes('binance')) {
      return { ok: true, json: async () => ({ price: '87.00' }) };
    }
    if (url.includes('coinbase')) {
      return { ok: true, json: async () => ({ price: '87.10' }) };
    }
    if (url.includes('okx')) {
      return { ok: true, json: async () => ({ code: '0', data: [{ last: '87.20' }] }) };
    }
    if (url.includes('bybit')) {
      throw new Error('Network timeout');
    }
    throw new Error('Unknown URL');
  };

  const res = await fetchAllAndAggregate({ customFetch, minVenues: 3 });
  assert.equal(res.ok, true);
  assert.equal(res.acceptedVenues.length, 3);
  assert.ok(res.fetchErrors.bybit.includes('Network timeout'));
  assert.equal(res.price, 87_100_000n);
});

// ---------------------------------------------------------------------------
// 3. PriceOracle on-chain struct layout tests
// ---------------------------------------------------------------------------

test('decodePriceOracleAccount correctly unpacks 128-byte layout', () => {
  const buf = Buffer.alloc(PRICE_ORACLE_SIZE);
  buf.writeBigUInt64LE(PRICE_ORACLE_MAGIC, 0); // magic
  buf.writeUInt8(0, 8); // version
  buf.writeUInt8(5, 9); // bump
  buf.writeUInt8(1, 10); // isActive = true

  const authority = Buffer.alloc(32, 0xaa);
  const instrument = Buffer.alloc(32, 0xbb);
  authority.copy(buf, 16);
  instrument.copy(buf, 48);

  buf.writeBigInt64LE(87_500_000n, 80); // price
  buf.writeBigInt64LE(1_700_000_000n, 88); // timestamp
  buf.writeBigInt64LE(50_000n, 96); // confidence

  const decoded = decodePriceOracleAccount(buf);
  assert.equal(decoded.magic, PRICE_ORACLE_MAGIC);
  assert.equal(decoded.version, 0);
  assert.equal(decoded.bump, 5);
  assert.equal(decoded.isActive, true);
  assert.equal(decoded.authority.toBuffer().toString('hex'), authority.toString('hex'));
  assert.equal(decoded.instrument.toBuffer().toString('hex'), instrument.toString('hex'));
  assert.equal(decoded.price, 87_500_000n);
  assert.equal(decoded.timestamp, 1_700_000_000n);
  assert.equal(decoded.confidence, 50_000n);
});

// ---------------------------------------------------------------------------
// 4. Health Evaluation & Alerting tests
// ---------------------------------------------------------------------------

test('evaluateOracleHealth: warnings at 3 failures or 60s without update', () => {
  const warnFail = evaluateOracleHealth({ consecutiveFailures: 3 });
  assert.equal(warnFail.severity, 'warning');
  assert.equal(warnFail.stopLoop, false);
  assert.ok(warnFail.alerts.some((a) => a.metric === 'oracle_post_failures' && a.level === 'warning'));

  const warnAge = evaluateOracleHealth({ onChainAgeSecs: 65 });
  assert.equal(warnAge.severity, 'warning');
  assert.equal(warnAge.stopLoop, false);
  assert.ok(warnAge.alerts.some((a) => a.metric === 'oracle_staleness' && a.level === 'warning'));
});

test('evaluateOracleHealth: critical alert and stopLoop at 10 failures or 600s age', () => {
  const critFail = evaluateOracleHealth({ consecutiveFailures: 10 });
  assert.equal(critFail.ok, false);
  assert.equal(critFail.severity, 'critical');
  assert.equal(critFail.stopLoop, true);
  assert.ok(critFail.alerts.some((a) => a.metric === 'oracle_post_failures' && a.level === 'critical'));

  const critAge = evaluateOracleHealth({ onChainAgeSecs: 600 });
  assert.equal(critAge.ok, false);
  assert.equal(critAge.severity, 'critical');
  assert.equal(critAge.stopLoop, true);
  assert.ok(critAge.alerts.some((a) => a.metric === 'oracle_staleness' && a.level === 'critical'));
});

test('sanitizeHealthPayload strips all keys, API secrets, and sensitive URLs', () => {
  const dirty = {
    ok: true,
    rpcUrl: 'https://devnet.helius-rpc.com/?api-key=123456789abcdef',
    RPC_URL: 'secret',
    NEXT_PUBLIC_RPC_URL: 'secret',
    keypairPath: '/path/to/id.json',
    secretKey: [1, 2, 3],
    privateKey: 'abc',
    apiKey: 'xyz',
    rpcHost: 'api.devnet.solana.com',
    oracleAccount: 'CsSqVZMoXixNYstNhTtixeT4pyRgrYnXdpfoXQBgFPqZ',
    aggregatePrice: '87500000',
  };

  const clean = sanitizeHealthPayload(dirty);
  assert.equal(clean.rpcUrl, undefined);
  assert.equal(clean.RPC_URL, undefined);
  assert.equal(clean.NEXT_PUBLIC_RPC_URL, undefined);
  assert.equal(clean.keypairPath, undefined);
  assert.equal(clean.secretKey, undefined);
  assert.equal(clean.privateKey, undefined);
  assert.equal(clean.apiKey, undefined);

  assert.equal(clean.rpcHost, 'api.devnet.solana.com');
  assert.equal(clean.oracleAccount, 'CsSqVZMoXixNYstNhTtixeT4pyRgrYnXdpfoXQBgFPqZ');
  assert.equal(clean.aggregatePrice, '87500000');

  const jsonStr = JSON.stringify(clean);
  assert.equal(/api-key|secret|privateKey|rpcUrl/i.test(jsonStr), false);
});
