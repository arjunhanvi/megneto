'use client';

/**
 * LAYER 2 - THE DIVE
 *
 * The veil is what makes the macro -> micro handoff survivable on 4GB of VRAM.
 *
 * A true cross-fade would require the Cesium globe and the R3F scene to be
 * alive in the same frame. On a GTX 1650 that is a guaranteed stutter, and
 * quite possibly a lost context. So instead the veil closes over the globe, the
 * globe is destroyed, the factory is built behind the veil, and the veil opens.
 * The audience reads it as one continuous dive; the GPU only ever holds one
 * scene.
 */

import { useEffect, useRef, useState } from 'react';
import type { Phase } from '@/store/useMegnetoStore';

interface Step {
  opacity: number;
  duration: number;
  /** ms to wait before applying. */
  delay: number;
}

/** Per-phase veil choreography, tuned against the Cesium flight durations. */
const SCRIPT: Record<Phase, Step[]> = {
  macro: [{ opacity: 0, duration: 600, delay: 0 }],
  // Cesium flies for 4.2s. Stay clear for the first half, then close.
  descending: [
    { opacity: 0, duration: 200, delay: 0 },
    { opacity: 1, duration: 1700, delay: 2500 },
  ],
  handoff: [{ opacity: 1, duration: 150, delay: 0 }],
  micro: [{ opacity: 0, duration: 850, delay: 120 }],
  // Close fast, hold while the factory is released and the globe is rebuilt,
  // then re-open so the audience watches the globe pull away.
  ascending: [
    { opacity: 1, duration: 200, delay: 0 },
    { opacity: 0, duration: 900, delay: 1300 },
  ],
};

const STATUS: Record<Phase, (site: string, city: string) => string> = {
  macro: () => 'ORBITAL UPLINK STABLE · TWO NODES LIVE',
  descending: (site, city) => `DESCENDING TO ${site} · ${city.toUpperCase()}`,
  handoff: () => 'RELEASING ORBITAL BUFFERS · BUILDING FACILITY MESH',
  micro: (site) => `${site} · FLOOR TELEMETRY LIVE`,
  ascending: () => 'RELEASING FACILITY MESH · RE-ACQUIRING ORBIT',
};

export interface TransitionVeilProps {
  phase: Phase;
  /** The node this dive is heading for, named on the veil. */
  siteName: string;
  city: string;
}

export default function TransitionVeil({ phase, siteName, city }: TransitionVeilProps) {
  const [state, setState] = useState<{ opacity: number; duration: number }>({
    opacity: 0,
    duration: 400,
  });
  const timers = useRef<number[]>([]);

  useEffect(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];

    for (const step of SCRIPT[phase]) {
      if (step.delay === 0) {
        setState({ opacity: step.opacity, duration: step.duration });
      } else {
        timers.current.push(
          window.setTimeout(() => setState({ opacity: step.opacity, duration: step.duration }), step.delay),
        );
      }
    }

    return () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
    };
  }, [phase]);

  const busy = phase === 'descending' || phase === 'handoff' || phase === 'ascending';

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 z-40 bg-white"
      style={{
        opacity: state.opacity,
        transition: `opacity ${state.duration}ms cubic-bezier(0.4, 0, 0.2, 1)`,
      }}
    >
      {/* scanline field */}
      <div className="absolute inset-0 opacity-25 [background-image:repeating-linear-gradient(0deg,#1a8fd1_0px,#1a8fd1_1px,transparent_1px,transparent_4px)]" />
      {/* sweeping beam */}
      <div className="absolute inset-x-0 top-0 h-32 animate-sweep bg-gradient-to-b from-transparent via-signal-cyan/10 to-transparent" />

      <div className="absolute inset-0 grid place-items-center">
        <div className="w-[min(520px,82vw)] text-center">
          {/* reticle */}
          <div className="relative mx-auto h-24 w-24">
            <div className="absolute inset-0 rounded-full border border-signal-cyan/30" />
            <div className="absolute inset-0 animate-pulse-ring rounded-full border border-signal-cyan/50" />
            <div className="absolute inset-[18px] rounded-full border border-signal-cyan/20" />
            <div className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-signal-cyan/15" />
            <div className="absolute top-1/2 h-px w-full -translate-y-1/2 bg-signal-cyan/15" />
            <div className="absolute inset-0 grid place-items-center font-mono text-[10px] tracking-[0.2em] text-signal-cyan">
              {phase === 'ascending' ? 'EXIT' : 'LOCK'}
            </div>
          </div>

          <p className="mt-6 font-mono text-[11px] tracking-[0.34em] text-signal-cyan">{STATUS[phase](siteName, city)}</p>

          {/* indeterminate bar */}
          <div className="mx-auto mt-4 h-[2px] w-56 overflow-hidden rounded-full bg-frost-400">
            <div
              className="h-full w-1/3 rounded-full bg-signal-cyan"
              style={{
                animation: busy ? 'veil-scan 1.3s ease-in-out infinite' : 'none',
                opacity: busy ? 1 : 0,
              }}
            />
          </div>

          <p className="mt-5 font-mono text-[9px] leading-relaxed tracking-[0.2em] text-ink-400">
            MEGNETO SPATIAL ENGINE · SINGLE-CONTEXT HANDOFF
            <br />
            ONE RENDERER RESIDENT · VRAM CEILING 4096 MB
          </p>
        </div>
      </div>

      <style jsx>{`
        @keyframes veil-scan {
          0% {
            transform: translateX(-120%);
          }
          100% {
            transform: translateX(320%);
          }
        }
      `}</style>
    </div>
  );
}
