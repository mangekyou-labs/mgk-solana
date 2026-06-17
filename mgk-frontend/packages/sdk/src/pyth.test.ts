import { describe, expect, it } from 'vitest';

import {
  HERMES_BASE_URL,
  HERMES_LATEST_PATH,
  NORMALIZED_DECIMALS,
  hermesLatestUrl,
  normalizePythPrice,
  parseHermesLatest,
  type HermesLatestResponse,
} from './pyth.js';

describe('hermesLatestUrl', () => {
  it('builds a single-id URL with the public Hermes endpoint by default', () => {
    const url = hermesLatestUrl(['e62df6c8cb4a85fc1cc93902bb6c5e4b2d62f8b3']);
    expect(url).toBe(
      `${HERMES_BASE_URL}${HERMES_LATEST_PATH}?ids[]=e62df6c8cb4a85fc1cc93902bb6c5e4b2d62f8b3`,
    );
  });

  it('joins multiple ids with &', () => {
    const url = hermesLatestUrl(['aaaa', 'bbbb', 'cccc']);
    expect(url).toBe(
      `${HERMES_BASE_URL}${HERMES_LATEST_PATH}?ids[]=aaaa&ids[]=bbbb&ids[]=cccc`,
    );
  });

  it('respects a custom baseUrl', () => {
    const url = hermesLatestUrl(['feed1'], 'https://my-hermes.example.com');
    expect(url).toBe(
      `https://my-hermes.example.com${HERMES_LATEST_PATH}?ids[]=feed1`,
    );
  });

  it('URI-encodes special characters in feed IDs', () => {
    const url = hermesLatestUrl(['with space']);
    expect(url).toContain('ids[]=with%20space');
  });
});

describe('normalizePythPrice', () => {
  it('scales a price with expo=-8 to NORMALIZED_DECIMALS (6)', () => {
    // Pyth price = 150_420_000 (integer), expo = -8
    // real = 150_420_000 * 10^-8 = 1.50420
    // scaled = 1.50420 * 10^6 = 1_504_200
    const result = normalizePythPrice({
      id: '0xfeed',
      price: {
        price: '150420000',
        conf: '50000',
        expo: -8,
        publish_time: 1_700_000_000,
      },
      ema_price: { price: '0', conf: '0', expo: -8, publish_time: 0 },
    });
    expect(result.id).toBe('0xfeed');
    expect(result.price).toBe(1_504_200n);
    expect(result.conf).toBe(500n); // 0.00050 * 10^6 = 500
    expect(result.expo).toBe(-8);
    expect(result.publishTime).toBe(1_700_000_000);
  });

  it('scales a price with expo=-6 (1:1 with normalized scale)', () => {
    // Pyth price = 150_420_000, expo = -6
    // real = 150.42
    // scaled = 150.42 * 10^6 = 150_420_000
    const result = normalizePythPrice({
      id: '0xfeed',
      price: { price: '150420000', conf: '100', expo: -6, publish_time: 0 },
      ema_price: { price: '0', conf: '0', expo: -6, publish_time: 0 },
    });
    expect(result.price).toBe(150_420_000n);
  });

  it('scales a price with positive expo by multiplying', () => {
    // Pyth price = 5, expo = 3
    // real = 5 * 10^3 = 5000
    // scaled = 5000 * 10^6 = 5_000_000_000
    const result = normalizePythPrice({
      id: '0xfeed',
      price: { price: '5', conf: '1', expo: 3, publish_time: 0 },
      ema_price: { price: '0', conf: '0', expo: 3, publish_time: 0 },
    });
    expect(result.price).toBe(5_000_000_000n);
  });

  it('handles negative prices (downward move)', () => {
    const result = normalizePythPrice({
      id: '0xfeed',
      price: { price: '-100', conf: '0', expo: -8, publish_time: 0 },
      ema_price: { price: '0', conf: '0', expo: -8, publish_time: 0 },
    });
    expect(result.price).toBe(-1n); // -0.00000100 * 10^6
  });

  it('preserves precision for a full-u64 price value (no JS number overflow)', () => {
    // Max u64 = 18_446_744_073_709_551_615; this is the typical max Pyth price value
    const maxU64 = '18446744073709551615';
    const result = normalizePythPrice({
      id: '0xfeed',
      price: { price: maxU64, conf: '0', expo: -8, publish_time: 0 },
      ema_price: { price: '0', conf: '0', expo: -8, publish_time: 0 },
    });
    // shift = 6 + -8 = -2, so divide by 100 with banker's rounding
    // 18_446_744_073_709_551_615 / 100 = 184_467_440_737_095_516 (truncated, then check round)
    // 184_467_440_737_095_516 * 100 = 18_446_744_073_709_551_600
    // remainder = 15, 2*15=30 > 100? no, 30 < 100 → quotient
    expect(result.price).toBe(184_467_440_737_095_516n);
  });

  it('uses bankers rounding (half-to-even) for negative-shift division', () => {
    // price = 150, expo = -1 → real = 15.0 → scaled = 15_000_000
    const r1 = normalizePythPrice({
      id: '0x',
      price: { price: '150', conf: '0', expo: -1, publish_time: 0 },
      ema_price: { price: '0', conf: '0', expo: -1, publish_time: 0 },
    });
    expect(r1.price).toBe(15_000_000n);

    // price = 151, expo = -1 → real = 15.1 → scaled = 15_100_000
    const r2 = normalizePythPrice({
      id: '0x',
      price: { price: '151', conf: '0', expo: -1, publish_time: 0 },
      ema_price: { price: '0', conf: '0', expo: -1, publish_time: 0 },
    });
    expect(r2.price).toBe(15_100_000n);
  });
});

describe('parseHermesLatest', () => {
  it('returns a normalized price for each parsed feed', () => {
    const body: HermesLatestResponse = {
      binary: { encoding: 'base64', data: [] },
      parsed: [
        {
          id: '0xfeed1',
          price: { price: '100000000', conf: '100', expo: -8, publish_time: 100 },
          ema_price: { price: '0', conf: '0', expo: -8, publish_time: 0 },
        },
        {
          id: '0xfeed2',
          price: { price: '200000000', conf: '200', expo: -8, publish_time: 200 },
          ema_price: { price: '0', conf: '0', expo: -8, publish_time: 0 },
        },
      ],
    };
    const out = parseHermesLatest(body);
    expect(out).toHaveLength(2);
    expect(out[0]!.id).toBe('0xfeed1');
    expect(out[0]!.price).toBe(1_000_000n); // 1.0 * 10^6
    expect(out[1]!.price).toBe(2_000_000n); // 2.0 * 10^6
  });

  it('returns an empty array when parsed is empty', () => {
    const out = parseHermesLatest({ binary: { encoding: 'base64', data: [] }, parsed: [] });
    expect(out).toEqual([]);
  });
});

describe('NORMALIZED_DECIMALS', () => {
  it('is 6 (matches the on-chain 1e6 scale used for prices/qty/collateral)', () => {
    expect(NORMALIZED_DECIMALS).toBe(6);
  });
});
