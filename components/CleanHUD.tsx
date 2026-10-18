'use client';

/**
 * THE CLEAN HUD
 *
 * V2's command centre showed everything at once. That is the right instinct for
 * an operator on shift and the wrong one entirely for a pitch: an investor
 * cannot find the story in forty simultaneous numbers.
 *
 * So the default state is almost empty — one output counter, one line of alert
 * chips, and the floor selector. Everything else is one click away and stays
 * where the user put it. Progressive disclosure, not density.
 *
 * ============================================================================
 * THE RENDER BUDGET IS UNCHANGED
 * ============================================================================
 * Every live number here is still written straight into the DOM from ONE 12Hz
 * requestAnimationFrame loop setting `textContent`. Collapsing a panel does not
 * stop its data updating — it stops its data EXISTING in the DOM, which is
 * strictly cheaper. React renders this component on a phase change, a floor
 * change, an alert, or a disclosure toggle. Nothing else.
 * ============================================================================
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  FLOOR_INDICES,
  INTER_SITE_LANE,
  PILLARS,
  PILLAR_COLOR,
  PILLAR_LABEL,
  SITES,
  SITE_IDS,
  TOTAL_HEADCOUNT,
  type FloorIndex,
  type FloorSelection,
  type Pillar,
} from '@/lib/sites';
import { floorAlertCount, floorHeadcount, getSite, getWorld, useMegnetoStore } from '@/store/useMegnetoStore';

const HUD_HZ = 1 / 12;
const nf = new Intl.NumberFormat('en-IN');

function fmt(v: number): string {
  if (Math.abs(v) >= 10000) return nf.format(Math.round(v));
  if (Math.abs(v) >= 100) return v.toFixed(0);
  if (Math.abs(v) >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

/* ========================================================================== */
/* Root                                                                       */
/* ========================================================================== */

export default function CleanHUD() {
  const phase = useMegnetoStore((s) => s.phase);
  const activeSite = useMegnetoStore((s) => s.activeSite);
  const activeFloor = useMegnetoStore((s) => s.activeFloor);
  const paused = useMegnetoStore((s) => s.paused);
  const alertRevision = useMegnetoStore((s) => s.alertRevision);

  const beginDive = useMegnetoStore((s) => s.beginDive);
  const beginAscent = useMegnetoStore((s) => s.beginAscent);
  const setActiveFloor = useMegnetoStore((s) => s.setActiveFloor);
  const togglePause = useMegnetoStore((s) => s.togglePause);
  const selectMachine = useMegnetoStore((s) => s.selectMachine);
  const selectEnvNode = useMegnetoStore((s) => s.selectEnvNode);

  /** Disclosure state. Everything starts closed; the demo opens what it needs. */
  const [openPanel, setOpenPanel] = useState<'none' | 'pillars' | 'alerts'>('none');

  const isMicro = phase === 'micro';
  const isMacro = phase === 'macro';
  const site = SITES[activeSite];

  /* ---- keyboard ---- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      const s = useMegnetoStore.getState();
      if (s.phase === 'macro') {
        if (e.key === '1') s.beginDive('tiruppur');
        if (e.key === '2') s.beginDive('rajajinagar');
        if (e.key === 'Enter') s.beginDive(s.activeSite);
      } else if (s.phase === 'micro') {
        // On the floor, the number keys pick levels instead of sites.
        if (e.key === '1') s.setActiveFloor(0);
        if (e.key === '2') s.setActiveFloor(1);
        if (e.key === '3') s.setActiveFloor(2);
        if (e.key === '0') s.setActiveFloor('all');
      }
      if (e.key === 'Escape') {
        if (s.selectedMachineId || s.selectedEnvNodeId) {
          s.selectMachine(null);
          s.selectEnvNode(null);
        } else if (s.phase === 'micro') s.beginAscent();
      }
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        s.togglePause();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* ---- alerts: the only thing shown by default besides output ---- */
  const alerts = useMemo(() => getWorld().alerts.filter((a) => !a.resolved), [alertRevision]);
  const siteAlerts = useMemo(() => alerts.filter((a) => a.siteId === activeSite), [alerts, activeSite]);
  const jams = useMemo(() => siteAlerts.filter((a) => a.code === 'JAM'), [siteAlerts]);
  const envAlerts = useMemo(
    () => siteAlerts.filter((a) => a.pillar === 'environment' || a.pillar === 'utility'),
    [siteAlerts],
  );

  return (
    <div className="pointer-events-none absolute inset-0 z-30 select-none font-mono text-ink-800">
      <TopBar phase={phase} paused={paused} />

      {/* ---------- MASTER COUNTER: the one number always on screen ---------- */}
      <MasterCounter siteId={activeSite} />

      {/* ---------- ALERT CHIPS: the only other always-on element ---------- */}
      <div className="pointer-events-auto absolute left-1/2 top-[86px] flex -translate-x-1/2 items-center gap-2">
        {jams.length === 0 && envAlerts.length === 0 ? (
          <Chip tone="calm">All systems nominal</Chip>
        ) : (
          <>
            {jams.length > 0 && (
              <Chip
                tone="critical"
                onClick={() => {
                  if (isMicro) selectMachine(jams[0].nodeId);
                  setOpenPanel('alerts');
                }}
              >
                {jams.length} machine {jams.length === 1 ? 'jam' : 'jams'}
              </Chip>
            )}
            {envAlerts.length > 0 && (
              <Chip
                tone="warning"
                onClick={() => {
                  if (isMicro) selectEnvNode(envAlerts[0].nodeId);
                  setOpenPanel('alerts');
                }}
              >
                {envAlerts[0].code.replace('-', ' ').toLowerCase()}
              </Chip>
            )}
          </>
        )}
        {siteAlerts.length > 0 && (
          <button
            onClick={() => setOpenPanel(openPanel === 'alerts' ? 'none' : 'alerts')}
            className="rounded-full border border-ink-300/40 bg-white/80 px-2.5 py-1 text-[9px] tracking-[0.16em] text-ink-500 backdrop-blur-xl transition hover:text-ink-900"
          >
            {openPanel === 'alerts' ? 'HIDE' : 'DETAIL'}
          </button>
        )}
      </div>

      {/* ---------- MACRO: aggregated resource glass panel ---------- */}
      {isMacro && <MacroResourcePanel />}

      {/* ---------- MICRO: floor selector ---------- */}
      {isMicro && (
        <FloorSelector siteId={activeSite} active={activeFloor} onSelect={setActiveFloor} />
      )}

      {/* ---------- DISCLOSURE PANELS ---------- */}
      {isMicro && openPanel === 'pillars' && <PillarPanel siteId={activeSite} />}
      {openPanel === 'alerts' && (
        <AlertPanel
          activeSite={activeSite}
          alerts={alerts.slice(0, 7)}
          isMicro={isMicro}
          onLocate={(pillar, nodeId) => {
            if (pillar === 'machinery') selectMachine(nodeId);
            else selectEnvNode(nodeId);
          }}
        />
      )}

      {/* ---------- BOTTOM BAR ---------- */}
      <footer className="pointer-events-auto absolute inset-x-0 bottom-0 flex items-end justify-between gap-4 p-5">
        <div className="flex items-center gap-2">
          {isMacro &&
            SITE_IDS.map((id) => (
              <button
                key={id}
                onClick={() => beginDive(id)}
                className="group rounded-full border border-signal-cyan bg-signal-cyan px-5 py-2.5 text-[11px] font-semibold tracking-[0.18em] text-white shadow-glow transition hover:bg-[#1577b0]"
              >
                Enter {SITES[id].city.split(',')[0]}
              </button>
            ))}
          {isMicro && (
            <>
              <button
                onClick={beginAscent}
                className="rounded-full border border-ink-300/40 bg-white/80 px-4 py-2.5 text-[11px] tracking-[0.16em] text-ink-700 backdrop-blur-xl transition hover:text-ink-900"
              >
                ← Orbit
              </button>
              <button
                onClick={() => setOpenPanel(openPanel === 'pillars' ? 'none' : 'pillars')}
                className={`rounded-full border px-4 py-2.5 text-[11px] tracking-[0.16em] backdrop-blur-xl transition ${
                  openPanel === 'pillars'
                    ? 'border-signal-cyan/50 bg-signal-cyan/10 text-signal-cyan'
                    : 'border-ink-300/40 bg-white/80 text-ink-700 hover:text-ink-900'
                }`}
              >
                Operations
              </button>
            </>
          )}
          {(phase === 'descending' || phase === 'handoff' || phase === 'ascending') && (
            <div className="rounded-full border border-ink-300/40 bg-white/80 px-4 py-2.5 text-[11px] tracking-[0.16em] text-ink-500 backdrop-blur-xl">
              <span className="animate-flicker">Transitioning…</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <span className="hidden text-[8.5px] tracking-[0.16em] text-ink-400 lg:block">
            {isMicro ? '1 · 2 · 3 floors   0 all   esc back' : '1 · 2 sites   space freeze'}
          </span>
          <button
            onClick={togglePause}
            className="rounded-full border border-ink-300/40 bg-white/80 px-3.5 py-2 text-[10px] tracking-[0.16em] text-ink-600 backdrop-blur-xl transition hover:text-ink-900"
          >
            {paused ? '▶' : '❚❚'}
          </button>
        </div>
      </footer>

      <ShareLink siteId={activeSite} floor={activeFloor} phase={phase} />
    </div>
  );
}

/* ========================================================================== */
/* Top bar                                                                    */
/* ========================================================================== */

function TopBar({ phase, paused }: { phase: string; paused: boolean }) {
  const activeSite = useMegnetoStore((s) => s.activeSite);
  const site = SITES[activeSite];
  const label = phase === 'micro' ? site.city.split(',')[0] : phase === 'macro' ? 'Two nodes' : 'Transitioning';

  return (
    <header className="pointer-events-auto absolute left-5 top-5 flex items-center gap-3">
      <div className="relative grid h-9 w-9 place-items-center rounded-xl border border-signal-cyan/30 bg-white/80 shadow-glow backdrop-blur-xl">
        <span className="absolute inset-0 animate-pulse-ring rounded-xl border border-signal-cyan/30" />
        <span className="text-[14px] font-bold tracking-tighter text-signal-cyan">M</span>
      </div>
      <div>
        <h1 className="text-[13px] font-semibold tracking-[0.26em] text-ink-900">MEGNETO</h1>
        <p className="text-[9px] tracking-[0.18em] text-ink-400">
          {label}
          {paused && <span className="ml-2 text-signal-amber">PAUSED</span>}
        </p>
      </div>
    </header>
  );
}

/* ========================================================================== */
/* Master output counter                                                      */
/* ========================================================================== */

function MasterCounter({ siteId }: { siteId: string }) {
  const valueRef = useRef<HTMLSpanElement>(null);
  const rateRef = useRef<HTMLSpanElement>(null);
  const unitRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let raf = 0;
    let acc = 0;
    let last = performance.now();
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      acc += (now - last) / 1000;
      last = now;
      if (acc < HUD_HZ) return;
      acc = 0;

      const world = getWorld();
      const s = getSite(world.activeSite);
      if (valueRef.current) valueRef.current.textContent = nf.format(Math.round(s.totals.unitsDisplay));
      if (rateRef.current) rateRef.current.textContent = `${Math.round(s.totals.throughputPerHour)}/hr`;
      if (unitRef.current) unitRef.current.textContent = s.def.productUnit;
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="pointer-events-none absolute left-1/2 top-5 -translate-x-1/2 text-center">
      <div className="flex items-baseline justify-center gap-2">
        <span ref={valueRef} className="text-[38px] font-semibold leading-none tracking-tight text-ink-900">
          0
        </span>
        <span ref={unitRef} className="text-[12px] text-ink-400">
          pcs
        </span>
      </div>
      <p className="mt-1 text-[9px] tracking-[0.2em] text-ink-400">
        OUTPUT TODAY · <span ref={rateRef}>0/hr</span>
      </p>
    </div>
  );
}

/* ========================================================================== */
/* Floor selector                                                             */
/* ========================================================================== */

function FloorSelector({
  siteId,
  active,
  onSelect,
}: {
  siteId: 'tiruppur' | 'rajajinagar';
  active: FloorSelection;
  onSelect: (f: FloorSelection) => void;
}) {
  const site = SITES[siteId];
  const countRefs = useRef<Record<string, HTMLSpanElement | null>>({});
  const dotRefs = useRef<Record<string, HTMLSpanElement | null>>({});

  useEffect(() => {
    let raf = 0;
    let acc = 0;
    let last = performance.now();
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      acc += (now - last) / 1000;
      last = now;
      if (acc < 0.25) return; // 4Hz: headcount does not need more
      acc = 0;

      for (const f of FLOOR_INDICES) {
        const head = floorHeadcount(siteId, f);
        const el = countRefs.current[f];
        if (el) el.textContent = nf.format(head.onShift);

        const dot = dotRefs.current[f];
        if (dot) {
          const { open, actionable } = floorAlertCount(siteId, f);
          dot.style.opacity = open > 0 ? '1' : '0';
          dot.style.background = actionable > 0 ? '#d13a57' : '#c57600';
        }
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [siteId]);

  const Item = ({ selection, pill, name, caption }: { selection: FloorSelection; pill: string; name: string; caption?: string }) => {
    const isActive = active === selection;
    return (
      <button
        onClick={() => onSelect(selection)}
        className={`group relative flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left transition ${
          isActive ? 'bg-signal-cyan text-white shadow-glow' : 'text-ink-600 hover:bg-white/70'
        }`}
      >
        <span className={`text-[11px] font-semibold tracking-wide ${isActive ? 'text-white' : 'text-ink-900'}`}>
          {pill}
        </span>
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-[10px] ${isActive ? 'text-white/90' : 'text-ink-700'}`}>{name}</span>
          {caption && (
            <span className={`block truncate text-[8px] tracking-wide ${isActive ? 'text-white/70' : 'text-ink-400'}`}>
              {caption}
            </span>
          )}
        </span>
        {typeof selection === 'number' && (
          <span className="flex shrink-0 items-center gap-1.5">
            <span
              ref={(el) => {
                dotRefs.current[selection] = el;
              }}
              className="h-1.5 w-1.5 rounded-full opacity-0 transition-opacity"
            />
            <span
              ref={(el) => {
                countRefs.current[selection] = el;
              }}
              className={`text-[9px] tabular-nums ${isActive ? 'text-white/80' : 'text-ink-400'}`}
            >
              0
            </span>
          </span>
        )}
      </button>
    );
  };

  return (
    <aside className="pointer-events-auto absolute right-5 top-1/2 w-[218px] -translate-y-1/2 animate-slide-up">
      <div className="rounded-2xl border border-white/60 bg-white/55 p-1.5 shadow-hud backdrop-blur-2xl">
        {/* Top of the list is the top of the building, which is the only
            ordering anyone reads correctly on a vertical menu. */}
        {[...FLOOR_INDICES].reverse().map((f) => {
          const def = site.floors.find((x) => x.index === f);
          return <Item key={f} selection={f} pill={def?.pill ?? `L${f + 1}`} name={def?.name ?? ''} caption={def?.caption} />;
        })}
        <div className="my-1 h-px bg-ink-300/30" />
        <Item selection="all" pill="◼" name="Whole building" />
      </div>
    </aside>
  );
}

/* ========================================================================== */
/* Macro resource panel — glass, aggregated across both nodes                 */
/* ========================================================================== */

function MacroResourcePanel() {
  const refs = useRef<Record<string, HTMLSpanElement | null>>({});

  useEffect(() => {
    let raf = 0;
    let acc = 0;
    let last = performance.now();
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      acc += (now - last) / 1000;
      last = now;
      if (acc < HUD_HZ) return;
      acc = 0;

      const world = getWorld();
      const set = (k: string, v: string) => {
        const el = refs.current[k];
        if (el) el.textContent = v;
      };

      /* --- aggregate grid draw across both nodes --- */
      let kw = 0;
      let onShift = 0;
      let openAlerts = 0;
      let weatherDrag = 0;
      for (const id of SITE_IDS) {
        const s = getSite(id);
        kw += s.machines.reduce((sum, m) => sum + m.kw, 0);
        if (s.physics.kind === 'textile') kw += s.physics.zld.steamKw;
        else kw += s.physics.grid.hvacKw;
        onShift += s.totals.onShift;
        openAlerts += s.totals.openAlerts;
        // Weather drag: rain slows the corridor, heat loads the HVAC.
        weatherDrag += s.weather.rainMmH * 0.6 + Math.max(0, s.weather.tempC - 30) * 0.8;
      }
      set('power', `${nf.format(Math.round(kw))} kW`);
      set('mob', `${nf.format(onShift)} / ${nf.format(TOTAL_HEADCOUNT)}`);
      set('alerts', String(openAlerts));

      /* --- supply chain: mean remaining transit across every live lane --- */
      const lanes = world.convoys;
      const meanEta = lanes.reduce((sum, c) => sum + c.etaMinutes, 0) / Math.max(1, lanes.length);
      set('transit', `${Math.floor(meanEta / 60)}h ${Math.round(meanEta % 60)}m`);
      const inTransit = lanes.reduce((sum, c) => sum + c.unitsInTransit, 0);
      set('units', nf.format(inTransit));

      /* --- weather impact, as a single readable verdict --- */
      const verdict = weatherDrag > 6 ? 'Significant' : weatherDrag > 2.5 ? 'Moderate' : 'Negligible';
      set('weather', verdict);
      const el = refs.current.weather;
      if (el) el.style.color = weatherDrag > 6 ? '#d13a57' : weatherDrag > 2.5 ? '#c57600' : '#0c9183';
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const Row = ({ label, k, hint }: { label: string; k: string; hint?: string }) => (
    <div className="flex items-baseline justify-between gap-6 px-4 py-2.5">
      <div>
        <div className="text-[9px] tracking-[0.18em] text-ink-400">{label}</div>
        {hint && <div className="text-[8px] tracking-wide text-ink-300">{hint}</div>}
      </div>
      <span
        ref={(el) => {
          refs.current[k] = el;
        }}
        className="text-[15px] font-semibold tabular-nums text-ink-900"
      >
        —
      </span>
    </div>
  );

  return (
    <aside className="pointer-events-auto absolute right-5 top-1/2 w-[268px] -translate-y-1/2 animate-slide-up">
      <div className="overflow-hidden rounded-2xl border border-white/60 bg-white/55 shadow-hud backdrop-blur-2xl">
        <div className="border-b border-ink-300/25 px-4 py-2.5">
          <h2 className="text-[10px] font-semibold tracking-[0.2em] text-ink-700">MACRO RESOURCES</h2>
          <p className="text-[8.5px] tracking-wide text-ink-400">Both nodes · live aggregate</p>
        </div>
        <div className="divide-y divide-ink-300/20">
          <Row label="GRID DRAW" k="power" hint="process + utilities" />
          <Row label="IN TRANSIT" k="units" hint={`${INTER_SITE_LANE.distanceKm} km corridor`} />
          <Row label="MEAN TRANSIT" k="transit" hint="all active lanes" />
          <Row label="WORKFORCE" k="mob" hint="on shift / enrolled" />
          <Row label="WEATHER IMPACT" k="weather" hint="rain + heat drag" />
          <Row label="OPEN ALERTS" k="alerts" />
        </div>
      </div>
    </aside>
  );
}

/* ========================================================================== */
/* Collapsible eight pillars                                                  */
/* ========================================================================== */

function PillarPanel({ siteId }: { siteId: 'tiruppur' | 'rajajinagar' }) {
  const [expanded, setExpanded] = useState<Pillar | null>(null);
  const refs = useRef<Record<string, { value: HTMLSpanElement | null; unit: HTMLSpanElement | null; cap: HTMLSpanElement | null; bar: HTMLDivElement | null }>>({});

  useEffect(() => {
    let raf = 0;
    let acc = 0;
    let last = performance.now();
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      acc += (now - last) / 1000;
      last = now;
      if (acc < HUD_HZ) return;
      acc = 0;

      const s = getSite(siteId);
      for (const key of PILLARS) {
        const row = refs.current[key];
        if (!row) continue;
        const m = s.pillars[key];
        if (row.value) row.value.textContent = fmt(m.display);
        if (row.unit) row.unit.textContent = m.unit;
        if (row.cap) row.cap.textContent = m.caption;
        if (row.bar) {
          row.bar.style.width = `${(m.health * 100).toFixed(0)}%`;
          row.bar.style.background = m.health > 0.6 ? PILLAR_COLOR[key] : m.health > 0.3 ? '#c57600' : '#d13a57';
        }
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [siteId]);

  const setRef = useCallback(
    (key: Pillar, slot: 'value' | 'unit' | 'cap' | 'bar') => (el: never) => {
      refs.current[key] ??= { value: null, unit: null, cap: null, bar: null };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (refs.current[key] as any)[slot] = el;
    },
    [],
  );

  return (
    <aside className="pointer-events-auto absolute bottom-20 left-5 w-[300px] animate-slide-up">
      <div className="overflow-hidden rounded-2xl border border-white/60 bg-white/70 shadow-hud backdrop-blur-2xl">
        <div className="border-b border-ink-300/25 px-4 py-2.5">
          <h2 className="text-[10px] font-semibold tracking-[0.2em] text-ink-700">OPERATIONS</h2>
          <p className="text-[8.5px] tracking-wide text-ink-400">Tap a pillar for detail</p>
        </div>
        <ul className="divide-y divide-ink-300/20">
          {PILLARS.map((key) => (
            <li key={key}>
              <button
                onClick={() => setExpanded(expanded === key ? null : key)}
                className="flex w-full items-center gap-2.5 px-4 py-2 text-left transition hover:bg-white/60"
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: PILLAR_COLOR[key] }} />
                <span className="flex-1 text-[10.5px] text-ink-700">{PILLAR_LABEL[key]}</span>
                <span ref={setRef(key, 'value')} className="text-[13px] font-semibold tabular-nums text-ink-900">
                  0
                </span>
                <span ref={setRef(key, 'unit')} className="w-16 shrink-0 text-right text-[8px] text-ink-400">
                  —
                </span>
              </button>
              {expanded === key && (
                <div className="animate-slide-up px-4 pb-2.5">
                  <div className="h-[3px] overflow-hidden rounded-full bg-frost-400">
                    <div ref={setRef(key, 'bar')} className="h-full rounded-full" style={{ width: '0%' }} />
                  </div>
                  <span ref={setRef(key, 'cap')} className="mt-1.5 block text-[9px] leading-relaxed text-ink-500">
                    —
                  </span>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}

/* ========================================================================== */
/* Alert detail                                                               */
/* ========================================================================== */

function AlertPanel({
  activeSite,
  alerts,
  isMicro,
  onLocate,
}: {
  activeSite: string;
  alerts: ReturnType<typeof getWorld>['alerts'];
  isMicro: boolean;
  onLocate: (pillar: Pillar, nodeId: string) => void;
}) {
  return (
    <aside className="pointer-events-auto absolute left-1/2 top-[128px] w-[360px] -translate-x-1/2 animate-slide-up">
      <div className="overflow-hidden rounded-2xl border border-white/60 bg-white/80 shadow-hud backdrop-blur-2xl">
        <ul className="divide-y divide-ink-300/20">
          {alerts.map((a) => (
            <li key={a.key} className="px-4 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <span
                  className="text-[9px] tracking-[0.16em]"
                  style={{ color: a.severity === 'critical' ? '#d13a57' : '#c57600' }}
                >
                  {a.code} · {a.nodeId}
                </span>
                <span className="text-[8.5px] text-ink-400">{SITES[a.siteId].city.split(',')[0]}</span>
              </div>
              <p className="mt-0.5 text-[10.5px] leading-snug text-ink-700">{a.message}</p>
              {a.actionable && a.siteId === activeSite && isMicro && (
                <button
                  onClick={() => onLocate(a.pillar, a.nodeId)}
                  className="mt-1.5 rounded-full border border-signal-red/40 bg-signal-red/8 px-3 py-1 text-[8.5px] font-semibold tracking-[0.16em] text-signal-red transition hover:bg-signal-red/15"
                >
                  LOCATE ON FLOOR
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}

/* ========================================================================== */
/* Share link                                                                 */
/* ========================================================================== */

/**
 * The URL already carries the state (see UrlStateSync). This just makes that
 * visible and copyable, which is the difference between a demo someone watches
 * and a demo someone forwards.
 */
function ShareLink({ siteId, floor, phase }: { siteId: string; floor: FloorSelection; phase: string }) {
  const [copied, setCopied] = useState(false);
  const [href, setHref] = useState('');

  /**
   * Built in an effect, never during render. Reading `window.location` while
   * rendering makes the server emit one `title` and the client another, which
   * React reports as a hydration mismatch and refuses to patch up.
   */
  useEffect(() => {
    const url = new URL(window.location.href);
    url.search = '';
    if (phase === 'micro') {
      url.searchParams.set('site', siteId);
      url.searchParams.set('floor', String(floor));
    }
    setHref(url.toString());
  }, [siteId, floor, phase]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard can be blocked; the URL bar still shows the state */
    }
  };

  return (
    <button
      onClick={copy}
      className="pointer-events-auto absolute right-5 top-5 rounded-full border border-ink-300/40 bg-white/70 px-3.5 py-2 text-[9px] tracking-[0.16em] text-ink-500 backdrop-blur-xl transition hover:text-ink-900"
      title={href || undefined}
      disabled={!href}
    >
      {copied ? 'LINK COPIED' : 'SHARE THIS VIEW'}
    </button>
  );
}

/* ========================================================================== */
/* Chip                                                                       */
/* ========================================================================== */

function Chip({
  children,
  tone,
  onClick,
}: {
  children: React.ReactNode;
  tone: 'calm' | 'warning' | 'critical';
  onClick?: () => void;
}) {
  const style =
    tone === 'critical'
      ? 'border-signal-red/35 bg-signal-red/10 text-signal-red'
      : tone === 'warning'
        ? 'border-signal-amber/35 bg-signal-amber/10 text-signal-amber'
        : 'border-ink-300/35 bg-white/70 text-ink-400';

  const dot = tone === 'critical' ? 'bg-signal-red' : tone === 'warning' ? 'bg-signal-amber' : 'bg-signal-teal';

  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-[10px] tracking-[0.1em] backdrop-blur-xl transition ${style} ${
        onClick ? 'hover:brightness-95' : 'cursor-default'
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {children}
    </button>
  );
}
