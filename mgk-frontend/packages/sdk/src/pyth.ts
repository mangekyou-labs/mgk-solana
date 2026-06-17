/**
 * Minimal Hermes HTTP client for the Pyth Network.
 *
 * Hermes is Pyth's hosted price service: `https://hermes.pyth.network/v2`.
 * It serves the same feed IDs across networks (the feed ID is a
 * content-addressed hash, not chain-specific), so the same IDs work for
 * devnet and mainnet fetches.
 *
 * This module is HTTP-agnostic — it only exports the URL builder, the
 * response type, and a pure parser. The actual `fetch` lives in
 * `apps/web/lib/feeds/pyth.ts` so the SDK stays isomorphic and testable
 * in node.
 */

/** Default Hermes base URL (no trailing slash). */
export const HERMES_BASE_URL = 'https://hermes.pyth.network';

/** Path for the "latest price" endpoint. */
export const HERMES_LATEST_PATH = '/v2/updates/price/latest';

/**
 * Build the URL for the Hermes "latest price" endpoint.
 *
 * @param feedIds - array of 32-byte feed IDs, hex-encoded without `0x` prefix
 * @param baseUrl - optional override (defaults to the public Hermes endpoint)
 *
 * @example
 *   hermesLatestUrl(['e62df6...c0d2', '...'])
 *   // → 'https://hermes.pyth.network/v2/updates/price/latest?ids[]=e62df6...&ids[]=...'
 */
export function hermesLatestUrl(feedIds: readonly string[], baseUrl?: string): string {
  const base = baseUrl ?? HERMES_BASE_URL;
  const params = feedIds.map((id) => `ids[]=${encodeURIComponent(id)}`).join('&');
  return `${base}${HERMES_LATEST_PATH}?${params}`;
}

/**
 * Build the URL for a Hermes historical price at a given Unix timestamp.
 *
 * Example: `hermesHistoryUrl('ef0d...', 1750000000)` →
 *   `https://hermes.pyth.network/v2/updates/price/1750000000?ids[]=ef0d...`
 */
export function hermesHistoryUrl(
  feedId: string,
  timestampS: number,
  baseUrl?: string,
): string {
  const base = baseUrl ?? HERMES_BASE_URL;
  return `${base}/v2/updates/price/${timestampS}?ids[]=${encodeURIComponent(feedId)}`;
}

/** Shape of the `price` object inside a parsed Hermes feed. */
export interface PythPriceFeed {
  /** Feed price as a stringified integer (Pyth returns strings to avoid JS number precision loss). */
  price: string;
  /** Confidence interval (stringified integer). */
  conf: string;
  /** Exponent — multiply `price` by `10^expo` to get the actual value. */
  expo: number;
  /** Unix seconds when the publisher signed the price. */
  publish_time: number;
}

/** Shape of a single entry in the `parsed` array of a Hermes latest response. */
export interface PythLatestParsed {
  /** Hex-encoded feed ID (with `0x` prefix). */
  id: string;
  price: PythPriceFeed;
  ema_price: PythPriceFeed;
}

/** Shape of the JSON response from the Hermes latest endpoint. */
export interface HermesLatestResponse {
  binary: { encoding: string; data: string[] };
  parsed: PythLatestParsed[];
}

/**
 * Normalized price record — what the rest of the app should consume.
 * The price is converted to a bigint scaled by `10^DECIMALS` for lossless
 * arithmetic, and the original `expo` is preserved so callers can scale
 * to whatever unit they need.
 */
export interface NormalizedPythPrice {
  /** Hex feed ID (with `0x` prefix). */
  id: string;
  /** Price as bigint. Multiply by `10^expo` to get the actual value. */
  price: bigint;
  /** Confidence as bigint. */
  conf: bigint;
  /** Original exponent from Pyth. */
  expo: number;
  /** Unix seconds. */
  publishTime: number;
}

/** Hard-coded fixed-decimal scale for app-level price display. */
export const NORMALIZED_DECIMALS = 6;

/**
 * Convert a `PythPriceFeed` to a `NormalizedPythPrice` (bigint price +
 * scaled to `NORMALIZED_DECIMALS`). Two-phase conversion:
 *
 *   1. real = price × 10^expo
 *   2. scaled = round(real × 10^NORMALIZED_DECIMALS)
 *
 * Implemented in bigint math so we never round-trip through JS `number`
 * (which loses precision for 64-bit Pyth values).
 */
export function normalizePythPrice(
  feed: PythLatestParsed,
  targetDecimals: number = NORMALIZED_DECIMALS,
): NormalizedPythPrice {
  const expo = feed.price.expo;
  const priceBig = BigInt(feed.price.price);
  const confBig = BigInt(feed.price.conf);

  // shift = targetDecimals + expo
  //   If expo is negative (typical: -8), shift is targetDecimals - 8
  //   so we multiply by 10^(targetDecimals + expo).
  const shift = targetDecimals + expo;

  let scaledPrice: bigint;
  let scaledConf: bigint;
  if (shift >= 0) {
    scaledPrice = priceBig * 10n ** BigInt(shift);
    scaledConf = confBig * 10n ** BigInt(shift);
  } else {
    const divisor = 10n ** BigInt(-shift);
    // Banker's-round to nearest for positive and negative values.
    scaledPrice = divideRounded(priceBig, divisor);
    scaledConf = divideRounded(confBig, divisor);
  }

  return {
    id: feed.id,
    price: scaledPrice,
    conf: scaledConf,
    expo,
    publishTime: feed.price.publish_time,
  };
}

/**
 * Parse a Hermes latest response into normalized prices. The `parsed`
 * array is the JSON shape; `binary` is ignored (we don't need the
 * raw protobuf in the UI).
 */
export function parseHermesLatest(body: HermesLatestResponse): NormalizedPythPrice[] {
  return body.parsed.map((feed) => normalizePythPrice(feed));
}

/**
 * Banker's-rounded integer division. Rounds half-to-even to avoid the
 * bias of always-rounding-half-up.
 */
function divideRounded(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new Error('divideRounded: division by zero');
  const negative = (n < 0n) !== (d < 0n);
  const a = n < 0n ? -n : n;
  const b = d < 0n ? -d : d;
  const quotient = a / b;
  const remainder = a % b;
  const twiceRem = remainder * 2n;
  let result: bigint;
  if (twiceRem < b) {
    result = quotient;
  } else if (twiceRem > b) {
    result = quotient + 1n;
  } else {
    // Exactly half — round to even.
    result = quotient % 2n === 0n ? quotient : quotient + 1n;
  }
  return negative ? -result : result;
}
