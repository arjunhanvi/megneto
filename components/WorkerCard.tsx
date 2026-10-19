'use client';

/**
 * THE INDIVIDUAL RECORD
 *
 * Any one of the three thousand, inspected.
 *
 * ============================================================================
 * WHY THIS SCALES
 * ============================================================================
 * The crowd's telemetry lives in flat typed arrays — six of them, indexed by
 * instance id, about 60 KB in total. There is no array of 3,000 objects and
 * certainly no 3,000 pieces of React state.
 *
 * `workerSnapshot()` assembles exactly ONE object, on demand, for the one
 * person a human is actually looking at. This card then repaints at 8Hz
 * through `textContent`, so opening it costs a single React commit and
 * everything after that is a dozen string writes a second.
 *
 * The anchor follows the person every frame, but that happens in the
 * projector's `useFrame` inside the canvas — this component does not
 * re-render while the worker walks.
 * ============================================================================
 */

import { useCallback, useEffect, useRef } from 'react';

import type { SiteId } from '@/lib/sites';
import { getSite, useMegnetoStore, workerSnapshot } from '@/store/useMegnetoStore';
import { registerAnchor } from '@/lib/anchors';

export default function WorkerInspectionCard({ siteId, index }: { siteId: SiteId; index: number }) {
  const selectWorker = useMegnetoStore((s) => s.selectWorker);
  const focusWorker = useMegnetoStore((s) => s.focusWorker);
  const focusedWorkerIndex = useMegnetoStore((s) => s.focusedWorkerIndex);

  const nameRef = useRef<HTMLSpanElement>(null);
  const idRef = useRef<HTMLSpanElement>(null);
  const floorRef = useRef<HTMLSpanElement>(null);
  const zoneRef = useRef<HTMLSpanElement>(null);
  const stationRef = useRef<HTMLSpanElement>(null);
  const rfidRef = useRef<HTMLSpanElement>(null);
  const gaitRef = useRef<HTMLSpanElement>(null);
  const unitsRef = useRef<HTMLSpanElement>(null);
  const cadenceRef = useRef<HTMLSpanElement>(null);
  const effRef = useRef<HTMLSpanElement>(null);
  const effBarRef = useRef<HTMLDivElement>(null);
  const hrRef = useRef<HTMLSpanElement>(null);
  const strainRef = useRef<HTMLSpanElement>(null);
  const strainBarRef = useRef<HTMLDivElement>(null);
  const thermalRef = useRef<HTMLSpanElement>(null);
  const taggedRef = useRef<HTMLSpanElement>(null);

  /** The card rides on the worker, wherever they wander. */
  const anchorRef = useCallback(
    (el: HTMLDivElement | null) => {
      registerAnchor('worker-card', el, (out) => {
        const site = getSite(siteId);
        const tracked = index < site.operators.length;
        const src = tracked ? site.positions : site.mob.positions;
        const o = index * 3;
        out.set(src[o], src[o + 1] + 1.65, src[o + 2]);
      });
    },
    [siteId, index],
  );

  useEffect(() => {
    let raf = 0;
    let acc = 0;
    let last = performance.now();

    const paint = (now: number) => {
      raf = requestAnimationFrame(paint);
      acc += now - last;
      last = now;
      if (acc < 125) return; // 8Hz is plenty for a card someone is reading
      acc = 0;

      const w = workerSnapshot(siteId, index);
      if (!w) return;

      if (idRef.current) idRef.current.textContent = w.workerId;
      if (nameRef.current) nameRef.current.textContent = w.name ?? 'Floor operative';
      if (taggedRef.current) taggedRef.current.style.display = w.tracked ? '' : 'none';
      if (floorRef.current) floorRef.current.textContent = `L${w.floor + 1}`;
      if (zoneRef.current) zoneRef.current.textContent = w.zoneLabel;
      if (stationRef.current) stationRef.current.textContent = `${w.stationId} · ${w.stationName}`;
      if (rfidRef.current) rfidRef.current.textContent = w.rfid;
      if (gaitRef.current) gaitRef.current.textContent = `${(w.gait * 100).toFixed(1)}%`;
      if (unitsRef.current) unitsRef.current.textContent = String(w.units);
      if (cadenceRef.current) cadenceRef.current.textContent = `${w.cadence.toFixed(1)}/hr`;
      if (effRef.current) effRef.current.textContent = `${(w.efficiency * 100).toFixed(1)}%`;
      if (effBarRef.current) effBarRef.current.style.width = `${(w.efficiency * 100).toFixed(0)}%`;
      if (hrRef.current) hrRef.current.textContent = `${w.heartRate} bpm`;
      if (strainRef.current) strainRef.current.textContent = `${(w.strain * 100).toFixed(0)}%`;
      if (strainBarRef.current) {
        strainBarRef.current.style.width = `${Math.max(2, w.strain * 100).toFixed(0)}%`;
        strainBarRef.current.style.background =
          w.strain > 0.6 ? '#d13a57' : w.strain > 0.35 ? '#c57600' : '#0c9183';
      }
      if (thermalRef.current) {
        thermalRef.current.textContent =
          w.strain > 0.6 ? 'HEAT STRESS' : w.strain > 0.35 ? 'ELEVATED' : 'NOMINAL';
        thermalRef.current.style.color =
          w.strain > 0.6 ? '#d13a57' : w.strain > 0.35 ? '#c57600' : '#0c9183';
      }
    };

    raf = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(raf);
  }, [siteId, index]);

  const focused = focusedWorkerIndex === index;

  return (
    <div ref={anchorRef} className="absolute left-0 top-0 will-change-transform">
      <div className="pointer-events-auto w-[248px] -translate-x-1/2 -translate-y-full animate-slide-up overflow-hidden rounded-xl border border-signal-cyan/30 bg-white/95 shadow-hud backdrop-blur-md">
        {/* header */}
        <div className="flex items-start justify-between border-b border-ink-300/35 px-3 py-2">
          <div className="min-w-0">
            <div className="flex items-baseline gap-1.5">
              <span ref={idRef} className="font-mono text-[12px] font-semibold text-ink-900">
                #MG-0000
              </span>
              <span
                ref={taggedRef}
                className="rounded border border-signal-cyan/40 px-1 py-[1px] font-mono text-[7.5px] tracking-[0.14em] text-signal-cyan"
              >
                RF-TAGGED
              </span>
            </div>
            <span ref={nameRef} className="block truncate font-mono text-[9.5px] text-ink-500">
              —
            </span>
          </div>
          <button
            onClick={() => selectWorker(null)}
            className="grid h-5 w-5 shrink-0 place-items-center rounded border border-ink-300/45 font-mono text-[11px] text-ink-600 transition hover:border-signal-cyan/50 hover:text-ink-900"
            aria-label="Close worker card"
          >
            ×
          </button>
        </div>

        {/* assignment */}
        <div className="space-y-1 px-3 py-2">
          <Row label="FLOOR">
            <span ref={floorRef} className="font-mono text-[10px] text-ink-800">
              —
            </span>
          </Row>
          <Row label="ZONE">
            <span ref={zoneRef} className="truncate font-mono text-[9.5px] text-ink-800">
              —
            </span>
          </Row>
          <Row label="STATION">
            <span ref={stationRef} className="truncate font-mono text-[9px] text-ink-700">
              —
            </span>
          </Row>
        </div>

        {/* rf-gait */}
        <div className="mx-3 rounded border border-ink-300/35 bg-frost-200 px-2 py-1.5">
          <div className="font-mono text-[8px] tracking-[0.2em] text-ink-500">RF-GAIT MATCH</div>
          <div className="mt-0.5 flex items-center justify-between gap-2">
            <span ref={rfidRef} className="truncate font-mono text-[9.5px] text-signal-violet">
              —
            </span>
            <span ref={gaitRef} className="shrink-0 font-mono text-[11px] font-semibold text-ink-900">
              —
            </span>
          </div>
        </div>

        {/* output + biometric */}
        <div className="grid grid-cols-2 gap-x-3 px-3 py-2">
          <div>
            <div className="font-mono text-[8px] tracking-[0.2em] text-ink-500">OUTPUT</div>
            <div className="leading-tight">
              <span ref={unitsRef} className="font-mono text-[14px] font-semibold text-ink-900">
                0
              </span>
              <span ref={cadenceRef} className="ml-1 font-mono text-[8.5px] text-ink-400">
                —
              </span>
            </div>
          </div>
          <div>
            <div className="font-mono text-[8px] tracking-[0.2em] text-ink-500">BIOMETRIC</div>
            <span ref={hrRef} className="font-mono text-[13px] text-signal-red">
              —
            </span>
          </div>
        </div>

        {/* efficiency */}
        <div className="px-3 pb-1.5">
          <Row label="EFFICIENCY">
            <span ref={effRef} className="font-mono text-[10px] text-signal-teal">
              —
            </span>
          </Row>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-frost-400">
            <div ref={effBarRef} className="h-full w-0 rounded-full bg-signal-teal" />
          </div>
        </div>

        {/* strain */}
        <div className="px-3 pb-2.5">
          <Row label="THERMAL STRAIN">
            <span className="flex items-center gap-1.5">
              <span ref={thermalRef} className="font-mono text-[8.5px] tracking-[0.14em] text-signal-teal">
                —
              </span>
              <span ref={strainRef} className="font-mono text-[10px] text-ink-700">
                —
              </span>
            </span>
          </Row>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-frost-400">
            <div ref={strainBarRef} className="h-full w-0 rounded-full bg-signal-teal" />
          </div>
        </div>

        <button
          onClick={() => focusWorker(focused ? null : index)}
          className={`w-full border-t px-3 py-2 font-mono text-[9.5px] font-semibold tracking-[0.18em] transition ${
            focused
              ? 'border-signal-cyan bg-signal-cyan text-white'
              : 'border-ink-300/35 text-signal-cyan hover:bg-signal-cyan/10'
          }`}
        >
          {focused ? 'RELEASE CAMERA' : 'FOCUS CAMERA'}
        </button>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 font-mono text-[8px] tracking-[0.2em] text-ink-500">{label}</span>
      {children}
    </div>
  );
}
