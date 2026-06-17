import type { Store } from './store.js';

export type CandleResolution = '1m' | '5m' | '1h';

const RESOLUTION_SECONDS: Record<CandleResolution, number> = {
  '1m': 60,
  '5m': 300,
  '1h': 3600,
};

const SCALE_USD = 1_000_000;

export interface CandleInput {
  instrumentId: number;
  timestampMs: number;
  price: bigint;
  qty: bigint;
}

function bucketTs(ms: number, resolution: CandleResolution): number {
  const sec = Math.floor(ms / 1000);
  const bucket = Math.floor(sec / RESOLUTION_SECONDS[resolution]) * RESOLUTION_SECONDS[resolution];
  return bucket;
}

export function aggregateCandles(
  store: Store,
  fills: CandleInput[],
): void {
  for (const fill of fills) {
    const priceNum = Number(fill.price) / SCALE_USD;
    const qtyNum = Number(fill.qty) / SCALE_USD;

    for (const resolution of ['1m', '5m', '1h'] as CandleResolution[]) {
      const openTs = bucketTs(fill.timestampMs, resolution);
      store.upsertCandle[resolution]!.run([
        fill.instrumentId,
        openTs,
        priceNum,
        priceNum,
        priceNum,
        priceNum,
        qtyNum,
      ]);
    }

    // volume_24h is recomputed on a timer in main.ts (slides the
    // 24h window); pass 0 here as a placeholder. The next recompute
    // tick overwrites it within 60s of any fill.
    store.upsertMarketState.run([
      fill.instrumentId,
      priceNum,
      0,
      0,
      0,
      0,
      0,
      Math.floor(fill.timestampMs / 1000),
    ]);
  }
}
