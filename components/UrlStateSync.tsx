'use client';

/**
 * URL ⇄ STATE
 *
 * `megneto.vercel.app/?site=tiruppur&floor=2` must open straight onto the
 * second floor of the Tiruppur mill, with no globe, no dive, and no clicking.
 * That is what makes the pitch forwardable: whoever receives the link lands
 * exactly where the sender was standing.
 *
 * ============================================================================
 * TWO RULES THAT KEEP THIS FROM BECOMING A RE-RENDER PUMP
 * ============================================================================
 *  1. The URL is read ONCE, at mount. After that it is write-only. A link can
 *     open a view; it can never yank a presenter out of one mid-demo because
 *     some effect re-fired.
 *
 *  2. Writes go through `router.replace(..., { scroll: false })` and only when
 *     the serialised value actually CHANGES. Calling replace on every store
 *     update would re-render the route tree sixty times a second — which is
 *     exactly the kind of thing this codebase exists to avoid.
 *
 * `useSearchParams` forces a Suspense boundary in a statically rendered App
 * Router page, which is why this is its own component and why page.tsx wraps
 * it. Keeping it separate also means the rest of the app never re-renders when
 * the query string changes.
 * ============================================================================
 */

import { useEffect, useRef } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { isSiteId, parseFloorParam } from '@/lib/sites';
import { useMegnetoStore } from '@/store/useMegnetoStore';

export default function UrlStateSync() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const hydrated = useRef(false);
  const lastWritten = useRef<string | null>(null);

  /* ---------------- read, once ---------------- */
  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;

    const siteParam = searchParams.get('site');
    const floorParam = searchParams.get('floor');
    const site = isSiteId(siteParam) ? siteParam : null;
    const floor = parseFloorParam(floorParam);

    // No params at all: leave the app on the globe, as normal.
    if (!site && !floorParam) return;

    useMegnetoStore.getState().hydrateFromUrl(site, floor);
    // searchParams is intentionally not a dependency: this is a one-shot read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------- write, on real changes only ---------------- */
  useEffect(() => {
    const unsub = useMegnetoStore.subscribe((state, prev) => {
      if (
        state.phase === prev.phase &&
        state.activeSite === prev.activeSite &&
        state.activeFloor === prev.activeFloor
      ) {
        return;
      }

      // The globe is the app's "no state" view, so it gets a clean URL.
      const next =
        state.phase === 'micro'
          ? `?site=${state.activeSite}&floor=${state.activeFloor}`
          : '';

      if (next === lastWritten.current) return;
      lastWritten.current = next;
      router.replace(`${pathname}${next}`, { scroll: false });
    });
    return unsub;
  }, [router, pathname]);

  return null;
}
