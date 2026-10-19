'use client';

/**
 * PROJECTED DOM OVERLAY
 *
 * Why not `@react-three/drei`'s <Html>?
 *
 * <Html> mounts a SEPARATE React DOM root per overlay and tears it down inside
 * a layout effect. Under React 19 that unmount lands in the middle of the
 * parent tree's commit, which logs "Attempted to synchronously unmount a root
 * while React was already rendering" and, when the canvas goes away in the same
 * commit, throws an uncaught NotFoundError on removeChild. With twenty-odd
 * overlays and a layer that is mounted and destroyed on every dive, that is not
 * an edge case: it is every single transition.
 *
 * So the overlays live here instead, in the ordinary React tree, as absolutely
 * positioned DOM siblings of the canvas. A single `<Projector/>` inside the
 * canvas projects their anchor points to screen space once per frame and writes
 * `transform` straight onto the nodes.
 *
 * One React root, one useFrame, zero per-overlay reconcilers — and measurably
 * cheaper than <Html> was.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

import { SITES, STATUS_COLOR, floorElevation, type FloorIndex, type SiteId } from '@/lib/sites';
import WorkerInspectionCard from '@/components/WorkerCard';
import { anchors, clearAnchors, registerAnchor } from '@/lib/anchors';
import {
  findEnvNode,
  findMachine,
  getSite,
  readAcoustic,
  useMegnetoStore,
  workerSnapshot,
} from '@/store/useMegnetoStore';

/* -------------------------------------------------------------------------- */
/* Anchor registry                                                             */
/* -------------------------------------------------------------------------- */

// The registry itself lives in lib/anchors.ts, so this module and the worker
// card do not import each other.

const projVec = new THREE.Vector3();

export function Projector() {
  useFrame(({ camera, size }) => {
    if (anchors.size === 0) return;
    const hw = size.width * 0.5;
    const hh = size.height * 0.5;

    for (const anchor of anchors.values()) {
      const el = anchor.el;
      if (!el) continue;
      anchor.read(projVec);
      projVec.project(camera);

      if (projVec.z > 1 || projVec.x < -1.6 || projVec.x > 1.6 || projVec.y < -1.6 || projVec.y > 1.6) {
        if (el.style.visibility !== 'hidden') el.style.visibility = 'hidden';
        continue;
      }
      if (el.style.visibility === 'hidden') el.style.visibility = 'visible';

      const x = projVec.x * hw + hw;
      const y = -projVec.y * hh + hh;
      el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
    }
  });
  return null;
}

/* -------------------------------------------------------------------------- */
/* Overlay root                                                                */
/* -------------------------------------------------------------------------- */

export default function FacilityOverlay({ siteId }: { siteId: SiteId }) {
  const def = SITES[siteId];
  const selectedMachineId = useMegnetoStore((s) => s.selectedMachineId);
  const selectedEnvNodeId = useMegnetoStore((s) => s.selectedEnvNodeId);
  const hoveredOperatorIndex = useMegnetoStore((s) => s.hoveredOperatorIndex);
  const selectedWorkerIndex = useMegnetoStore((s) => s.selectedWorkerIndex);

  // Every anchor is dropped when this layer leaves, so a stale node can never
  // be projected into a canvas that no longer exists.
  useEffect(() => () => clearAnchors(), [siteId]);

  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
      {def.zones.map((zone) => (
        <ZoneLabel
          key={zone.id}
          id={zone.id}
          label={zone.label}
          bounds={zone.bounds}
          floor={zone.floor}
          elevation={floorElevation(def, zone.floor)}
        />
      ))}

      {def.machines.map((m) => (
        <MachineTag
          key={m.id}
          siteId={siteId}
          id={m.id}
          position={m.position}
          height={m.size[1]}
          floor={m.floor}
          elevation={floorElevation(def, m.floor)}
        />
      ))}

      {def.envNodes.map((n) => (
        <EnvTag
          key={n.id}
          siteId={siteId}
          id={n.id}
          position={n.position}
          height={n.size[1]}
          floor={n.floor}
          elevation={floorElevation(def, n.floor)}
        />
      ))}

      {selectedWorkerIndex !== null && (
        <WorkerInspectionCard key={selectedWorkerIndex} siteId={siteId} index={selectedWorkerIndex} />
      )}
      {selectedMachineId && <MachinePanel key={selectedMachineId} siteId={siteId} machineId={selectedMachineId} />}
      {selectedEnvNodeId && <EnvPanel key={selectedEnvNodeId} siteId={siteId} nodeId={selectedEnvNodeId} />}
      {hoveredOperatorIndex !== null && <OperatorTooltip siteId={siteId} index={hoveredOperatorIndex} />}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Tags                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Hides a tag whose level is faded out. Without this you get labels floating
 * over a wireframe cage with nothing under them, which reads as a bug.
 * Polled on the same rAF the tags already run, so it costs nothing extra.
 */
function useFloorVisibility(ref: React.RefObject<HTMLElement | null>, floor: FloorIndex) {
  useEffect(() => {
    let raf = 0;
    let lastOn: boolean | null = null;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const active = useMegnetoStore.getState().activeFloor;
      const on = active === 'all' || active === floor;
      if (on === lastOn) return;
      lastOn = on;
      const el = ref.current;
      if (el) {
        el.style.opacity = on ? '1' : '0';
        el.style.pointerEvents = on ? '' : 'none';
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ref, floor]);
}

function ZoneLabel({
  id,
  label,
  bounds,
  floor,
  elevation,
}: {
  id: string;
  label: string;
  bounds: readonly [number, number, number, number];
  floor: FloorIndex;
  elevation: number;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  useFloorVisibility(hostRef, floor);

  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      hostRef.current = el;
      registerAnchor(`zone:${id}`, el, (out) => out.set(bounds[0] + 0.6, elevation + 0.02, bounds[1] + 0.7));
    },
    [id, bounds, elevation],
  );

  return (
    <div ref={ref} className="absolute left-0 top-0 transition-opacity duration-300 will-change-transform">
      <span className="whitespace-nowrap font-mono text-[9px] tracking-[0.22em] text-signal-cyan/50">{label}</span>
    </div>
  );
}

function MachineTag({
  siteId,
  id,
  position,
  height,
  floor,
  elevation,
}: {
  siteId: SiteId;
  id: string;
  position: readonly [number, number, number];
  height: number;
  floor: FloorIndex;
  elevation: number;
}) {
  const selectMachine = useMegnetoStore((s) => s.selectMachine);
  const btnRef = useRef<HTMLButtonElement>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const acc = useRef(0);

  useFloorVisibility(hostRef, floor);

  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      hostRef.current = el;
      registerAnchor(`tag:${id}`, el, (out) =>
        out.set(position[0], elevation + position[1] + height + 0.86, position[2]),
      );
    },
    [id, position, height, elevation],
  );

  // A jammed machine shouts from its own tag, at ~6Hz, with no React involved.
  // Note this is rAF, not useFrame: the overlay lives OUTSIDE the Canvas, and
  // R3F hooks throw anywhere else in the tree.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const paint = (now: number) => {
      raf = requestAnimationFrame(paint);
      acc.current += now - last;
      last = now;
      if (acc.current < 160) return;
      acc.current = 0;

      const b = btnRef.current;
      if (!b) return;
      const m = findMachine(siteId, id);
      if (!m) return;
      if (m.jammed) {
        b.textContent = `${id} · JAMMED`;
        b.style.background = '#fdf0fa';
        b.style.borderColor = `${STATUS_COLOR.jammed}aa`;
        b.style.color = STATUS_COLOR.jammed;
      } else {
        b.textContent = id;
        b.style.background = '';
        b.style.borderColor = '';
        b.style.color = '';
      }
    };
    raf = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(raf);
  }, [siteId, id]);

  return (
    <div
      ref={ref}
      className="absolute left-0 top-0 -translate-x-1/2 -translate-y-1/2 transition-opacity duration-300 will-change-transform"
    >
      <button
        ref={btnRef}
        onClick={() => {
          const current = useMegnetoStore.getState().selectedMachineId;
          selectMachine(current === id ? null : id);
        }}
        className="pointer-events-auto whitespace-nowrap rounded border border-ink-300/45 bg-white/95 px-1.5 py-0.5 font-mono text-[9px] tracking-[0.18em] text-ink-700 backdrop-blur-[2px] transition hover:border-signal-cyan/50 hover:text-ink-900"
      >
        {id}
      </button>
    </div>
  );
}

function EnvTag({
  siteId,
  id,
  position,
  height,
  floor,
  elevation,
}: {
  siteId: SiteId;
  id: string;
  position: readonly [number, number, number];
  height: number;
  floor: FloorIndex;
  elevation: number;
}) {
  const selectEnvNode = useMegnetoStore((s) => s.selectEnvNode);
  const btnRef = useRef<HTMLButtonElement>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const acc = useRef(0);

  useFloorVisibility(hostRef, floor);

  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      hostRef.current = el;
      registerAnchor(`env:${id}`, el, (out) =>
        out.set(position[0], elevation + position[1] + height + 1.0, position[2]),
      );
    },
    [id, position, height, elevation],
  );

  // The tag carries the live reading, so the floor is legible without opening
  // a single panel. rAF, not useFrame — the overlay is outside the Canvas.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const paint = (now: number) => {
      raf = requestAnimationFrame(paint);
      acc.current += now - last;
      last = now;
      if (acc.current < 150) return;
      acc.current = 0;

      const b = btnRef.current;
      if (!b) return;
      const n = findEnvNode(siteId, id);
      if (!n) return;
      const value = n.primary >= 1000 ? n.primary.toFixed(0) : n.primary.toFixed(1);
      b.textContent = `${id} · ${value} ${n.primaryUnit}`;
      b.style.color = STATUS_COLOR[n.status];
      b.style.borderColor = `${STATUS_COLOR[n.status]}66`;
      b.style.background = n.alert ? '#fff4f6' : '';
    };
    raf = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(raf);
  }, [siteId, id]);

  return (
    <div
      ref={ref}
      className="absolute left-0 top-0 -translate-x-1/2 -translate-y-1/2 transition-opacity duration-300 will-change-transform"
    >
      <button
        ref={btnRef}
        onClick={() => {
          const current = useMegnetoStore.getState().selectedEnvNodeId;
          selectEnvNode(current === id ? null : id);
        }}
        className="pointer-events-auto whitespace-nowrap rounded border border-ink-300/45 bg-white/95 px-1.5 py-0.5 font-mono text-[9px] tracking-[0.16em] backdrop-blur-[2px] transition hover:border-signal-cyan/50"
      >
        {id}
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Machine X-ray panel                                                         */
/* -------------------------------------------------------------------------- */

const ACOUSTIC_BUFFER = new Float32Array(48);

function MachinePanel({ siteId, machineId }: { siteId: SiteId; machineId: string }) {
  const def = useMemo(() => SITES[siteId].machines.find((m) => m.id === machineId), [siteId, machineId]);
  const selectMachine = useMegnetoStore((s) => s.selectMachine);
  const actOnMachine = useMegnetoStore((s) => s.actOnMachine);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tempRef = useRef<HTMLSpanElement>(null);
  const tempBarRef = useRef<HTMLDivElement>(null);
  const dbRef = useRef<HTMLSpanElement>(null);
  const rpmRef = useRef<HTMLSpanElement>(null);
  const kwRef = useRef<HTMLSpanElement>(null);
  const jobsRef = useRef<HTMLSpanElement>(null);
  const queueRef = useRef<HTMLSpanElement>(null);
  const uptimeRef = useRef<HTMLSpanElement>(null);
  const rejectRef = useRef<HTMLSpanElement>(null);
  const loadBarRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLSpanElement>(null);
  const jamRef = useRef<HTMLDivElement>(null);
  const jamBtnRef = useRef<HTMLButtonElement>(null);

  const anchorRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (!def) return;
      registerAnchor('machine-panel', el, (out) =>
        out.set(
          def.position[0],
          floorElevation(SITES[siteId], def.floor) + def.position[1] + def.size[1] + 1.3,
          def.position[2],
        ),
      );
    },
    [def, siteId],
  );

  useEffect(() => {
    if (!def) return;
    let raf = 0;
    let acc = 0;
    let last = performance.now();

    const paint = (now: number) => {
      raf = requestAnimationFrame(paint);
      acc += now - last;
      last = now;
      if (acc < 66) return; // 15Hz is plenty for text
      acc = 0;

      const m = findMachine(siteId, machineId);
      if (!m) return;

      const cv = canvasRef.current;
      const ctx = cv?.getContext('2d');
      if (cv && ctx) {
        const data = readAcoustic(m, ACOUSTIC_BUFFER);
        const w = cv.width;
        const h = cv.height;
        const nom = def.nominalDb;
        const toY = (v: number) => h - ((v - (nom - 24)) / 48) * h;
        const faulted = m.status !== 'nominal';

        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = 'rgba(12,145,131,0.18)';
        ctx.fillRect(0, toY(nom + 6), w, Math.max(2, toY(nom - 6) - toY(nom + 6)));

        ctx.beginPath();
        for (let i = 0; i < data.length; i++) {
          const x = (i / (data.length - 1)) * w;
          const y = Math.max(1, Math.min(h - 1, toY(data[i])));
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.lineWidth = 1.7;
        ctx.strokeStyle = faulted ? STATUS_COLOR[m.status] : '#1a8fd1';
        ctx.stroke();

        const grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, faulted ? 'rgba(197,118,0,0.3)' : 'rgba(26,143,209,0.3)');
        grad.addColorStop(1, 'rgba(26,143,209,0)');
        ctx.lineTo(w, h);
        ctx.lineTo(0, h);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();
      }

      if (tempRef.current) tempRef.current.textContent = `${m.tempC.toFixed(1)}°C`;
      if (tempBarRef.current) {
        const pct = Math.max(4, Math.min(100, (m.tempC / Math.max(40, def.nominalTempC * 1.3)) * 100));
        tempBarRef.current.style.width = `${pct.toFixed(0)}%`;
        tempBarRef.current.style.background =
          m.tempC > def.nominalTempC * 1.15 ? '#d13a57' : m.tempC > def.nominalTempC ? '#c57600' : '#0c9183';
      }
      if (dbRef.current) dbRef.current.textContent = `${m.db.toFixed(1)} dB`;
      if (rpmRef.current) rpmRef.current.textContent = def.nominalRpm ? `${m.rpm.toLocaleString('en-IN')} rpm` : 'n/a';
      if (kwRef.current) kwRef.current.textContent = `${m.kw.toFixed(1)} kW`;
      if (jobsRef.current) jobsRef.current.textContent = m.jobsDone.toLocaleString('en-IN');
      if (queueRef.current) queueRef.current.textContent = String(m.queue);
      if (uptimeRef.current) uptimeRef.current.textContent = `${m.uptimePct.toFixed(1)}%`;
      if (rejectRef.current) rejectRef.current.textContent = String(m.rejects);
      if (loadBarRef.current) loadBarRef.current.style.width = `${(m.load * 100).toFixed(0)}%`;
      if (statusRef.current) {
        statusRef.current.textContent = m.status.toUpperCase();
        statusRef.current.style.color = STATUS_COLOR[m.status];
        statusRef.current.style.borderColor = `${STATUS_COLOR[m.status]}55`;
      }
      if (jamRef.current) {
        jamRef.current.style.display = m.jammed ? 'block' : 'none';
        if (m.jammed && jamBtnRef.current) {
          jamBtnRef.current.textContent = `DISPATCH FLOOR · DOWN ${Math.floor(m.jamSeconds)}s`;
        }
      }
    };

    raf = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(raf);
  }, [siteId, machineId, def]);

  if (!def) return null;
  const machine = findMachine(siteId, machineId);

  return (
    <div ref={anchorRef} className="absolute left-0 top-0 will-change-transform">
      <div className="pointer-events-auto w-[300px] -translate-x-1/2 -translate-y-full animate-slide-up rounded-lg border border-signal-cyan/30 bg-white/95 shadow-hud backdrop-blur-md">
        <div className="flex items-start justify-between border-b border-ink-300/35 px-3 py-2">
          <div>
            <div className="font-mono text-[12px] font-semibold tracking-wide text-ink-900">{def.name}</div>
            <div className="font-mono text-[9px] tracking-[0.2em] text-ink-500">
              {def.id} · {def.kind.toUpperCase()} · {def.ratedKw} kW
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <span
              ref={statusRef}
              className="rounded border px-1.5 py-0.5 font-mono text-[9px] tracking-[0.18em]"
              style={{
                color: STATUS_COLOR[machine?.status ?? 'nominal'],
                borderColor: `${STATUS_COLOR[machine?.status ?? 'nominal']}55`,
              }}
            >
              {(machine?.status ?? 'nominal').toUpperCase()}
            </span>
            <button
              onClick={() => selectMachine(null)}
              className="grid h-5 w-5 place-items-center rounded border border-ink-300/45 font-mono text-[11px] text-ink-600 transition hover:border-signal-cyan/50 hover:text-ink-900"
              aria-label="Close diagnostics"
            >
              ×
            </button>
          </div>
        </div>

        <div className="px-3 pt-2.5">
          <Row label="ACOUSTIC HEALTH">
            <span ref={dbRef} className="font-mono text-[10px] text-signal-cyan">
              —
            </span>
          </Row>
          <canvas
            ref={canvasRef}
            width={276}
            height={46}
            className="mt-1 w-full rounded border border-ink-300/35 bg-frost-200"
          />
        </div>

        <div className="px-3 pt-2.5">
          <Row label="THERMAL">
            <span ref={tempRef} className="font-mono text-[10px] text-ink-900">
              —
            </span>
          </Row>
          <Bar innerRef={tempBarRef} tone="bg-signal-teal" />
        </div>

        <div className="px-3 pt-2.5">
          <Row label="DRIVE LOAD">
            <span ref={rpmRef} className="font-mono text-[10px] text-ink-700">
              —
            </span>
          </Row>
          <Bar innerRef={loadBarRef} tone="bg-signal-violet" />
        </div>

        <div className="mt-3 grid grid-cols-5 gap-px border-t border-ink-300/35 bg-ink-300/30">
          <Cell label="OUTPUT" innerRef={jobsRef} tone="text-ink-900" />
          <Cell label="QUEUE" innerRef={queueRef} tone="text-signal-amber" />
          <Cell label="UPTIME" innerRef={uptimeRef} tone="text-signal-teal" />
          <Cell label="REJECT" innerRef={rejectRef} tone="text-signal-red" />
          <Cell label="DRAW" innerRef={kwRef} tone="text-ink-700" />
        </div>

        {/* A jam is the one machine state that needs a person. */}
        <div ref={jamRef} style={{ display: 'none' }} className="border-t border-ink-300/35 p-2">
          <button
            ref={jamBtnRef}
            onClick={() => actOnMachine(def.id)}
            className="w-full rounded border px-2 py-1.5 font-mono text-[10px] font-semibold tracking-[0.18em] text-white transition"
            style={{ background: STATUS_COLOR.jammed, borderColor: STATUS_COLOR.jammed }}
          >
            DISPATCH FLOOR
          </button>
          <p className="mt-1.5 text-center font-mono text-[8.5px] leading-relaxed tracking-wide text-ink-500">
            Restarts cold · queue backfills · downtime charged to uptime
          </p>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Environmental node panel                                                    */
/* -------------------------------------------------------------------------- */

function EnvPanel({ siteId, nodeId }: { siteId: SiteId; nodeId: string }) {
  const def = useMemo(() => SITES[siteId].envNodes.find((n) => n.id === nodeId), [siteId, nodeId]);
  const selectEnvNode = useMegnetoStore((s) => s.selectEnvNode);
  const actOnEnvNode = useMegnetoStore((s) => s.actOnEnvNode);

  const primaryRef = useRef<HTMLSpanElement>(null);
  const secondaryRef = useRef<HTMLSpanElement>(null);
  const statusRef = useRef<HTMLSpanElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const alertMsgRef = useRef<HTMLParagraphElement>(null);

  const anchorRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (!def) return;
      registerAnchor('env-panel', el, (out) =>
        out.set(
          def.position[0],
          floorElevation(SITES[siteId], def.floor) + def.position[1] + def.size[1] + 1.5,
          def.position[2],
        ),
      );
    },
    [def, siteId],
  );

  useEffect(() => {
    if (!def) return;
    let raf = 0;
    let acc = 0;
    let last = performance.now();

    const paint = (now: number) => {
      raf = requestAnimationFrame(paint);
      acc += now - last;
      last = now;
      if (acc < 100) return; // 10Hz
      acc = 0;

      const n = findEnvNode(siteId, nodeId);
      const site = getSite(siteId);
      if (!n) return;

      if (primaryRef.current) {
        primaryRef.current.textContent =
          n.primary >= 1000 ? n.primary.toFixed(0) : n.primary.toFixed(n.primary < 10 ? 2 : 1);
      }
      if (secondaryRef.current) {
        secondaryRef.current.textContent = `${
          n.secondary >= 1000 ? n.secondary.toFixed(0) : n.secondary.toFixed(2)
        } ${n.secondaryUnit}`;
      }
      if (statusRef.current) {
        statusRef.current.textContent = n.status.toUpperCase();
        statusRef.current.style.color = STATUS_COLOR[n.status];
        statusRef.current.style.borderColor = `${STATUS_COLOR[n.status]}55`;
      }

      // Per-apparatus detail, straight out of the physics state.
      if (detailRef.current) {
        const p = site.physics;
        let rows: [string, string][] = [];
        if (p.kind === 'textile') {
          if (def.kind === 'humidity') {
            rows = [
              ['Setpoint', `${p.rhSetpoint.toFixed(1)} %RH`],
              ['Plant duty', `${(p.humidifierDuty * 100).toFixed(0)} %`],
              ['Injection', `${p.humidifierGs.toFixed(0)} g/s`],
              ['Process steam', `${p.processMoistureGs.toFixed(0)} g/s`],
              ['Ventilation', `${p.ventilationAch.toFixed(1)} ACH`],
              ['Dew point', `${p.dewPointC.toFixed(1)} °C`],
              ['WBGT', `${p.wbgt.toFixed(1)} °C`],
            ];
          } else if (def.kind === 'dyevat') {
            rows = p.vats.map((v) => [v.id, `${v.tempC.toFixed(1)} / ${v.setpointC} °C · ${v.steamKw.toFixed(0)} kW`]);
          } else if (def.id.includes('MEE')) {
            rows = [
              ['Evaporation', `${p.zld.meeEvapM3h.toFixed(2)} m³/h`],
              ['Salt recovered', `${p.zld.saltKgH.toFixed(1)} kg/h`],
              ['Concentrate TDS', `${p.zld.rejectTdsMgL.toFixed(0)} mg/L`],
              ['Steam demand', `${p.zld.steamKw.toFixed(0)} kW`],
              ['Overall recovery', `${p.zld.recoveryPct.toFixed(1)} %`],
            ];
          } else {
            rows = [
              ['Feed', `${p.zld.feedM3h.toFixed(1)} m³/h @ ${p.zld.tdsFeedMgL.toFixed(0)} mg/L`],
              ['Recovery', `${(p.zld.roRecovery * 100).toFixed(1)} %`],
              ['Permeate', `${p.zld.permeateM3h.toFixed(1)} m³/h @ ${p.zld.permeateTdsMgL.toFixed(0)} mg/L`],
              ['Reject', `${p.zld.rejectM3h.toFixed(1)} m³/h @ ${p.zld.rejectTdsMgL.toFixed(0)} mg/L`],
            ];
          }
        } else {
          if (def.kind === 'voc') {
            rows = [
              ['Source', `${p.vocSourceMgS.toFixed(1)} mg/s`],
              ['Concentration', `${p.vocMgM3.toFixed(1)} mg/m³`],
              ['Bed efficiency', `${(p.scrubberEfficiency * 100).toFixed(0)} %`],
              ['Duty', `${(p.scrubberDuty * 100).toFixed(0)} %`],
              ['Extraction', `${p.extractionAch.toFixed(1)} ACH`],
            ];
          } else if (def.kind === 'dust') {
            rows = [
              ['Generation', `${p.dustSourceUgS.toFixed(0)} µg/s`],
              ['Settling', `${(p.settlingMs * 1000).toFixed(1)} mm/s`],
              ['Extraction', `${p.extractionAch.toFixed(1)} ACH`],
              ['Indoor temp', `${p.indoorTempC.toFixed(1)} °C`],
            ];
          } else {
            rows = [
              ['Process load', `${p.grid.processKw.toFixed(0)} kW`],
              ['HVAC & fans', `${p.grid.hvacKw.toFixed(0)} kW`],
              ['Power factor', p.grid.powerFactor.toFixed(3)],
              ['Peak demand', `${p.grid.peakKva.toFixed(0)} kVA`],
              ['Contract use', `${p.grid.contractUsePct.toFixed(1)} %`],
              ['Energy today', `${p.grid.dailyKwh.toFixed(0)} kWh`],
            ];
          }
        }

        detailRef.current.innerHTML = rows
          .map(
            ([k, v]) =>
              `<div class="flex items-baseline justify-between gap-3 py-[3px]"><span class="font-mono text-[9px] tracking-[0.14em] text-ink-500">${k}</span><span class="font-mono text-[10px] text-ink-800">${v}</span></div>`,
          )
          .join('');
      }

      if (alertRef.current) {
        alertRef.current.style.display = n.alert ? 'block' : 'none';
        if (n.alert && alertMsgRef.current) {
          alertMsgRef.current.textContent = `${n.alertCode} · ${n.alertMessage} · standing ${Math.floor(
            n.alertSeconds,
          )}s`;
        }
      }
    };

    raf = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(raf);
  }, [siteId, nodeId, def]);

  if (!def) return null;
  const node = findEnvNode(siteId, nodeId);

  return (
    <div ref={anchorRef} className="absolute left-0 top-0 will-change-transform">
      <div className="pointer-events-auto w-[312px] -translate-x-1/2 -translate-y-full animate-slide-up rounded-lg border border-signal-teal/30 bg-white/95 shadow-hud backdrop-blur-md">
        <div className="flex items-start justify-between border-b border-ink-300/35 px-3 py-2">
          <div>
            <div className="font-mono text-[12px] font-semibold tracking-wide text-ink-900">{def.name}</div>
            <div className="font-mono text-[9px] tracking-[0.18em] text-ink-500">{def.caption}</div>
          </div>
          <div className="flex items-center gap-1.5">
            <span
              ref={statusRef}
              className="rounded border px-1.5 py-0.5 font-mono text-[9px] tracking-[0.18em]"
              style={{
                color: STATUS_COLOR[node?.status ?? 'nominal'],
                borderColor: `${STATUS_COLOR[node?.status ?? 'nominal']}55`,
              }}
            >
              {(node?.status ?? 'nominal').toUpperCase()}
            </span>
            <button
              onClick={() => selectEnvNode(null)}
              className="grid h-5 w-5 place-items-center rounded border border-ink-300/45 font-mono text-[11px] text-ink-600 transition hover:border-signal-cyan/50 hover:text-ink-900"
              aria-label="Close node"
            >
              ×
            </button>
          </div>
        </div>

        <div className="flex items-end justify-between px-3 pt-3">
          <div>
            <span ref={primaryRef} className="font-mono text-[28px] font-semibold leading-none text-ink-900">
              —
            </span>
            <span className="ml-1 font-mono text-[11px] text-ink-500">{node?.primaryUnit}</span>
          </div>
          <span ref={secondaryRef} className="font-mono text-[11px] text-ink-600">
            —
          </span>
        </div>

        <div ref={detailRef} className="mt-2 divide-y divide-ink-300/25 border-t border-ink-300/35 px-3 py-1" />

        <div ref={alertRef} style={{ display: 'none' }} className="border-t border-signal-red/25 bg-signal-red/5 p-2">
          <p ref={alertMsgRef} className="mb-1.5 font-mono text-[9px] leading-relaxed tracking-wide text-signal-red" />
          <button
            onClick={() => actOnEnvNode(def.id)}
            className="w-full rounded border border-signal-red bg-signal-red px-2 py-1.5 font-mono text-[10px] font-semibold tracking-[0.18em] text-white transition hover:opacity-90"
          >
            APPLY CORRECTION
          </button>
          <p className="mt-1.5 text-center font-mono text-[8.5px] leading-relaxed tracking-wide text-ink-500">
            Steps the real control input · the model recovers at its own rate
          </p>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* RF-Gait operator tooltip                                                    */
/* -------------------------------------------------------------------------- */

function OperatorTooltip({ siteId, index }: { siteId: SiteId; index: number }) {
  const site = getSite(siteId);
  const operator = site.operators[index];

  const unitsRef = useRef<HTMLSpanElement>(null);
  const effRef = useRef<HTMLSpanElement>(null);
  const effBarRef = useRef<HTMLDivElement>(null);
  const hrRef = useRef<HTMLSpanElement>(null);
  const stateRef = useRef<HTMLSpanElement>(null);
  const gaitRef = useRef<HTMLSpanElement>(null);
  const strainRef = useRef<HTMLSpanElement>(null);
  const strainBarRef = useRef<HTMLDivElement>(null);

  const anchorRef = useCallback(
    (el: HTMLDivElement | null) => {
      registerAnchor('operator-tip', el, (out) => {
        const o = index * 3;
        out.set(site.positions[o], 1.45 + site.positions[o + 1], site.positions[o + 2]);
      });
    },
    [index, site],
  );

  useEffect(() => {
    if (!operator) return;
    let raf = 0;
    let acc = 0;
    let last = performance.now();

    const paint = (now: number) => {
      raf = requestAnimationFrame(paint);
      acc += now - last;
      last = now;
      if (acc < 110) return;
      acc = 0;

      if (unitsRef.current) unitsRef.current.textContent = String(operator.units);
      if (effRef.current) effRef.current.textContent = `${(operator.efficiency * 100).toFixed(1)}%`;
      if (effBarRef.current) effBarRef.current.style.width = `${(operator.efficiency * 100).toFixed(1)}%`;
      if (hrRef.current) hrRef.current.textContent = `${operator.heartRate} bpm`;
      if (gaitRef.current) gaitRef.current.textContent = `${(operator.gaitConfidence * 100).toFixed(1)}%`;
      if (strainRef.current) strainRef.current.textContent = `${(operator.strain * 100).toFixed(0)}%`;
      if (strainBarRef.current) {
        strainBarRef.current.style.width = `${(operator.strain * 100).toFixed(0)}%`;
        strainBarRef.current.style.background =
          operator.strain > 0.6 ? '#d13a57' : operator.strain > 0.35 ? '#c57600' : '#0c9183';
      }
      if (stateRef.current) {
        stateRef.current.textContent =
          operator.state === 1 ? 'AT STATION' : operator.state === 2 ? 'ON BREAK' : 'IN TRANSIT';
        stateRef.current.style.color =
          operator.state === 1 ? '#0c9183' : operator.state === 2 ? '#c57600' : '#1a8fd1';
      }
    };

    raf = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(raf);
  }, [operator]);

  if (!operator) return null;

  return (
    <div ref={anchorRef} className="absolute left-0 top-0 will-change-transform">
      <div className="w-[222px] -translate-x-1/2 -translate-y-full animate-slide-up rounded-md border border-signal-cyan/25 bg-white/95 p-2.5 shadow-hud backdrop-blur-sm">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-mono text-[11px] font-semibold tracking-wide text-ink-900">{operator.name}</span>
          <span ref={stateRef} className="font-mono text-[9px] tracking-[0.18em] text-signal-cyan">
            IN TRANSIT
          </span>
        </div>
        <div className="mt-0.5 font-mono text-[9px] tracking-[0.14em] text-ink-500">
          {operator.id} · {operator.sector.toUpperCase()}
        </div>

        <div className="mt-2 rounded border border-ink-300/35 bg-frost-200 px-2 py-1.5">
          <div className="font-mono text-[8px] tracking-[0.2em] text-ink-500">RF-GAIT SIGNATURE</div>
          <div className="mt-0.5 flex items-center justify-between">
            <span className="font-mono text-[10px] text-signal-violet">{operator.rfid}</span>
            <span ref={gaitRef} className="font-mono text-[10px] text-ink-700">
              —
            </span>
          </div>
        </div>

        <div className="mt-2 grid grid-cols-2 gap-x-3">
          <div>
            <div className="font-mono text-[8px] tracking-[0.2em] text-ink-500">UNITS / SHIFT</div>
            <div className="leading-tight">
              <span ref={unitsRef} className="font-mono text-[13px] font-semibold text-ink-900">
                {operator.units}
              </span>
              <span className="font-mono text-[9px] text-ink-400"> / {operator.shiftTargetUnits}</span>
            </div>
          </div>
          <div>
            <div className="font-mono text-[8px] tracking-[0.2em] text-ink-500">BIOMETRIC</div>
            <span ref={hrRef} className="font-mono text-[12px] text-signal-red">
              —
            </span>
          </div>
        </div>

        <div className="mt-2">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[8px] tracking-[0.2em] text-ink-500">EFFICIENCY</span>
            <span ref={effRef} className="font-mono text-[10px] text-signal-teal">
              —
            </span>
          </div>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-frost-400">
            <div ref={effBarRef} className="h-full w-0 rounded-full bg-signal-teal" />
          </div>
        </div>

        {/* Environmental strain — the link between the air and the person. */}
        <div className="mt-2">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[8px] tracking-[0.2em] text-ink-500">ENV STRAIN</span>
            <span ref={strainRef} className="font-mono text-[10px] text-ink-700">
              —
            </span>
          </div>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-frost-400">
            <div ref={strainBarRef} className="h-full w-0 rounded-full bg-signal-teal" />
          </div>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Small chrome                                                                */
/* -------------------------------------------------------------------------- */

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="font-mono text-[8px] tracking-[0.22em] text-ink-500">{label}</span>
      {children}
    </div>
  );
}

function Bar({ innerRef, tone }: { innerRef: React.RefObject<HTMLDivElement | null>; tone: string }) {
  return (
    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-frost-400">
      <div ref={innerRef} className={`h-full w-0 rounded-full ${tone}`} />
    </div>
  );
}

function Cell({
  label,
  innerRef,
  tone,
}: {
  label: string;
  innerRef: React.RefObject<HTMLSpanElement | null>;
  tone: string;
}) {
  return (
    <div className="bg-white px-1.5 py-1.5">
      <div className="font-mono text-[7px] tracking-[0.16em] text-ink-400">{label}</div>
      <span ref={innerRef} className={`font-mono text-[11px] ${tone}`}>
        —
      </span>
    </div>
  );
}
