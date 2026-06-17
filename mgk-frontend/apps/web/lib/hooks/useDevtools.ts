'use client';

import { useSearchParams } from 'next/navigation';

/**
 * Returns true when the URL has `?devtools=1`. Used to gate the
 * dev-only "Crank" / "Liquidate" buttons (T2.5, T6.7) so they never
 * appear in production builds / normal dev sessions.
 *
 * IMPORTANT: callers that use this hook must be wrapped in
 * `<Suspense>` (typically at the page level) so the route can stay
 * statically prerendered — `useSearchParams` opts the route out of
 * static rendering otherwise.
 */
export function useDevtools(): boolean {
  const sp = useSearchParams();
  return sp?.get('devtools') === '1';
}
