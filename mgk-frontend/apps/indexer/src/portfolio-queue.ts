/**
 * Shared portfolio creation queue.
 * Both the REST API (portfolio.ts) and the keeper (keeper.ts) must use this
 * same module to ensure they share the same globalThis.__portfolioQueue instance.
 */
declare global {
  // eslint-disable-next-line no-var
  var __portfolioQueue: Set<string> | undefined;
}

export function getPortfolioQueue(): Set<string> {
  if (!globalThis.__portfolioQueue) {
    globalThis.__portfolioQueue = new Set<string>();
  }
  return globalThis.__portfolioQueue;
}
