'use client';

/**
 * THE UNIFIED COUNTER
 *
 * Machinery and Product were separate pillars. At the micro level they are the
 * same pillar, and this panel is where that is argued:
 *
 *   strokes → cycle → unit → Total Output
 *
 * The ring is `machine.unitProgress`, which is `(strokesThisUnit + kin) /
 * perUnit`. It is not a time-based progress bar that happens to run alongside
 * an animation — it is the animation's own phase, drawn as a circle. Stop the
 * machine and the ring stops at whatever fraction the mechanism was at.
 *
 * Repainted at 20Hz through `textContent` and an SVG dash offset. No React
 * state is involved after mount.
 */

import { useEffect, useRef } from 'react';

import { KINEMATICS, SITES, type SiteId } from '@/lib/sites';
import { findMachine, useMegnetoStore } from '@/store/useMegnetoStore';

const RING_R = 34;
const CIRC = 2 * Math.PI * RING_R;

export default function KinematicPanel({ siteId }: { siteId: SiteId }) {
  const machineId = useMegnetoStore((s) => s.kinematicMachineId);
  const inspectKinematics = useMegnetoStore((s) => s.inspectKinematics);
  const actOnMachine = useMegnetoStore((s) => s.actOnMachine);

  const arcRef = useRef<SVGCircleElement>(null);
  const pctRef = useRef<HTMLSpanElement>(null);
  const strokeRef = useRef<HTMLSpanElement>(null);
  const hzRef = useRef<HTMLSpanElement>(null);
  const totalStrokesRef = useRef<HTMLSpanElement>(null);
  const unitsRef = useRef<HTMLSpanElement>(null);
  const statusRef = useRef<HTMLSpanElement>(null);
  const lockRef = useRef<HTMLSpanElement>(null);
  const flashRef = useRef<HTMLDivElement>(null);
  const jamRef = useRef<HTMLButtonElement>(null);

  const def = machineId ? SITES[siteId].machines.find((m) => m.id === machineId) : null;
  const profile = def ? KINEMATICS[def.kind] : null;

  useEffect(() => {
    if (!machineId || !def || !profile) return;
    let raf = 0;
    let acc = 0;
    let last = performance.now();
    let lastUnitAt = -1;

    const paint = (now: number) => {
      raf = requestAnimationFrame(paint);
      acc += now - last;
      last = now;
      if (acc < 50) return; // 20Hz — the ring needs to look continuous
      acc = 0;

      const m = findMachine(siteId, machineId);
      if (!m) return;

      const moving = m.strokeHz > 0.001;
      const p = Math.min(1, Math.max(0, m.unitProgress));

      if (arcRef.current) {
        arcRef.current.style.strokeDasharray = `${(p * CIRC).toFixed(1)} ${CIRC.toFixed(1)}`;
        arcRef.current.style.stroke = moving ? '#1a8fd1' : '#d13a57';
      }
      if (pctRef.current) pctRef.current.textContent = `${Math.round(p * 100)}`;
      if (strokeRef.current) {
        strokeRef.current.textContent = `${m.strokesThisUnit} / ${profile.perUnit}`;
      }
      if (hzRef.current) hzRef.current.textContent = `${m.strokeHz.toFixed(2)} Hz`;
      if (totalStrokesRef.current) totalStrokesRef.current.textContent = m.strokes.toLocaleString('en-IN');
      if (unitsRef.current) unitsRef.current.textContent = m.jobsDone.toLocaleString('en-IN');

      if (statusRef.current) {
        statusRef.current.textContent = moving ? 'TRACKING' : m.jammed ? 'MOTION HALTED' : 'IDLE';
        statusRef.current.style.color = moving ? '#0c9183' : '#d13a57';
      }
      if (lockRef.current) {
        lockRef.current.textContent = moving ? 'LOCK' : 'LOST';
        lockRef.current.style.color = moving ? '#1a8fd1' : '#d13a57';
        lockRef.current.style.borderColor = moving ? '#1a8fd155' : '#d13a5755';
      }

      // Flash on a completed cycle — the moment output actually increments.
      if (m.lastUnitAt !== lastUnitAt) {
        lastUnitAt = m.lastUnitAt;
        if (flashRef.current) {
          flashRef.current.style.opacity = '1';
          window.setTimeout(() => {
            if (flashRef.current) flashRef.current.style.opacity = '0';
          }, 420);
        }
      }

      if (jamRef.current) jamRef.current.style.display = m.jammed ? '' : 'none';
    };

    raf = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(raf);
  }, [siteId, machineId, def, profile]);

  if (!machineId || !def || !profile) return null;

  return (
    <aside className="pointer-events-auto absolute left-1/2 top-[120px] w-[330px] -translate-x-1/2 animate-slide-up">
      <div className="overflow-hidden rounded-2xl border border-signal-cyan/30 bg-white/95 shadow-hud backdrop-blur-xl">
        {/* header */}
        <div className="flex items-start justify-between border-b border-ink-300/30 px-4 py-2.5">
          <div>
            <div className="font-mono text-[12px] font-semibold text-ink-900">{def.name}</div>
            <div className="font-mono text-[8.5px] tracking-[0.18em] text-ink-500">
              KINEMATIC ACTION RECOGNITION
            </div>
          </div>
          <span
            ref={lockRef}
            className="rounded border px-1.5 py-0.5 font-mono text-[8.5px] tracking-[0.18em] text-signal-cyan"
            style={{ borderColor: '#1a8fd155' }}
          >
            LOCK
          </span>
        </div>

        {/* the ring */}
        <div className="relative flex items-center gap-4 px-4 py-3">
          <div
            ref={flashRef}
            className="pointer-events-none absolute inset-0 bg-signal-teal/15 opacity-0 transition-opacity duration-300"
          />
          <div className="relative grid h-[88px] w-[88px] shrink-0 place-items-center">
            <svg className="absolute inset-0 -rotate-90" viewBox="0 0 80 80">
              <circle cx="40" cy="40" r={RING_R} fill="none" stroke="rgba(13,43,63,0.1)" strokeWidth="6" />
              <circle
                ref={arcRef}
                cx="40"
                cy="40"
                r={RING_R}
                fill="none"
                stroke="#1a8fd1"
                strokeWidth="6"
                strokeLinecap="round"
                style={{ strokeDasharray: `0 ${CIRC}` }}
              />
            </svg>
            <div className="text-center leading-none">
              <span ref={pctRef} className="font-mono text-[19px] font-semibold text-ink-900">
                0
              </span>
              <span className="font-mono text-[10px] text-ink-400">%</span>
            </div>
          </div>

          <div className="min-w-0 flex-1 space-y-1">
            <Row label={profile.motion.toUpperCase()}>
              <span ref={statusRef} className="font-mono text-[9px] tracking-[0.16em] text-signal-teal">
                TRACKING
              </span>
            </Row>
            <Row label="STROKES">
              <span ref={strokeRef} className="font-mono text-[11px] font-semibold text-ink-900">
                0 / 0
              </span>
            </Row>
            <Row label="RATE">
              <span ref={hzRef} className="font-mono text-[10px] text-ink-700">
                —
              </span>
            </Row>
            <p className="pt-1 font-mono text-[8px] leading-relaxed text-ink-400">
              {profile.tracker} · {profile.perUnit} strokes = 1 cycle = +{def.yieldPerCycle}{' '}
              {SITES[siteId].productUnit}
            </p>
          </div>
        </div>

        {/* the proof */}
        <div className="grid grid-cols-2 gap-px border-t border-ink-300/30 bg-ink-300/25">
          <Cell label="STROKES COUNTED" innerRef={totalStrokesRef} />
          <Cell label="CYCLES COMPLETE" innerRef={unitsRef} />
        </div>

        <button
          ref={jamRef}
          onClick={() => actOnMachine(def.id)}
          style={{ display: 'none' }}
          className="w-full border-t border-signal-red/30 bg-signal-red px-3 py-2 font-mono text-[9.5px] font-semibold tracking-[0.18em] text-white transition hover:opacity-90"
        >
          MOTION HALTED · DISPATCH FLOOR TO RESUME
        </button>

        <button
          onClick={() => inspectKinematics(null)}
          className="w-full border-t border-ink-300/30 px-3 py-2 font-mono text-[9.5px] font-semibold tracking-[0.18em] text-signal-cyan transition hover:bg-signal-cyan/10"
        >
          ← BACK TO FLOOR
        </button>
      </div>
    </aside>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="truncate font-mono text-[8px] tracking-[0.18em] text-ink-500">{label}</span>
      {children}
    </div>
  );
}

function Cell({ label, innerRef }: { label: string; innerRef: React.RefObject<HTMLSpanElement | null> }) {
  return (
    <div className="bg-white px-3 py-2">
      <div className="font-mono text-[7.5px] tracking-[0.16em] text-ink-400">{label}</div>
      <span ref={innerRef} className="font-mono text-[14px] font-semibold text-ink-900">
        0
      </span>
    </div>
  );
}
