/**
 * Browser-side wrapper around the Pyth Hermes HTTP API.
 *
 * The SDK (`@mgk/sdk`) provides the URL builder + response parser; this
 * module adds the actual `fetch` + timeout + retry, plus a small Zustand
 * store that polls on an interval.
 */

import {
  hermesLatestUrl,
  parseHermesLatest,
  type HermesLatestResponse,
  type NormalizedPythPrice,
} from '@mgk/sdk';

import { config } from '@/lib/config';

export interface FetchPythLatestOptions {
  /** Total request timeout in ms. Default 5000. */
  timeoutMs?: number;
  /** Optional AbortSignal to cancel mid-flight. */
  signal?: AbortSignal;
  /** Override base URL (defaults to `config.hermesUrl`). */
  baseUrl?: string;
}

/**
 * Fetch the latest price for the given feed IDs from Hermes. Returns
 * the normalized prices (bigint, scaled to 1e6). Throws on HTTP error
 * or timeout.
 */
export async function fetchPythLatest(
  feedIds: readonly string[],
  opts: FetchPythLatestOptions = {},
): Promise<NormalizedPythPrice[]> {
  if (feedIds.length === 0) return [];
  const url = hermesLatestUrl(feedIds, opts.baseUrl ?? config.hermesUrl);
  const timeout = opts.timeoutMs ?? 5000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  // Compose external signal with our timeout signal.
  if (opts.signal) {
    if (opts.signal.aborted) {
      clearTimeout(timer);
      throw new Error('fetchPythLatest: aborted');
    }
    opts.signal.addEventListener(
      'abort',
      () => controller.abort(),
      { once: true },
    );
  }

  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(
        `fetchPythLatest: HTTP ${res.status} ${res.statusText} for ${url}`,
      );
    }
    const body = (await res.json()) as HermesLatestResponse;
    return parseHermesLatest(body);
  } catch (e) {
    // jsdom's DOMException has `name === 'AbortError'` but
    // `instanceof Error` is false; the check on `name` works in both
    // browsers and jsdom, so use it.
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error(
        `fetchPythLatest: timed out after ${timeout}ms (${url})`,
      );
    }
    if (
      typeof e === 'object' &&
      e !== null &&
      'name' in e &&
      (e as { name: unknown }).name === 'AbortError'
    ) {
      throw new Error(
        `fetchPythLatest: timed out after ${timeout}ms (${url})`,
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
