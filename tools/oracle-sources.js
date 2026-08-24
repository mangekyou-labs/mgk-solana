'use strict';

/**
 * Multi-venue index oracle sources & median aggregation.
 *
 * Supported venues:
 *   1. Binance Spot SOLUSDT (https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT)
 *   2. Coinbase SOL-USD (https://api.exchange.coinbase.com/products/SOL-USD/ticker)
 *   3. OKX Spot SOL-USDT (https://www.okx.com/api/v5/market/ticker?instId=SOL-USDT)
 *   4. Bybit Spot SOLUSDT (https://api.bybit.com/v5/market/tickers?category=spot&symbol=SOLUSDT)
 */

const SCALE_DECIMALS = 6;
const SCALE_FACTOR = 1_000_000n;
const BPS_DENOM = 10_000n;

/** Default config */
const DEFAULTS = {
  fetchTimeoutMs: 3000,
  minVenues: 3,
  maxDeviationBps: 100, // 100 bps = 1.00%
};

/**
 * Fetch with timeout using AbortController.
 */
async function fetchWithTimeout(url, timeoutMs, customFetch = fetch) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await customFetch(url, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'mgk-index-oracle/1.0',
      },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Convert price string/number to bigint scaled by 1e6.
 * Rejects non-finite, negative, or zero values.
 */
function parseScaledPrice(val) {
  if (val == null) throw new Error('Null or undefined price');
  const num = typeof val === 'number' ? val : parseFloat(String(val));
  if (!Number.isFinite(num) || num <= 0) {
    throw new Error(`Invalid non-positive price: ${val}`);
  }
  return BigInt(Math.round(num * Number(SCALE_FACTOR)));
}

/**
 * Binance Spot SOLUSDT adapter.
 * Response: {"symbol":"SOLUSDT","price":"87.12340000"}
 */
async function fetchBinance(timeoutMs = DEFAULTS.fetchTimeoutMs, customFetch = fetch) {
  const json = await fetchWithTimeout(
    'https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT',
    timeoutMs,
    customFetch,
  );
  if (!json || typeof json !== 'object' || !json.price) {
    throw new Error('Binance response missing price field');
  }
  return parseScaledPrice(json.price);
}

/**
 * Coinbase SOL-USD adapter.
 * Response: {"price":"87.123", ...}
 */
async function fetchCoinbase(timeoutMs = DEFAULTS.fetchTimeoutMs, customFetch = fetch) {
  const json = await fetchWithTimeout(
    'https://api.exchange.coinbase.com/products/SOL-USD/ticker',
    timeoutMs,
    customFetch,
  );
  if (!json || typeof json !== 'object' || !json.price) {
    throw new Error('Coinbase response missing price field');
  }
  return parseScaledPrice(json.price);
}

/**
 * OKX Spot SOL-USDT adapter.
 * Response: {"code":"0","data":[{"instId":"SOL-USDT","last":"87.12", ...}]}
 */
async function fetchOkx(timeoutMs = DEFAULTS.fetchTimeoutMs, customFetch = fetch) {
  const json = await fetchWithTimeout(
    'https://www.okx.com/api/v5/market/ticker?instId=SOL-USDT',
    timeoutMs,
    customFetch,
  );
  if (!json || typeof json !== 'object') {
    throw new Error('OKX invalid response format');
  }
  if (json.code !== '0' && json.code !== 0) {
    throw new Error(`OKX error code: ${json.code} msg: ${json.msg || ''}`);
  }
  if (!Array.isArray(json.data) || json.data.length === 0) {
    throw new Error('OKX response missing data array');
  }
  const item = json.data[0];
  const rawPrice = item.last || item.lastPx;
  if (!rawPrice) {
    throw new Error('OKX response missing last price field');
  }
  return parseScaledPrice(rawPrice);
}

/**
 * Bybit Spot SOLUSDT adapter.
 * Response: {"retCode":0,"result":{"list":[{"symbol":"SOLUSDT","lastPrice":"87.12", ...}]}}
 */
async function fetchBybit(timeoutMs = DEFAULTS.fetchTimeoutMs, customFetch = fetch) {
  const json = await fetchWithTimeout(
    'https://api.bybit.com/v5/market/tickers?category=spot&symbol=SOLUSDT',
    timeoutMs,
    customFetch,
  );
  if (!json || typeof json !== 'object') {
    throw new Error('Bybit invalid response format');
  }
  if (json.retCode !== 0 && json.retCode !== '0') {
    throw new Error(`Bybit error retCode: ${json.retCode} msg: ${json.retMsg || ''}`);
  }
  if (!json.result || !Array.isArray(json.result.list) || json.result.list.length === 0) {
    throw new Error('Bybit response missing result.list');
  }
  const item = json.result.list[0];
  if (!item.lastPrice) {
    throw new Error('Bybit response missing lastPrice field');
  }
  return parseScaledPrice(item.lastPrice);
}

/**
 * Calculate median of a list of BigInt values.
 * Returns middle element for odd length; integer average of middle two for even length.
 */
function calculateMedian(sortedPrices) {
  const n = sortedPrices.length;
  if (n === 0) throw new Error('Cannot calculate median of empty list');
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) {
    return sortedPrices[mid];
  }
  return (sortedPrices[mid - 1] + sortedPrices[mid]) / 2n;
}

/**
 * Calculate absolute difference between two bigints.
 */
function absDiff(a, b) {
  return a >= b ? a - b : b - a;
}

/**
 * Filter outliers and compute final median and confidence.
 *
 * Algorithm:
 *   1. Calculate preliminary median M_pre of all valid venue prices.
 *   2. Filter out prices where |p - M_pre| * 10000 > M_pre * maxDeviationBps.
 *   3. If remaining accepted count < minVenues, fail cycle (quorum not met).
 *   4. Compute final median M of accepted prices.
 *   5. Compute confidence as max |p - M| across accepted prices.
 */
function aggregatePrices(venuePrices, options = {}) {
  const minVenues = options.minVenues != null ? options.minVenues : DEFAULTS.minVenues;
  const maxDeviationBps = BigInt(
    options.maxDeviationBps != null ? options.maxDeviationBps : DEFAULTS.maxDeviationBps,
  );

  if (minVenues < 3 || minVenues > 4) {
    throw new Error(`minVenues must be constrained to 3-4 (got ${minVenues})`);
  }

  const validEntries = Object.entries(venuePrices).filter(
    ([, val]) => val && typeof val.price === 'bigint' && val.price > 0n,
  );

  if (validEntries.length < minVenues) {
    return {
      ok: false,
      reason: 'insufficient_sources',
      validSourceCount: validEntries.length,
      minVenues,
      acceptedVenues: validEntries.map(([name]) => name),
      rejectedVenues: [],
    };
  }

  // Sort prices ascending
  const sortedValid = [...validEntries].sort((a, b) => (a[1].price < b[1].price ? -1 : a[1].price > b[1].price ? 1 : 0));
  const pricesOnly = sortedValid.map(([, v]) => v.price);
  const prelimMedian = calculateMedian(pricesOnly);

  // Filter outliers
  const accepted = [];
  const rejected = [];

  for (const [name, entry] of sortedValid) {
    const diff = absDiff(entry.price, prelimMedian);
    // diff / prelimMedian > maxDeviationBps / 10000 <=> diff * 10000 > prelimMedian * maxDeviationBps
    if (diff * BPS_DENOM > prelimMedian * maxDeviationBps) {
      rejected.push({
        venue: name,
        price: entry.price,
        deviationBps: Number((diff * BPS_DENOM) / prelimMedian),
        reason: 'outlier_deviation',
      });
    } else {
      accepted.push([name, entry.price]);
    }
  }

  if (accepted.length < minVenues) {
    return {
      ok: false,
      reason: 'quorum_lost_to_outliers',
      prelimMedian,
      acceptedCount: accepted.length,
      minVenues,
      acceptedVenues: accepted.map(([name]) => name),
      rejectedVenues: rejected,
    };
  }

  // Final median of accepted venues
  const acceptedPrices = accepted.map(([, p]) => p).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const finalMedian = calculateMedian(acceptedPrices);

  // Confidence: maximum absolute deviation of accepted prices from final median
  let maxDev = 0n;
  for (const p of acceptedPrices) {
    const dev = absDiff(p, finalMedian);
    if (dev > maxDev) {
      maxDev = dev;
    }
  }

  return {
    ok: true,
    price: finalMedian,
    confidence: maxDev,
    prelimMedian,
    acceptedVenues: accepted.map(([name]) => name),
    rejectedVenues: rejected,
    venueCount: accepted.length,
  };
}

/**
 * Concurrently fetch from all 4 sources and aggregate.
 * Never carries venue values into later cycles.
 */
async function fetchAllAndAggregate(options = {}) {
  const timeoutMs = options.fetchTimeoutMs != null ? options.fetchTimeoutMs : DEFAULTS.fetchTimeoutMs;
  const customFetch = options.customFetch || fetch;

  const venues = [
    { name: 'binance', fn: () => fetchBinance(timeoutMs, customFetch) },
    { name: 'coinbase', fn: () => fetchCoinbase(timeoutMs, customFetch) },
    { name: 'okx', fn: () => fetchOkx(timeoutMs, customFetch) },
    { name: 'bybit', fn: () => fetchBybit(timeoutMs, customFetch) },
  ];

  const results = await Promise.allSettled(
    venues.map(async (v) => {
      const price = await v.fn();
      return { name: v.name, price };
    }),
  );

  const venuePrices = {};
  const fetchErrors = {};

  for (let i = 0; i < venues.length; i++) {
    const res = results[i];
    const name = venues[i].name;
    if (res.status === 'fulfilled') {
      venuePrices[name] = { price: res.value.price };
    } else {
      fetchErrors[name] = res.reason?.message || String(res.reason);
    }
  }

  const agg = aggregatePrices(venuePrices, options);
  return {
    ...agg,
    venuePrices,
    fetchErrors,
  };
}

module.exports = {
  SCALE_FACTOR,
  DEFAULTS,
  parseScaledPrice,
  fetchBinance,
  fetchCoinbase,
  fetchOkx,
  fetchBybit,
  calculateMedian,
  aggregatePrices,
  fetchAllAndAggregate,
};
