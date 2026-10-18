'use client';

/**
 * MEGNETO V3 — MASTER ORCHESTRATOR
 *
 * The whole demo is one screen with one job: guarantee that the CesiumJS globe
 * and the React Three Fiber facility are NEVER alive at the same moment.
 *
 *   phase        Cesium              R3F        veil
 *   -----------------------------------------------------------
 *   macro        mounted             —          clear
 *   descending   flying to the site  —          closes at 2.5s
 *   handoff      DESTROYED           mounting   opaque
 *   micro        —                   mounted    clear
 *   ascending    rebuilt AFTER R3F   DESTROYED  shut, then reopens
 *                leaves
 *
 * React's unmount runs Cesium's `viewer.destroy()` and R3F's own WebGL teardown
 * before the next phase's component is created, so at no point does the 4GB
 * card hold two tile caches, two sets of shader programs, or two render
 * targets. The `&& !facilityResident` on `showGlobe` closes the one window
 * where they could otherwise overlap.
 *
 * A deep link (`?site=…&floor=…`) boots straight to `micro`, which means the
 * Cesium chunk is never even fetched — the fastest path into the demo is also
 * the cheapest one.
 */

import dynamic from 'next/dynamic';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';

import CleanHUD from '@/components/CleanHUD';
import TransitionVeil from '@/components/TransitionVeil';
import UrlStateSync from '@/components/UrlStateSync';
import { SITES } from '@/lib/sites';
import { startSimulator, stopSimulator, useMegnetoStore } from '@/store/useMegnetoStore';

const MacroGlobe = dynamic(() => import('@/components/MacroGlobe'), {
  ssr: false,
  loading: () => <LayerSkeleton label="ACQUIRING ORBITAL IMAGERY" />,
});

const MicroFacility = dynamic(() => import('@/components/MicroFacility'), {
  ssr: false,
  loading: () => <LayerSkeleton label="BUILDING FACILITY STACK" />,
});

/* The overlay imports `useFrame` for its projector, so it belongs in the R3F
 * chunk, not the entry bundle. */
const FacilityOverlay = dynamic(() => import('@/components/FacilityOverlay'), { ssr: false });

function LayerSkeleton({ label }: { label: string }) {
  return (
    <div className="absolute inset-0 grid place-items-center bg-frost-200">
      <p className="animate-flicker font-mono text-[10px] tracking-[0.3em] text-signal-cyan/70">{label}</p>
    </div>
  );
}

export default function MegnetoPage() {
  const phase = useMegnetoStore((s) => s.phase);
  const activeSite = useMegnetoStore((s) => s.activeSite);
  const targetSite = useMegnetoStore((s) => s.targetSite);
  const completeDive = useMegnetoStore((s) => s.completeDive);

  /* Both sites simulate from the moment the app boots, so whichever one you
   * open has been working all morning. */
  useEffect(() => {
    startSimulator();
    return () => stopSimulator();
  }, []);

  /* Watchdog: if the R3F layer never reports a first frame (shader compile
   * failure, lost context, a missing GPU), lift the veil anyway rather than
   * stranding the presenter on a blank screen. */
  const watchdog = useRef<number | null>(null);
  useEffect(() => {
    if (phase !== 'handoff') return;
    watchdog.current = window.setTimeout(() => {
      if (useMegnetoStore.getState().phase === 'handoff') {
        console.warn('[megneto] facility layer did not report a frame in 8s — lifting veil');
        useMegnetoStore.getState().completeDive();
      }
    }, 8000);
    return () => {
      if (watchdog.current) window.clearTimeout(watchdog.current);
      watchdog.current = null;
    };
  }, [phase]);

  const onFacilityReady = useCallback(() => {
    completeDive();
  }, [completeDive]);

  /* Mount gates. These two booleans are the VRAM contract.
   *
   * The facility gets a 260ms grace period on the way out. The veil is already
   * opaque by then, and the delay gives every projected overlay a commit of its
   * own to retire before the canvas is torn out from under it. */
  const [facilityResident, setFacilityResident] = useState(false);

  useEffect(() => {
    if (phase === 'handoff' || phase === 'micro') {
      setFacilityResident(true);
      return;
    }
    if (!facilityResident) return;
    const id = window.setTimeout(() => setFacilityResident(false), 260);
    return () => window.clearTimeout(id);
  }, [phase, facilityResident]);

  const showFacility = facilityResident;
  const showGlobe =
    phase === 'macro' || phase === 'descending' || (phase === 'ascending' && !facilityResident);

  return (
    <main className="relative h-dvh w-screen overflow-hidden bg-frost-200">
      {/* useSearchParams needs a Suspense boundary in a static App Router page. */}
      <Suspense fallback={null}>
        <UrlStateSync />
      </Suspense>

      {/* ---------------- LAYER 1 : CESIUM ---------------- */}
      {showGlobe && (
        <MacroGlobe
          key={phase === 'ascending' ? 'globe-return' : 'globe-boot'}
          entry={phase === 'ascending' ? 'street' : 'space'}
          returnFrom={activeSite}
        />
      )}

      {/* ---------------- LAYER 2/3 : R3F ----------------
          The overlay is a DOM sibling of the canvas, not a child of it: its
          anchors are projected to screen space by <Projector/> inside the
          canvas. See FacilityOverlay.tsx for why that beats drei's <Html>. */}
      {showFacility && (
        <>
          <MicroFacility siteId={targetSite} onReady={onFacilityReady} />
          <FacilityOverlay siteId={targetSite} />
        </>
      )}

      {/* ---------------- THE DIVE ---------------- */}
      <TransitionVeil phase={phase} siteName={SITES[targetSite].shortName} city={SITES[targetSite].city} />

      {/* ---------------- HUD ---------------- */}
      <CleanHUD />
    </main>
  );
}
