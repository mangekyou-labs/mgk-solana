import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchPythLatest } from './pyth';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockFetchOnce(body: unknown, init: { status?: number; ok?: boolean } = {}): ReturnType<typeof vi.fn> {
  const f = vi.fn().mockResolvedValueOnce({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: 'OK',
    json: async () => body,
  });
  globalThis.fetch = f as unknown as typeof fetch;
  return f;
}

const sampleBody = {
  binary: { encoding: 'base64', data: [] },
  parsed: [
    {
      id: '0xfeed1',
      price: { price: '100000000', conf: '100', expo: -8, publish_time: 100 },
      ema_price: { price: '0', conf: '0', expo: -8, publish_time: 0 },
    },
  ],
};

describe('fetchPythLatest', () => {
  it('returns normalized prices on a 200 response', async () => {
    mockFetchOnce(sampleBody);
    const out = await fetchPythLatest(['feed1']);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('0xfeed1');
    expect(out[0]!.price).toBe(1_000_000n);
  });

  it('returns an empty array when feedIds is empty (no fetch)', async () => {
    const f = vi.fn();
    globalThis.fetch = f as unknown as typeof fetch;
    const out = await fetchPythLatest([]);
    expect(out).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });

  it('throws on a non-OK HTTP status', async () => {
    mockFetchOnce({}, { status: 503, ok: false });
    await expect(fetchPythLatest(['feed1'])).rejects.toThrow(/HTTP 503/);
  });

  it('times out after the configured ms', async () => {
    globalThis.fetch = vi.fn(
      (_url, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    ) as unknown as typeof fetch;
    await expect(fetchPythLatest(['feed1'], { timeoutMs: 10 })).rejects.toThrow(
      /timed out/i,
    );
  });

  it('aborts immediately if the caller signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    mockFetchOnce(sampleBody);
    await expect(
      fetchPythLatest(['feed1'], { signal: controller.signal }),
    ).rejects.toThrow(/aborted/);
  });

  it('uses a custom baseUrl when provided', async () => {
    const f = mockFetchOnce(sampleBody);
    await fetchPythLatest(['feed1'], { baseUrl: 'https://my-hermes.example.com' });
    const calledUrl = f.mock.calls[0]![0] as string;
    expect(calledUrl.startsWith('https://my-hermes.example.com/')).toBe(true);
  });
});
