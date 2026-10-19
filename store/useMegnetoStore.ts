/**
 * Megneto V2 — global store, dual-site simulation, environmental physics.
 *
 * ============================================================================
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE
 * ============================================================================
 * The demo runs on a GTX 1650 (4GB VRAM) with 8GB of system RAM. A React
 * re-render that touches the 3D tree on that machine costs more than the frame
 * budget. So this store is split in two halves that never mix:
 *
 *   1. `world` — a plain, stable, MUTABLE object graph. Operator positions,
 *      machine temperatures, absolute humidity, VOC concentration, acoustic
 *      ring buffers, pillar aggregates. It is NOT part of the zustand reactive
 *      state tree and nothing subscribes to it. Renderers read it inside
 *      `useFrame` and mutate three.js objects directly. The HUD reads it from
 *      one rAF loop and writes `textContent`. Zero re-renders, ever.
 *
 *   2. The zustand reactive slice — ONLY discrete, human-paced facts: which
 *      phase is mounted, which site is active, which node is selected, which
 *      operator is hovered, and revision counters for alerts. These change a
 *      few times a minute, not sixty times a second.
 *
 * If you ever find yourself adding an x/y/z or a live counter to the reactive
 * slice, stop: put it in `world` and read it from a frame loop instead.
 * ============================================================================
 *
 * THE ENVIRONMENTAL ENGINE
 * ------------------------
 * The environment is not a random walk with a nice name. It is a set of small
 * but genuine models, integrated forward at 1Hz:
 *
 *   · Outdoor weather     — diurnal cosine for temperature, inverse cosine for
 *                           humidity, plus an Ornstein-Uhlenbeck cloud index
 *                           that drives rainfall and pulls both toward wet-bulb.
 *   · Indoor humidity     — a well-mixed moisture balance in ABSOLUTE humidity
 *                           (g/m³), converted to %RH through the Magnus
 *                           saturation-pressure relation. Sources are vat and
 *                           stenter steam plus the humidification plant; the
 *                           sink is ventilation exchange with outdoor air.
 *   · Dye vat thermal     — lumped first-order mass: dT/dt = (ηP − UA·ΔT)/(m·c),
 *                           with a proportional steam controller.
 *   · ZLD train           — honest flow and salt mass balance across an RO stage
 *                           and a multi-effect evaporator. Salt in equals salt
 *                           out; concentrate TDS rises exactly as recovery does.
 *   · VOC and paper dust  — well-mixed box models with ventilation, scrubber
 *                           efficiency and (for dust) gravitational settling.
 *   · Grid demand         — machine load plus an HVAC term that follows outdoor
 *                           temperature and dehumidification duty, with power
 *                           factor and running peak-kVA against the contract.
 *
 * Every one of those is a real relation you could defend in a due-diligence
 * meeting, which is the point of showing it to investors.
 */

import { create } from 'zustand';
import {
  FLOOR_INDICES,
  KINEMATICS,
  MACRO_NODES,
  MOB_CAPACITY,
  RENDER_FULL_MOB_PER_SITE,
  MAX_RENDERED_OPERATORS,
  OPERATOR_NAMES,
  PILLARS,
  RENDERED_OPERATORS,
  SITES,
  SITE_IDS,
  INTER_SITE_LANE,
  floorElevation,
  type EnvNodeDef,
  type FloorIndex,
  type FloorSelection,
  type MachineDef,
  type MachineStatus,
  type Pillar,
  type RouteDef,
  type SiteDef,
  type SiteId,
} from '@/lib/sites';

/* -------------------------------------------------------------------------- */
/* Phases                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The onion. Only ONE heavy GPU context is alive at a time:
 *
 *   macro       Cesium mounted, R3F unmounted.
 *   descending  Cesium flying the camera down to the chosen site.
 *   handoff     Veil opaque. Cesium DESTROYED (VRAM released). R3F mounting.
 *   micro       R3F only. Cesium unmounted.
 *   ascending   Veil closes over R3F, R3F destroyed, Cesium rebuilt.
 */
export type Phase = 'macro' | 'descending' | 'handoff' | 'micro' | 'ascending';

export type OperatorState = 0 | 1 | 2; // 0 transit, 1 at station, 2 on break

/* -------------------------------------------------------------------------- */
/* Deterministic RNG + maths helpers                                           */
/* -------------------------------------------------------------------------- */

/** mulberry32. Seeded so a live pitch behaves the same way every rehearsal. */
function makeRng(seed: number) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = makeRng(0x4d45474e); // "MEGN"

/** Box-Muller, for the Wiener increments in the weather model. */
function gauss(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

function lerpAngle(a: number, b: number, t: number) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/* ---- psychrometrics ------------------------------------------------------ */

/** Magnus formula. Saturation vapour pressure over water, hPa, for T in °C. */
export function saturationVapourPressure(tempC: number): number {
  return 6.112 * Math.exp((17.67 * tempC) / (tempC + 243.5));
}

/** Absolute humidity (g/m³) from temperature (°C) and relative humidity (%). */
export function absoluteHumidity(tempC: number, rhPct: number): number {
  const es = saturationVapourPressure(tempC);
  return (216.7 * (es * (rhPct / 100))) / (tempC + 273.15);
}

/** Relative humidity (%) from absolute humidity (g/m³) and temperature (°C). */
export function relativeHumidity(ahGm3: number, tempC: number): number {
  const es = saturationVapourPressure(tempC);
  return clamp(((ahGm3 * (tempC + 273.15)) / (216.7 * es)) * 100, 1, 100);
}

/** Dew point (°C) via the inverse Magnus relation. Shown on the environment panel. */
export function dewPoint(tempC: number, rhPct: number): number {
  const gamma = Math.log(clamp(rhPct, 1, 100) / 100) + (17.67 * tempC) / (tempC + 243.5);
  return (243.5 * gamma) / (17.67 - gamma);
}

/** mg/m³ → ppm for a given molar mass, at 25 °C and 1 atm (molar volume 24.45 L). */
export function mgm3ToPpm(mgm3: number, molarMass: number): number {
  return (mgm3 * 24.45) / molarMass;
}

/** Toluene-equivalent, which is how press-hall solvent is normally reported. */
const SOLVENT_MOLAR_MASS = 92.14;

/* -------------------------------------------------------------------------- */
/* Runtime shapes (mutable, non-reactive)                                      */
/* -------------------------------------------------------------------------- */

export interface RouteRuntime {
  readonly id: string;
  readonly floor: FloorIndex;
  readonly pts: Float32Array;
  readonly count: number;
  readonly segLen: Float32Array;
  readonly isStation: Uint8Array;
}

export interface OperatorRuntime {
  readonly index: number;
  readonly id: string;
  readonly rfid: string;
  readonly name: string;
  readonly sector: string;
  readonly floor: FloorIndex;
  readonly route: RouteRuntime;


  // mutated every frame
  x: number;
  z: number;
  heading: number;
  targetHeading: number;
  seg: number;
  segT: number;
  bob: number;

  // mutated on the 1Hz tick
  speed: number;
  baseSpeed: number;
  dwell: number;
  state: OperatorState;
  units: number;
  shiftTargetUnits: number;
  efficiency: number;
  gaitConfidence: number;
  heartRate: number;
  stationId: string;
  /** Heat-stress index, 0..1, rises with indoor WBGT. */
  strain: number;
}

/**
 * THE WORKFORCE, AS FLAT MEMORY
 *
 * Three thousand people cannot be three thousand JavaScript objects that a
 * frame loop walks. Everything the renderer needs per person lives in parallel
 * typed arrays, indexed by instance id, so the hot loop is pure arithmetic over
 * contiguous memory with no property lookups, no allocation and no GC pressure.
 *
 * The first RENDERED_OPERATORS entries are the fully-simulated route-walkers;
 * their positions are overwritten each frame from `operators`. The rest shuffle
 * around a home point they never leave, which is what a factory floor actually
 * looks like from an isometric camera.
 */
export interface MobRuntime {
  /** Anchor position per instance, flat xyz. Never mutated after build. */
  home: Float32Array;
  /** Live position per instance, flat xyz. Written every frame. */
  positions: Float32Array;
  /** Floor index per instance, for isolation culling. */
  floors: Uint8Array;
  /** Index into the site's sector list, for colour and the hover card. */
  sectors: Uint8Array;
  /** Shuffle phase offset, so nobody moves in lockstep. */
  phase: Float32Array;
  /** Shuffle angular rate, rad/s. */
  speed: Float32Array;
  /** Shuffle radius, metres. Most people barely move; a few wander. */
  radius: Float32Array;
  /** Current facing, written each frame. */
  heading: Float32Array;
  /** How many instances this site actually uses. */
  count: number;

  /* ---- per-person telemetry -------------------------------------------
   * Every one of the three thousand is individually queryable. None of it is
   * a JavaScript object: six typed arrays indexed by instance id cost about
   * 60 KB in total and can be read in a pointer handler without allocating.
   * ------------------------------------------------------------------- */

  /** RF-gait match confidence, 0..1. */
  gait: Float32Array;
  /** Shift efficiency, 0..1. */
  efficiency: Float32Array;
  /** Units produced this shift. */
  units: Uint16Array;
  /** Cadence, units per hour. */
  cadence: Float32Array;
  /** Heart rate, bpm. */
  heartRate: Uint8Array;
  /** Thermal / solvent strain, 0..1. */
  strain: Float32Array;
  /** Index into the site's zone list — the person's station assignment. */
  zone: Uint8Array;
  /** Index into the site's machine list, nearest at spawn. */
  station: Uint8Array;
  /** Seed for the RF tag, rendered as hex on demand. */
  rfid: Uint32Array;
  /** Rolling cursor for the staggered telemetry refresh. */
  refreshCursor: number;
}

export interface MachineRuntime {
  readonly def: MachineDef;
  status: MachineStatus;
  tempC: number;
  db: number;
  rpm: number;
  load: number;
  kw: number;
  jobsDone: number;
  queue: number;
  uptimePct: number;
  cycleT: number;

  /* ---- kinematics: the only thing that can produce a unit ----------------
   *
   * `kin` is the live phase of the physical motion, 0..1 per stroke. The
   * renderer positions the needle (or rotates the cylinder) from it, and the
   * production counter increments from it. One variable drives both, which is
   * what makes "counted by watching the machine move" a claim about the code
   * and not just about the animation.
   *
   * A jam sets `strokeHz` to zero. The phase stops advancing, so the needle
   * stops, so the ring stops filling, so output stops. There is no timer that
   * could keep counting behind the scenes, because there is no timer.
   * --------------------------------------------------------------------- */

  /** Phase of the current stroke, 0..1. */
  kin: number;
  /** Completed strokes since boot. */
  strokes: number;
  /** Strokes completed toward the current production cycle. */
  strokesThisUnit: number;
  /** Current stroke rate, Hz. Zero when jammed — and so is production. */
  strokeHz: number;
  /** 0..1 progress toward the next completed cycle. Drives the UI ring. */
  unitProgress: number;
  /** Simulation clock of the last completed cycle, so the UI can flash. */
  lastUnitAt: number;

  acoustic: Float32Array;
  acousticHead: number;
  /** Seconds remaining in a self-clearing fault. 0 when healthy. */
  faultT: number;
  faultCode: string;
  vibration: number;
  /** A jam does NOT self-clear. The operator must click the node. */
  jammed: boolean;
  jamSeconds: number;
  /** Units rejected by QA from this machine this shift. */
  rejects: number;
}

export interface EnvNodeRuntime {
  readonly def: EnvNodeDef;
  status: MachineStatus;
  /** Headline value and unit, rendered on the node tag and the panel. */
  primary: number;
  primaryUnit: string;
  secondary: number;
  secondaryUnit: string;
  /** True when this node needs a human: drives the 3D aura and the HUD. */
  alert: boolean;
  alertCode: string;
  alertMessage: string;
  /** Seconds the alert has been standing. Feeds escalation. */
  alertSeconds: number;
  /**
   * Seconds left in a correction window. While this is running the node is
   * actively being pulled back into spec, so the engine must NOT re-raise the
   * same alarm on the next tick — otherwise clicking the node looks like it
   * did nothing, when in fact the physics is already converging.
   */
  correctingT: number;
}

/* ---- site-specific physics ---------------------------------------------- */

export interface TextilePhysics {
  readonly kind: 'textile';
  /** Indoor absolute humidity, g/m³ — the actual integrated state. */
  ah: number;
  /** Derived each tick from `ah` and indoor temperature. */
  rh: number;
  indoorTempC: number;
  dewPointC: number;
  /** Operator-facing heat stress, approximated WBGT (°C). */
  wbgt: number;
  /** Humidification plant: setpoint %RH and commanded duty 0..1. */
  rhSetpoint: number;
  humidifierDuty: number;
  /** Dehumidification plant duty, 0..1. Ventilation alone is far too slow. */
  dehumidDuty: number;
  /** Moisture actually removed, g/s. */
  dehumidGs: number;
  /** Moisture injected by the plant this tick, g/s. */
  humidifierGs: number;
  /** Steam leakage from vats and the stenter, g/s. */
  processMoistureGs: number;
  ventilationAch: number;
  /** Dye vats, each an independent thermal mass. */
  vats: {
    id: string;
    tempC: number;
    setpointC: number;
    steamKw: number;
    /** Water charge, kg — the thermal mass that makes these slow. */
    massKg: number;
  }[];
  zld: {
    feedM3h: number;
    tdsFeedMgL: number;
    roRecovery: number;
    permeateM3h: number;
    permeateTdsMgL: number;
    rejectM3h: number;
    rejectTdsMgL: number;
    meeEvapM3h: number;
    saltKgH: number;
    steamKw: number;
    /** Overall water recovered back into process, %. */
    recoveryPct: number;
  };
}

export interface PrintingPhysics {
  readonly kind: 'printing';
  indoorTempC: number;
  rh: number;
  /** Press-hall solvent vapour. Integrated as mg/m³, reported as ppm. */
  vocMgM3: number;
  vocPpm: number;
  /** Solvent evaporation rate, mg/s, from ink laydown. */
  vocSourceMgS: number;
  scrubberEfficiency: number;
  scrubberDuty: number;
  extractionAch: number;
  /** Seconds of emergency purge remaining. Multiplies the removal rate. */
  purgeT: number;
  /** Respirable paper dust, µg/m³. */
  dustUgM3: number;
  dustSourceUgS: number;
  /** Gravitational settling velocity, m/s — why dust self-clears and VOC does not. */
  settlingMs: number;
  grid: {
    processKw: number;
    hvacKw: number;
    totalKw: number;
    powerFactor: number;
    kva: number;
    peakKva: number;
    dailyKwh: number;
    /** Fraction of the sanctioned contract demand in use. */
    contractUsePct: number;
  };
}

export type SitePhysics = TextilePhysics | PrintingPhysics;

export interface WeatherRuntime {
  tempC: number;
  rh: number;
  /** Ornstein-Uhlenbeck cloud index, 0..1. */
  cloud: number;
  rainMmH: number;
  windMs: number;
  /** Local solar hour, 0..24. */
  hour: number;
  aqi: number;
}

export interface PillarMetric {
  /** Headline number as displayed. */
  value: number;
  /** Smoothed value the odometer eases toward. */
  display: number;
  unit: string;
  /** −1..1 trend, for the arrow and sparkline tint. */
  trend: number;
  /** 0..1 health; below 0.5 the panel goes amber, below 0.25 red. */
  health: number;
  caption: string;
}

export interface AlertRecord {
  readonly key: number;
  readonly siteId: SiteId;
  readonly nodeId: string;
  readonly nodeName: string;
  readonly pillar: Pillar;
  readonly severity: 'warning' | 'critical';
  readonly code: string;
  readonly message: string;
  readonly at: number;
  /** True when the alert needs a click on the 3D node to clear. */
  readonly actionable: boolean;
  resolved: boolean;
}

export interface SiteRuntime {
  readonly def: SiteDef;
  machines: MachineRuntime[];
  operators: OperatorRuntime[];
  /** The whole workforce as flat typed arrays. See MobRuntime. */
  mob: MobRuntime;
  envNodes: EnvNodeRuntime[];
  physics: SitePhysics;
  weather: WeatherRuntime;
  pillars: Record<Pillar, PillarMetric>;
  /** Live headcount per sector id. */
  sectorOnShift: Record<string, number>;
  /** Flat xyz for the operator InstancedMesh. Allocated once. */
  positions: Float32Array;
  headings: Float32Array;
  states: Uint8Array;
  totals: {
    unitsBuilt: number;
    unitsDisplay: number;
    throughputPerHour: number;
    oee: number;
    yieldPct: number;
    headcount: number;
    onShift: number;
    openAlerts: number;
    actionableAlerts: number;
    shiftSeconds: number;
  };
}

export interface ConvoyRuntime {
  readonly id: string;
  readonly label: string;
  readonly fromLat: number;
  readonly fromLon: number;
  readonly toLat: number;
  readonly toLon: number;
  readonly kind: 'supplier' | 'customer' | 'hub' | 'inter-site';
  /** 0..1 along the lane. */
  progress: number;
  unitsInTransit: number;
  etaMinutes: number;
  speedKph: number;
}

export interface MegnetoWorld {
  sites: Record<SiteId, SiteRuntime>;
  convoys: ConvoyRuntime[];
  alerts: AlertRecord[];
  /** Wall-clock of the last useFrame-driven advance, so the interval can idle. */
  lastFrameAt: number;
  clock: number;
  eventAccum: number;
  paused: boolean;
  /** Which site the micro layer is currently rendering. */
  activeSite: SiteId;
}

/* -------------------------------------------------------------------------- */
/* Construction                                                                */
/* -------------------------------------------------------------------------- */

function buildRoute(def: RouteDef): RouteRuntime {
  const n = def.waypoints.length;
  const pts = new Float32Array(n * 2);
  const segLen = new Float32Array(n);
  const isStation = new Uint8Array(n);

  for (let i = 0; i < n; i++) {
    pts[i * 2] = def.waypoints[i][0];
    pts[i * 2 + 1] = def.waypoints[i][1];
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = pts[j * 2] - pts[i * 2];
    const dz = pts[j * 2 + 1] - pts[i * 2 + 1];
    segLen[i] = Math.hypot(dx, dz) || 0.0001;
  }
  for (const s of def.stations) isStation[s] = 1;

  return { id: def.id, floor: def.floor, pts, count: n, segLen, isStation };
}

function nearestMachineId(site: SiteDef, x: number, z: number): string {
  let best = site.machines[0].id;
  let bestD = Infinity;
  for (const m of site.machines) {
    const d = (m.position[0] - x) ** 2 + (m.position[2] - z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = m.id;
    }
  }
  return best;
}

/**
 * Places the whole workforce, once, at startup.
 *
 * Every person is assigned to a sector, which fixes their floor, then dropped
 * into one of that floor's zones by rejection sampling against the machine and
 * apparatus footprints — so nobody spawns standing inside a dye vat. Eight
 * attempts, then we accept whatever we have; at 1,850 placements the cost is a
 * couple of milliseconds and it only ever runs once.
 */
function buildMob(def: SiteDef): MobRuntime {
  const enrolled = def.sectors.reduce((s, sec) => s + sec.headcount, 0);
  const count = RENDER_FULL_MOB_PER_SITE ? MOB_CAPACITY : Math.min(MOB_CAPACITY, enrolled);

  const home = new Float32Array(MOB_CAPACITY * 3);
  const positions = new Float32Array(MOB_CAPACITY * 3);
  const floors = new Uint8Array(MOB_CAPACITY);
  const sectors = new Uint8Array(MOB_CAPACITY);
  const phase = new Float32Array(MOB_CAPACITY);
  const speed = new Float32Array(MOB_CAPACITY);
  const radius = new Float32Array(MOB_CAPACITY);
  const heading = new Float32Array(MOB_CAPACITY);
  const gait = new Float32Array(MOB_CAPACITY);
  const efficiency = new Float32Array(MOB_CAPACITY);
  const units = new Uint16Array(MOB_CAPACITY);
  const cadence = new Float32Array(MOB_CAPACITY);
  const heartRate = new Uint8Array(MOB_CAPACITY);
  const strain = new Float32Array(MOB_CAPACITY);
  const zoneIdx = new Uint8Array(MOB_CAPACITY);
  const stationIdx = new Uint8Array(MOB_CAPACITY);
  const rfid = new Uint32Array(MOB_CAPACITY);

  /** Obstacles to avoid, as expanded 2D boxes, grouped by floor. */
  const blockers: Record<number, { x0: number; z0: number; x1: number; z1: number }[]> = { 0: [], 1: [], 2: [] };
  const pad = 0.9;
  for (const m of def.machines) {
    blockers[m.floor].push({
      x0: m.position[0] - m.size[0] / 2 - pad,
      z0: m.position[2] - m.size[2] / 2 - pad,
      x1: m.position[0] + m.size[0] / 2 + pad,
      z1: m.position[2] + m.size[2] / 2 + pad,
    });
  }
  for (const n of def.envNodes) {
    blockers[n.floor].push({
      x0: n.position[0] - n.size[0] / 2 - pad,
      z0: n.position[2] - n.size[2] / 2 - pad,
      x1: n.position[0] + n.size[0] / 2 + pad,
      z1: n.position[2] + n.size[2] / 2 + pad,
    });
  }

  const blocked = (floor: number, x: number, z: number) => {
    const list = blockers[floor];
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1) return true;
    }
    return false;
  };

  let cursor = 0;
  const placeInto = (floor: FloorIndex, sectorIndex: number, howMany: number) => {
    const zones = def.zones.filter((z) => z.floor === floor);
    if (zones.length === 0) return;
    const y = floorElevation(def, floor);

    for (let n = 0; n < howMany && cursor < count; n++, cursor++) {
      const zone = zones[n % zones.length];
      const [minX, minZ, maxX, maxZ] = zone.bounds;
      const margin = 1.0;

      let x = 0;
      let z = 0;
      for (let attempt = 0; attempt < 8; attempt++) {
        x = minX + margin + rng() * Math.max(0.2, maxX - minX - margin * 2);
        z = minZ + margin + rng() * Math.max(0.2, maxZ - minZ - margin * 2);
        if (!blocked(floor, x, z)) break;
      }

      const o = cursor * 3;
      home[o] = x;
      home[o + 1] = y;
      home[o + 2] = z;
      positions[o] = x;
      positions[o + 1] = y;
      positions[o + 2] = z;
      floors[cursor] = floor;
      sectors[cursor] = sectorIndex;
      phase[cursor] = rng() * Math.PI * 2;
      // Most people work a station and barely move; a minority circulate.
      const wanderer = rng() < 0.22;
      speed[cursor] = wanderer ? 0.18 + rng() * 0.3 : 0.05 + rng() * 0.12;
      radius[cursor] = wanderer ? 0.8 + rng() * 1.6 : 0.12 + rng() * 0.4;
      heading[cursor] = rng() * Math.PI * 2;

      // Individual telemetry. Seeded from the same deterministic RNG, so a
      // given worker reads the same on every rehearsal.
      gait[cursor] = 0.86 + rng() * 0.135;
      efficiency[cursor] = 0.62 + rng() * 0.36;
      units[cursor] = 20 + Math.floor(rng() * 160);
      cadence[cursor] = 8 + rng() * 26;
      heartRate[cursor] = 68 + Math.floor(rng() * 34);
      strain[cursor] = 0.1 + rng() * 0.3;
      zoneIdx[cursor] = def.zones.indexOf(zone);
      rfid[cursor] = 0x1a2b0000 + cursor * 0x3f7 + Math.floor(rng() * 0xfff);

      // Nearest machine on this floor becomes the station assignment.
      let best = 0;
      let bestD = Infinity;
      for (let mi = 0; mi < def.machines.length; mi++) {
        const mdef = def.machines[mi];
        if (mdef.floor !== floor) continue;
        const d = (mdef.position[0] - x) ** 2 + (mdef.position[2] - z) ** 2;
        if (d < bestD) {
          bestD = d;
          best = mi;
        }
      }
      stationIdx[cursor] = best;
    }
  };

  if (RENDER_FULL_MOB_PER_SITE) {
    // Scale every sector up proportionally to fill the full 3,000.
    const scale = MOB_CAPACITY / enrolled;
    def.sectors.forEach((sec, i) => placeInto(sec.floor, i, Math.round(sec.headcount * scale)));
  } else {
    def.sectors.forEach((sec, i) => placeInto(sec.floor, i, sec.headcount));
  }

  // Any rounding shortfall gets topped up on the busiest floor.
  while (cursor < count) {
    const sec = def.sectors[0];
    placeInto(sec.floor, 0, count - cursor);
  }

  return {
    home,
    positions,
    floors,
    sectors,
    phase,
    speed,
    radius,
    heading,
    count,
    gait,
    efficiency,
    units,
    cadence,
    heartRate,
    strain,
    zone: zoneIdx,
    station: stationIdx,
    rfid,
    refreshCursor: 0,
  };
}

function emptyPillars(): Record<Pillar, PillarMetric> {
  const out = {} as Record<Pillar, PillarMetric>;
  for (const p of PILLARS) {
    out[p] = { value: 0, display: 0, unit: '', trend: 0, health: 1, caption: '' };
  }
  return out;
}

function buildPhysics(site: SiteDef): SitePhysics {
  if (site.kind === 'textile') {
    const indoorTempC = site.climate.meanTempC + 2.5;
    const rh = 62;
    return {
      kind: 'textile',
      ah: absoluteHumidity(indoorTempC, rh),
      rh,
      indoorTempC,
      dewPointC: dewPoint(indoorTempC, rh),
      wbgt: 27,
      rhSetpoint: 62,
      humidifierDuty: 0.4,
      dehumidDuty: 0,
      dehumidGs: 0,
      humidifierGs: 0,
      processMoistureGs: 0,
      ventilationAch: 4.2,
      vats: site.machines
        .filter((m) => m.kind === 'dyeing')
        .map((m) => ({
          id: m.id,
          tempC: 72 + rng() * 14,
          setpointC: m.nominalTempC,
          steamKw: 0,
          massKg: 2400,
        })),
      zld: {
        feedM3h: 46,
        tdsFeedMgL: 5400,
        roRecovery: 0.72,
        permeateM3h: 0,
        permeateTdsMgL: 0,
        rejectM3h: 0,
        rejectTdsMgL: 0,
        meeEvapM3h: 0,
        saltKgH: 0,
        steamKw: 0,
        recoveryPct: 0,
      },
    };
  }

  const indoorTempC = site.climate.meanTempC + 3.5;
  return {
    kind: 'printing',
    indoorTempC,
    rh: 52,
    vocMgM3: 42,
    vocPpm: mgm3ToPpm(42, SOLVENT_MOLAR_MASS),
    vocSourceMgS: 0,
    scrubberEfficiency: 0.88,
    scrubberDuty: 0.55,
    extractionAch: 6.5,
    purgeT: 0,
    dustUgM3: 58,
    dustSourceUgS: 0,
    settlingMs: 0.0042,
    grid: {
      processKw: 0,
      hvacKw: 0,
      totalKw: 0,
      powerFactor: 0.93,
      kva: 0,
      peakKva: 0,
      dailyKwh: 8400,
      contractUsePct: 0,
    },
  };
}

function buildSite(def: SiteDef, seedOffset: number): SiteRuntime {
  const routes = def.routes.map(buildRoute);

  const operators: OperatorRuntime[] = [];
  for (let i = 0; i < RENDERED_OPERATORS; i++) {
    const route = routes[i % routes.length];
    const seg = (i * 2 + Math.floor(rng() * route.count)) % route.count;
    const segT = rng();
    const x = lerp(route.pts[seg * 2], route.pts[((seg + 1) % route.count) * 2], segT);
    const z = lerp(route.pts[seg * 2 + 1], route.pts[((seg + 1) % route.count) * 2 + 1], segT);
    const baseSpeed = 0.85 + rng() * 0.55;
    // Pick a sector that actually lives on this operator's floor, so the
    // tooltip never claims a stitcher is standing in the dye house.
    const floorSectors = def.sectors.filter((sec) => sec.floor === route.floor);
    const sector = floorSectors.length > 0 ? floorSectors[i % floorSectors.length] : def.sectors[i % def.sectors.length];

    operators.push({
      index: i,
      id: `${def.id === 'tiruppur' ? 'TPR' : 'RJN'}-${String(i + 1).padStart(3, '0')}`,
      rfid: `RF:${(0x1a2b + (i + seedOffset) * 0x3f7).toString(16).toUpperCase()}-${(
        0xc400 + Math.floor(rng() * 0xfff)
      )
        .toString(16)
        .toUpperCase()}`,
      name: OPERATOR_NAMES[(i + seedOffset) % OPERATOR_NAMES.length],
      sector: sector.label,
      floor: route.floor,
      route,
      x,
      z,
      heading: 0,
      targetHeading: 0,
      seg,
      segT,
      bob: rng() * Math.PI * 2,
      speed: baseSpeed,
      baseSpeed,
      dwell: 0,
      state: 0,
      units: 40 + Math.floor(rng() * 70),
      shiftTargetUnits: 180 + Math.floor(rng() * 60),
      efficiency: 0.74 + rng() * 0.24,
      gaitConfidence: 0.91 + rng() * 0.085,
      heartRate: 72 + Math.floor(rng() * 22),
      stationId: nearestMachineId(def, x, z),
      strain: 0.2,
    });
  }

  const machines: MachineRuntime[] = def.machines.map((m) => {
    const acoustic = new Float32Array(48);
    for (let i = 0; i < acoustic.length; i++) {
      acoustic[i] = clamp(m.nominalDb + (rng() - 0.5) * 6, 20, 120);
    }
    return {
      def: m,
      status: 'nominal',
      tempC: m.nominalTempC * (0.6 + rng() * 0.2),
      db: m.nominalDb,
      rpm: m.nominalRpm,
      load: 0.55 + rng() * 0.35,
      kw: 0,
      jobsDone: 60 + Math.floor(rng() * 220),
      queue: 2 + Math.floor(rng() * 9),
      uptimePct: 94 + rng() * 5.4,
      cycleT: rng() * m.cycleSeconds,
      kin: rng(),
      strokes: 0,
      strokesThisUnit: Math.floor(rng() * KINEMATICS[m.kind].perUnit),
      strokeHz: 0,
      unitProgress: 0,
      lastUnitAt: 0,
      acoustic,
      acousticHead: acoustic.length - 1,
      faultT: 0,
      faultCode: '',
      vibration: 0.4 + rng() * 0.5,
      jammed: false,
      jamSeconds: 0,
      rejects: Math.floor(rng() * 14),
    };
  });

  const envNodes: EnvNodeRuntime[] = def.envNodes.map((n) => ({
    def: n,
    status: 'nominal',
    primary: 0,
    primaryUnit: '',
    secondary: 0,
    secondaryUnit: '',
    alert: false,
    alertCode: '',
    alertMessage: '',
    alertSeconds: 0,
    correctingT: 0,
  }));

  const sectorOnShift: Record<string, number> = {};
  let onShift = 0;
  let headcount = 0;
  for (const s of def.sectors) {
    const live = Math.round(s.headcount * s.shiftFactor);
    sectorOnShift[s.id] = live;
    onShift += live;
    headcount += s.headcount;
  }

  const seedUnits = 4200 + Math.floor(rng() * 2600);

  return {
    def,
    machines,
    operators,
    mob: buildMob(def),
    envNodes,
    physics: buildPhysics(def),
    weather: {
      tempC: def.climate.meanTempC,
      rh: def.climate.meanRh,
      cloud: 0.3 + rng() * 0.2,
      rainMmH: 0,
      windMs: 1.8 + rng() * 2,
      hour: 10.5,
      aqi: def.kind === 'printing' ? 88 : 64,
    },
    pillars: emptyPillars(),
    sectorOnShift,
    positions: new Float32Array(MAX_RENDERED_OPERATORS * 3),
    headings: new Float32Array(MAX_RENDERED_OPERATORS),
    states: new Uint8Array(MAX_RENDERED_OPERATORS),
    totals: {
      unitsBuilt: seedUnits,
      unitsDisplay: seedUnits,
      throughputPerHour: 318,
      oee: 0.871,
      yieldPct: 97.4,
      headcount,
      onShift,
      openAlerts: 0,
      actionableAlerts: 0,
      shiftSeconds: 4 * 3600 + 820,
    },
  };
}

function buildConvoys(): ConvoyRuntime[] {
  const out: ConvoyRuntime[] = [];

  // Inter-site corridor, both directions.
  const a = SITES[INTER_SITE_LANE.from];
  const b = SITES[INTER_SITE_LANE.to];
  out.push({
    id: 'inter-up',
    label: 'Tiruppur → Rajajinagar',
    fromLat: a.lat,
    fromLon: a.lon,
    toLat: b.lat,
    toLon: b.lon,
    kind: 'inter-site',
    progress: 0.22,
    unitsInTransit: 18400,
    etaMinutes: 0,
    speedKph: INTER_SITE_LANE.meanSpeedKph,
  });
  out.push({
    id: 'inter-down',
    label: 'Rajajinagar → Tiruppur',
    fromLat: b.lat,
    fromLon: b.lon,
    toLat: a.lat,
    toLon: a.lon,
    kind: 'inter-site',
    progress: 0.68,
    unitsInTransit: 12600,
    etaMinutes: 0,
    speedKph: INTER_SITE_LANE.meanSpeedKph,
  });

  // External lanes, alternating which node they serve.
  MACRO_NODES.forEach((n, i) => {
    const home = i % 2 === 0 ? a : b;
    const inbound = n.kind === 'supplier';
    out.push({
      id: `lane-${n.id}`,
      label: inbound ? `${n.label} → ${home.city.split(',')[0]}` : `${home.city.split(',')[0]} → ${n.label}`,
      fromLat: inbound ? n.lat : home.lat,
      fromLon: inbound ? n.lon : home.lon,
      toLat: inbound ? home.lat : n.lat,
      toLon: inbound ? home.lon : n.lon,
      kind: n.kind,
      progress: rng(),
      unitsInTransit: Math.floor(n.volume * (0.2 + rng() * 0.4)),
      etaMinutes: 60 + Math.floor(rng() * 900),
      speedKph: 38 + rng() * 26,
    });
  });

  return out;
}

const world: MegnetoWorld = {
  sites: {
    tiruppur: buildSite(SITES.tiruppur, 0),
    rajajinagar: buildSite(SITES.rajajinagar, 11),
  },
  convoys: buildConvoys(),
  alerts: [],
  lastFrameAt: 0,
  clock: 0,
  eventAccum: 0,
  paused: false,
  activeSite: 'tiruppur',
};

export const getWorld = (): MegnetoWorld => world;
export const getSite = (id: SiteId): SiteRuntime => world.sites[id];
export const getActiveSite = (): SiteRuntime => world.sites[world.activeSite];

/* -------------------------------------------------------------------------- */
/* Fault vocabulary                                                            */
/* -------------------------------------------------------------------------- */

const SELF_CLEARING_FAULTS: readonly { code: string; message: string; severity: 'warning' | 'critical' }[] =
  Object.freeze([
    { code: 'ACU-114', message: 'Bearing harmonic drift on main shaft', severity: 'warning' },
    { code: 'THR-206', message: 'Thermal envelope exceeded, derating feed', severity: 'warning' },
    { code: 'VIB-031', message: 'Vibration RMS above tolerance band', severity: 'warning' },
    { code: 'TOOL-12', message: 'Wear index past replacement threshold', severity: 'warning' },
    { code: 'PWR-009', message: 'Phase imbalance on supply rail', severity: 'critical' },
  ]);

/** Jams do not self-clear: the floor has to be dispatched. */
const JAM_FAULTS: Record<string, string> = {
  baleopener: 'Tuft blockage in the take-off duct',
  carding: 'Web break at the doffer — cylinder loaded',
  loom: 'Weft break at the right selvedge, pick aborted',
  flexo: 'Web wrap on the central impression drum',
  diecut: 'Blank wedged in the stripping station',
  pasting: 'Glue pot under temperature — spine starved',
  spinning: 'Sliver lap at drafting zone — roller wrap',
  knitting: 'Needle break detected, cylinder stopped',
  dyeing: 'Liquor circulation pump cavitating',
  stenter: 'Fabric selvedge off pin chain',
  cutting: 'Blade stall — multi-ply bind',
  stitching: 'Thread snap, looper timing drift',
  press: 'Web break at impression cylinder',
  prepress: 'Plate feed misregister',
  binding: 'Spine glue starvation — pot under temp',
  laminator: 'Film wrinkle at nip roller',
  guillotine: 'Clamp pressure fault, cut aborted',
  packing: 'Carton jam at erector',
};

let alertKey = 1;

function raiseAlert(
  site: SiteRuntime,
  nodeId: string,
  nodeName: string,
  pillar: Pillar,
  severity: 'warning' | 'critical',
  code: string,
  message: string,
  actionable: boolean,
) {
  world.alerts.unshift({
    key: alertKey++,
    siteId: site.def.id,
    nodeId,
    nodeName,
    pillar,
    severity,
    code,
    message,
    at: Date.now(),
    actionable,
    resolved: false,
  });
  if (world.alerts.length > 40) world.alerts.length = 40;
  bumpAlerts();
}

function bumpAlerts() {
  useMegnetoStore.setState((s) => ({ alertRevision: s.alertRevision + 1 }));
}

function pushAcoustic(m: MachineRuntime, value: number) {
  m.acousticHead = (m.acousticHead + 1) % m.acoustic.length;
  m.acoustic[m.acousticHead] = value;
}

export function readAcoustic(m: MachineRuntime, out: Float32Array): Float32Array {
  const n = m.acoustic.length;
  for (let i = 0; i < n; i++) out[i] = m.acoustic[(m.acousticHead + 1 + i) % n];
  return out;
}

/* ========================================================================== */
/* WEATHER                                                                    */
/* ========================================================================== */

/**
 * Outdoor conditions. One simulated minute per real second, so a demo shows a
 * visible diurnal swing in a couple of minutes on stage.
 */
const SIM_MINUTES_PER_SECOND = 1;

function stepWeather(site: SiteRuntime, dt: number) {
  const w = site.weather;
  const c = site.def.climate;

  // Clock. dt is real seconds; the simulated day runs faster.
  w.hour = (w.hour + (dt * SIM_MINUTES_PER_SECOND) / 60) % 24;

  // Ornstein-Uhlenbeck cloud index: dX = θ(μ − X)dt + σ√dt·N(0,1).
  // Mean-reverting, so weather drifts and recovers instead of wandering off.
  const theta = 0.015;
  const mu = 0.34 + c.monsoonBias;
  const sigma = 0.09;
  w.cloud = clamp(w.cloud + theta * (mu - w.cloud) * dt + sigma * Math.sqrt(dt) * gauss(), 0, 1);

  // Rain switches on above a cloud threshold and scales super-linearly.
  w.rainMmH = w.cloud > 0.62 ? Math.pow((w.cloud - 0.62) / 0.38, 1.8) * 14 : 0;

  // Diurnal temperature: minimum near 05:00, maximum near 15:00.
  const solar = -Math.cos((2 * Math.PI * (w.hour - 5)) / 24);
  const clearSkyTemp = c.meanTempC + (c.diurnalSwingC / 2) * solar;
  // Cloud cover damps the swing; rain pulls toward wet-bulb.
  const cloudDamp = 1 - 0.45 * w.cloud;
  const rainCooling = Math.min(4.5, w.rainMmH * 0.42);
  w.tempC = lerp(
    w.tempC,
    c.meanTempC + (clearSkyTemp - c.meanTempC) * cloudDamp - rainCooling,
    1 - Math.exp(-dt / 90),
  );

  // Humidity runs opposite temperature, with cloud and rain adding moisture.
  const rhTarget = clamp(c.meanRh - 14 * solar + 22 * w.cloud + Math.min(18, w.rainMmH * 2.2), 18, 99);
  w.rh = lerp(w.rh, rhTarget, 1 - Math.exp(-dt / 70));

  w.windMs = clamp(w.windMs + 0.08 * (2.4 + 3 * w.cloud - w.windMs) * dt + 0.2 * Math.sqrt(dt) * gauss(), 0.2, 12);

  // Rain scavenges particulate; still air lets it build.
  const aqiTarget =
    (site.def.kind === 'printing' ? 96 : 70) - w.rainMmH * 3.4 - w.windMs * 2.1 + (1 - w.cloud) * 8;
  w.aqi = clamp(lerp(w.aqi, aqiTarget, 1 - Math.exp(-dt / 120)), 18, 240);
}

/* ========================================================================== */
/* TEXTILE PHYSICS — Tiruppur                                                 */
/* ========================================================================== */

/** Comfort / quality band for cotton processing. Outside it, yarn misbehaves. */
const RH_BAND = { lo: 55, hi: 70, hardLo: 48, hardHi: 78 };

function stepTextile(site: SiteRuntime, dt: number) {
  const p = site.physics as TextilePhysics;
  const w = site.weather;
  const def = site.def;

  const floorArea = def.shell.width * def.shell.depth;
  const volume = floorArea * def.shell.floorHeight * 3; // m³ of air, all three storeys

  /* ---- 1. Dye vat thermal masses -------------------------------------- */
  // Lumped capacitance: m·c·dT/dt = η·P_steam − UA·(T − T_room)
  let vatSteamKw = 0;
  let vatEvapGs = 0;
  for (const vat of p.vats) {
    const machine = site.machines.find((m) => m.def.id === vat.id);
    const running = machine ? !machine.jammed && machine.status !== 'idle' : true;
    vat.setpointC = machine ? machine.def.nominalTempC : vat.setpointC;

    // Proportional controller on the steam valve, 4 °C proportional band.
    const error = vat.setpointC - vat.tempC;
    const maxKw = 180;
    vat.steamKw = running ? clamp((error / 4) * maxKw, 0, maxKw) : 0;

    const UA = 2400; // W/K — lagged vessel, but a big one
    const massKg = vat.massKg;
    const cp = 4186; // J/(kg·K)
    const efficiency = 0.92;

    const qIn = vat.steamKw * 1000 * efficiency;
    const qLoss = UA * (vat.tempC - p.indoorTempC);
    vat.tempC += ((qIn - qLoss) / (massKg * cp)) * dt;
    vat.tempC = clamp(vat.tempC, 15, 135);

    vatSteamKw += vat.steamKw;

    // Evaporation from an open hot liquor surface. Rough but physical: scales
    // with the vapour-pressure difference between liquor surface and room air.
    const esSurface = saturationVapourPressure(vat.tempC);
    const esRoom = saturationVapourPressure(p.indoorTempC) * (p.rh / 100);
    const surfaceArea = 3.1; // m² of open vessel
    // Evaporation coefficient for a still-ish indoor surface, g/(s·m²·hPa).
    vatEvapGs += Math.max(0, (esSurface - esRoom)) * surfaceArea * 0.0062;
  }

  /* ---- 2. Stenter drying releases the water it pulls out of the cloth --- */
  const stenter = site.machines.find((m) => m.def.kind === 'stenter');
  // A stenter evaporates roughly 0.55 kg of water per kg of fabric dried.
  const stenterEvapGs = stenter && !stenter.jammed ? stenter.load * 92 : 0;

  p.processMoistureGs = vatEvapGs + stenterEvapGs;

  /* ---- 3. Indoor moisture balance -------------------------------------- */
  // Integrated in ABSOLUTE humidity, because %RH is not conserved — it moves
  // when temperature moves even with no water added or removed.
  //
  //   dAH/dt = (S_total / V) − (ACH/3600)·(AH_in − AH_out)
  //
  const ahOutdoor = absoluteHumidity(w.tempC, w.rh);

  // Indoor dry-bulb: machine heat against ventilation and the outdoor air.
  const machineHeatKw = site.machines.reduce((s, m) => s + m.kw * 0.22, 0);
  const ventilationWk = (p.ventilationAch / 3600) * volume * 1.2 * 1005; // W/K
  const indoorTarget = w.tempC + (machineHeatKw * 1000) / Math.max(1, ventilationWk);
  p.indoorTempC = lerp(p.indoorTempC, indoorTarget, 1 - Math.exp(-dt / 180));

  // Humidification plant: proportional control toward the setpoint, and it can
  // only add moisture — drying is done by pulling in outside air.
  const rhError = p.rhSetpoint - p.rh;
  p.humidifierDuty = clamp(lerp(p.humidifierDuty, clamp(rhError / 8, 0, 1), 1 - Math.exp(-dt / 25)), 0, 1);
  const humidifierMaxGs = 620; // g/s at full duty — an industrial fogging system
  p.humidifierGs = p.humidifierDuty * humidifierMaxGs;

  // If the room is above setpoint, the operator opens up: ventilation rises.
  const ventTarget = rhError < -3 ? 9.5 : 4.2;
  p.ventilationAch = lerp(p.ventilationAch, ventTarget, 1 - Math.exp(-dt / 60));

  // Dehumidification. Ventilation alone cannot rescue a saturated shed in any
  // useful time — at 10 ACH the exchange term has a time constant of several
  // minutes — so the conditioning plant has a refrigerant dehumidifier, which
  // is what a real mill reaches for. It winds down once back inside the band.
  const needDehumid = p.rh > p.rhSetpoint + 2;
  p.dehumidDuty = clamp(
    lerp(p.dehumidDuty, needDehumid ? Math.min(1, (p.rh - p.rhSetpoint) / 10) : 0, 1 - Math.exp(-dt / 12)),
    0,
    1,
  );
  const dehumidMaxGs = 900; // g/s at full duty ≈ 3.2 t/h of condensate
  p.dehumidGs = p.dehumidDuty * dehumidMaxGs;

  const source = p.humidifierGs + p.processMoistureGs;
  const exchange = (p.ventilationAch / 3600) * (p.ah - ahOutdoor);
  p.ah = Math.max(0.5, p.ah + ((source - p.dehumidGs) / volume - exchange) * dt);

  p.rh = relativeHumidity(p.ah, p.indoorTempC);
  p.dewPointC = dewPoint(p.indoorTempC, p.rh);

  // WBGT indoors, no solar load: 0.7·Tnwb + 0.3·Tg. Approximate the natural
  // wet bulb from dew point and dry bulb, and the globe temp from dry bulb plus
  // radiant gain from the hot vats.
  const tnwb = p.dewPointC + 0.33 * (p.indoorTempC - p.dewPointC);
  const radiantGain = vatSteamKw > 0 ? 2.4 : 0.8;
  p.wbgt = 0.7 * tnwb + 0.3 * (p.indoorTempC + radiantGain);

  /* ---- 4. ZLD train ---------------------------------------------------- */
  // Dye house effluent scales with how much dyeing is actually running.
  const dyeLoad = site.machines
    .filter((m) => m.def.kind === 'dyeing' || m.def.kind === 'stenter')
    .reduce((s, m) => s + m.load, 0);

  const z = p.zld;
  z.feedM3h = lerp(z.feedM3h, 18 + dyeLoad * 14, 1 - Math.exp(-dt / 45));
  z.tdsFeedMgL = lerp(z.tdsFeedMgL, 4200 + dyeLoad * 900, 1 - Math.exp(-dt / 90));

  // RO: recovery drops as feed TDS rises (osmotic pressure works against you).
  const recoveryCeiling = clamp(0.82 - (z.tdsFeedMgL - 4000) / 42000, 0.5, 0.82);
  z.roRecovery = lerp(z.roRecovery, recoveryCeiling, 1 - Math.exp(-dt / 70));

  // Flow balance.
  z.permeateM3h = z.feedM3h * z.roRecovery;
  z.rejectM3h = z.feedM3h - z.permeateM3h;

  // Salt balance. Rejection ~98.5%, so permeate carries 1.5% of feed TDS, and
  // every gram that does not leave in the permeate leaves in the concentrate.
  const saltRejection = 0.985;
  z.permeateTdsMgL = z.tdsFeedMgL * (1 - saltRejection);
  const saltInKgH = (z.feedM3h * z.tdsFeedMgL) / 1000;
  const saltPermeateKgH = (z.permeateM3h * z.permeateTdsMgL) / 1000;
  z.rejectTdsMgL = z.rejectM3h > 0.01 ? ((saltInKgH - saltPermeateKgH) * 1000) / z.rejectM3h : 0;

  // Multi-effect evaporator takes the concentrate to near-dryness.
  z.meeEvapM3h = z.rejectM3h * 0.94;
  z.saltKgH = saltInKgH - saltPermeateKgH;

  // Steam demand: a 4-effect train evaporates ~4 kg water per kg of steam.
  // 1 kg steam ≈ 2200 kJ, so kW = kg/h × 2200 / 3600.
  const steamKgH = (z.meeEvapM3h * 1000) / 4;
  z.steamKw = (steamKgH * 2200) / 3600;

  z.recoveryPct = z.feedM3h > 0.01 ? ((z.permeateM3h + z.meeEvapM3h) / z.feedM3h) * 100 : 0;

  /* ---- 5. Environmental node readouts and alerts ------------------------ */
  for (const node of site.envNodes) {
    switch (node.def.kind) {
      case 'humidity': {
        node.primary = p.rh;
        node.primaryUnit = '%RH';
        node.secondary = p.indoorTempC;
        node.secondaryUnit = '°C';
        const out = p.rh < RH_BAND.hardLo || p.rh > RH_BAND.hardHi;
        const edge = p.rh < RH_BAND.lo || p.rh > RH_BAND.hi;
        node.status = node.correctingT > 0 ? 'warning' : out ? 'critical' : edge ? 'warning' : 'nominal';
        if (out && !node.alert && node.correctingT <= 0) {
          node.alert = true;
          node.alertSeconds = 0;
          node.alertCode = p.rh < RH_BAND.hardLo ? 'RH-LOW' : 'RH-HIGH';
          node.alertMessage =
            p.rh < RH_BAND.hardLo
              ? `Cotton conditioning lost at ${p.rh.toFixed(1)} %RH — static and end-down risk`
              : `Humidity ${p.rh.toFixed(1)} %RH — mildew and dye-fixation risk`;
          raiseAlert(site, node.def.id, node.def.name, 'environment', 'critical', node.alertCode, node.alertMessage, true);
        }
        break;
      }
      case 'dyevat': {
        const hottest = p.vats.reduce((a, b) => (a.tempC > b.tempC ? a : b), p.vats[0]);
        node.primary = hottest ? hottest.tempC : 0;
        node.primaryUnit = '°C';
        node.secondary = vatSteamKw;
        node.secondaryUnit = 'kW';
        const dev = hottest ? Math.abs(hottest.tempC - hottest.setpointC) : 0;
        node.status = dev > 12 ? 'critical' : dev > 6 ? 'warning' : 'nominal';
        break;
      }
      case 'zld': {
        if (node.def.id === 'ZLD-RO') {
          node.primary = z.roRecovery * 100;
          node.primaryUnit = '% rec';
          node.secondary = z.permeateM3h;
          node.secondaryUnit = 'm³/h';
          node.status = z.roRecovery < 0.6 ? 'warning' : 'nominal';
        } else {
          node.primary = z.meeEvapM3h;
          node.primaryUnit = 'm³/h';
          node.secondary = z.saltKgH;
          node.secondaryUnit = 'kg/h';
          node.status = z.rejectTdsMgL > 48000 ? 'warning' : 'nominal';
        }
        break;
      }
      default:
        break;
    }
    if (node.alert) node.alertSeconds += dt;
    if (node.correctingT > 0) node.correctingT = Math.max(0, node.correctingT - dt);
  }
}

/* ========================================================================== */
/* PRINTING PHYSICS — Rajajinagar                                             */
/* ========================================================================== */

const VOC_LIMIT_PPM = 50; // 8-hour occupational exposure band
const DUST_LIMIT_UGM3 = 150;

function stepPrinting(site: SiteRuntime, dt: number) {
  const p = site.physics as PrintingPhysics;
  const w = site.weather;
  const def = site.def;

  const floorArea = def.shell.width * def.shell.depth;
  const volume = floorArea * def.shell.floorHeight * 3;

  /* ---- 1. Solvent evaporation from ink laydown -------------------------- */
  // Impressions per second across the presses, times ink per impression, times
  // the solvent fraction that actually flashes off.
  let impressionsPerSec = 0;
  for (const m of site.machines) {
    if (m.def.kind !== 'press' || m.jammed) continue;
    impressionsPerSec += (m.def.yieldPerCycle / m.def.cycleSeconds) * m.load;
  }
  const inkMgPerImpression = 46;
  const solventFraction = 0.28;
  const flashFraction = 0.72;
  p.vocSourceMgS = impressionsPerSec * inkMgPerImpression * solventFraction * flashFraction;

  /* ---- 2. Well-mixed box model for VOC ---------------------------------- */
  //   dC/dt = S/V − (ACH/3600 + η·D·ACH_scrub/3600)·C
  // The scrubber is a recirculating carbon bed: it removes a fraction η of the
  // air it handles, which is why duty and efficiency multiply.
  // Emergency purge: roof extract wide open and doors cracked. It is a real
  // thing a print hall does, and it is the difference between a concentration
  // that decays in ninety seconds and one that decays in six minutes.
  if (p.purgeT > 0) p.purgeT = Math.max(0, p.purgeT - dt);
  const purgeFactor = p.purgeT > 0 ? 4 : 1;
  const scrubberAch = p.extractionAch * p.scrubberDuty;
  const removalRate =
    (w.windMs * 0.00012 + 1.8 / 3600 + (scrubberAch * p.scrubberEfficiency) / 3600) * purgeFactor;
  p.vocMgM3 = Math.max(0, p.vocMgM3 + (p.vocSourceMgS / volume - removalRate * p.vocMgM3) * dt);
  p.vocPpm = mgm3ToPpm(p.vocMgM3, SOLVENT_MOLAR_MASS);

  /* ---- 3. Paper dust, same model plus gravitational settling ------------ */
  let dustSource = 0;
  for (const m of site.machines) {
    if (m.jammed) continue;
    if (m.def.kind === 'guillotine') dustSource += m.load * 2100;
    else if (m.def.kind === 'binding') dustSource += m.load * 860;
    else if (m.def.kind === 'press') dustSource += m.load * 320;
  }
  p.dustSourceUgS = dustSource;

  // Settling adds a loss term of v_s·A_floor/V, which for a 5.2 m ceiling is
  // about 0.0008 s⁻¹ — small, but it is why dust decays without extraction.
  const settlingLoss = (p.settlingMs * floorArea) / volume;
  const dustRemoval = (p.extractionAch / 3600 + settlingLoss + (scrubberAch * 0.94) / 3600) * purgeFactor;
  p.dustUgM3 = Math.max(0, p.dustUgM3 + (p.dustSourceUgS / volume - dustRemoval * p.dustUgM3) * dt);

  /* ---- 4. Indoor temperature -------------------------------------------- */
  const machineHeatKw = site.machines.reduce((s, m) => s + m.kw * 0.28, 0);
  const ventilationWk = (p.extractionAch / 3600) * volume * 1.2 * 1005;
  const indoorTarget = w.tempC + (machineHeatKw * 1000) / Math.max(1, ventilationWk);
  p.indoorTempC = lerp(p.indoorTempC, indoorTarget, 1 - Math.exp(-dt / 150));
  p.rh = lerp(p.rh, clamp(w.rh - 10 + w.rainMmH, 25, 85), 1 - Math.exp(-dt / 120));

  /* ---- 5. Grid demand ---------------------------------------------------- */
  const g = p.grid;
  g.processKw = site.machines.reduce((s, m) => s + m.kw, 0);

  // HVAC: sensible cooling above a 24 °C setpoint, plus the extraction fans.
  const coolingDelta = Math.max(0, p.indoorTempC - 24);
  const fanKw = p.extractionAch * 3.4 + p.scrubberDuty * 18;
  g.hvacKw = coolingDelta * 11.5 + fanKw;
  g.totalKw = g.processKw + g.hvacKw;

  // Power factor sags as inductive (motor) load climbs relative to total.
  const motorShare = clamp(g.processKw / Math.max(1, g.totalKw), 0, 1);
  g.powerFactor = clamp(lerp(g.powerFactor, 0.97 - motorShare * 0.14, 1 - Math.exp(-dt / 40)), 0.72, 0.99);

  g.kva = g.totalKw / g.powerFactor;
  g.peakKva = Math.max(g.peakKva, g.kva);
  g.dailyKwh += (g.totalKw * dt) / 3600;
  g.contractUsePct = (g.kva / def.contractKva) * 100;

  /* ---- 6. Node readouts and alerts -------------------------------------- */
  for (const node of site.envNodes) {
    switch (node.def.kind) {
      case 'voc': {
        node.primary = p.vocPpm;
        node.primaryUnit = 'ppm';
        node.secondary = p.scrubberDuty * 100;
        node.secondaryUnit = '% duty';
        node.status = p.vocPpm > VOC_LIMIT_PPM ? 'critical' : p.vocPpm > VOC_LIMIT_PPM * 0.75 ? 'warning' : 'nominal';
        if (p.vocPpm > VOC_LIMIT_PPM && !node.alert && node.correctingT <= 0) {
          node.alert = true;
          node.alertSeconds = 0;
          node.alertCode = 'VOC-HIGH';
          node.alertMessage = `Press-hall solvent at ${p.vocPpm.toFixed(1)} ppm — above the 50 ppm exposure band`;
          raiseAlert(site, node.def.id, node.def.name, 'environment', 'critical', node.alertCode, node.alertMessage, true);
        }
        break;
      }
      case 'dust': {
        node.primary = p.dustUgM3;
        node.primaryUnit = 'µg/m³';
        node.secondary = p.extractionAch;
        node.secondaryUnit = 'ACH';
        node.status =
          p.dustUgM3 > DUST_LIMIT_UGM3 ? 'critical' : p.dustUgM3 > DUST_LIMIT_UGM3 * 0.7 ? 'warning' : 'nominal';
        if (p.dustUgM3 > DUST_LIMIT_UGM3 && !node.alert && node.correctingT <= 0) {
          node.alert = true;
          node.alertSeconds = 0;
          node.alertCode = 'PM-HIGH';
          node.alertMessage = `Paper dust at ${p.dustUgM3.toFixed(0)} µg/m³ — extraction cannot keep up`;
          raiseAlert(site, node.def.id, node.def.name, 'environment', 'warning', node.alertCode, node.alertMessage, true);
        }
        break;
      }
      case 'power': {
        node.primary = g.kva;
        node.primaryUnit = 'kVA';
        node.secondary = g.powerFactor;
        node.secondaryUnit = 'pf';
        node.status =
          g.contractUsePct > 98 ? 'critical' : g.contractUsePct > 88 || g.powerFactor < 0.85 ? 'warning' : 'nominal';
        if (g.contractUsePct > 98 && !node.alert && node.correctingT <= 0) {
          node.alert = true;
          node.alertSeconds = 0;
          node.alertCode = 'KVA-PEAK';
          node.alertMessage = `Demand at ${g.kva.toFixed(0)} kVA against a ${def.contractKva} kVA contract — penalty band`;
          raiseAlert(site, node.def.id, node.def.name, 'utility', 'critical', node.alertCode, node.alertMessage, true);
        }
        break;
      }
      default:
        break;
    }
    if (node.alert) node.alertSeconds += dt;
    if (node.correctingT > 0) node.correctingT = Math.max(0, node.correctingT - dt);
  }
}

/* ========================================================================== */
/* MACHINES, OPERATORS, PILLARS                                               */
/* ========================================================================== */

function stepMachines(site: SiteRuntime, dt: number) {
  const p = site.physics;

  for (const m of site.machines) {
    const d = m.def;

    /* --- jams: persistent until a human clears them --- */
    if (m.jammed) {
      m.jamSeconds += dt;
      m.status = 'jammed';
      m.load = lerp(m.load, 0.02, 0.3);
      m.kw = d.ratedKw * 0.06;
      m.rpm = Math.round(lerp(m.rpm, 0, 0.3));
      // The physical motion stops. Because output is derived from motion and
      // nothing else, output stops in the same instant — no separate "stop
      // producing" flag exists to get out of sync with the animation.
      m.strokeHz = 0;
      pushAcoustic(m, clamp(d.nominalDb * 0.35 + (rng() - 0.5) * 2, 10, 118));
      continue;
    }

    /* --- self-clearing faults --- */
    if (m.faultT > 0) {
      m.faultT -= dt;
      if (m.faultT <= 0) {
        m.faultT = 0;
        m.faultCode = '';
        m.status = 'nominal';
        bumpAlerts();
      }
    } else if (rng() < 0.0025 * dt) {
      // 0.25% per machine-second. Across a dozen machines that is an event
      // roughly every half-minute and a jam every two or three minutes —
      // frequent enough to demo, rare enough that the floor is not a wreck.
      if (rng() < 0.22) {
        // A jam. Needs the user to click the machine in 3D.
        m.jammed = true;
        m.jamSeconds = 0;
        m.status = 'jammed';
        m.faultCode = 'JAM-' + d.id;
        raiseAlert(
          site,
          d.id,
          d.name,
          'machinery',
          'critical',
          'JAM',
          JAM_FAULTS[d.kind] ?? 'Mechanical jam — line stopped',
          true,
        );
        continue;
      }
      const f = SELF_CLEARING_FAULTS[Math.floor(rng() * SELF_CLEARING_FAULTS.length)];
      m.faultT = 12 + rng() * 26;
      m.faultCode = f.code;
      m.status = f.severity === 'critical' ? 'critical' : 'warning';
      raiseAlert(site, d.id, d.name, 'machinery', f.severity, f.code, f.message, false);
    }

    const faulted = m.status === 'warning' || m.status === 'critical';

    /* --- environmental derating: this is the link that makes the engine real --- */
    let envDerate = 1;
    if (p.kind === 'textile') {
      // Outside the humidity band, yarn breaks and the line slows down.
      if (p.rh < RH_BAND.lo) envDerate -= (RH_BAND.lo - p.rh) * 0.012;
      if (p.rh > RH_BAND.hi) envDerate -= (p.rh - RH_BAND.hi) * 0.009;
      // Heat stress slows people, and people feed machines.
      if (p.wbgt > 28) envDerate -= (p.wbgt - 28) * 0.02;
    } else {
      // Solvent above the band forces the hall onto reduced press speed.
      if (p.vocPpm > VOC_LIMIT_PPM * 0.8) envDerate -= (p.vocPpm - VOC_LIMIT_PPM * 0.8) * 0.006;
      if (p.dustUgM3 > DUST_LIMIT_UGM3 * 0.8) envDerate -= (p.dustUgM3 - DUST_LIMIT_UGM3 * 0.8) * 0.0012;
    }
    envDerate = clamp(envDerate, 0.35, 1);

    const targetLoad = (m.status === 'critical' ? 0.14 : faulted ? 0.5 : 0.74 + rng() * 0.24) * envDerate;
    m.load = lerp(m.load, targetLoad, 1 - Math.exp(-dt / 4));
    m.kw = d.ratedKw * (0.12 + m.load * 0.88);

    /* --- stroke rate -------------------------------------------------------
     * Production itself is NOT computed here. This only sets how fast the
     * machine is physically moving; `stepKinematics`, which runs per frame,
     * turns that motion into product. A machine with strokeHz 0 produces
     * nothing, by construction rather than by a check.
     * --------------------------------------------------------------------- */
    m.strokeHz = m.status === 'critical' ? 0 : KINEMATICS[d.kind].hz * m.load;

    // Queue flow still tracks demand, independent of whether the machine is
    // keeping up — that gap is what makes a jam show as a backlog.
    if (rng() < 0.55 * dt) m.queue += 1 + Math.floor(rng() * 2);

    /* --- thermal, acoustic, vibration --- */
    const targetTemp = d.nominalTempC * (0.45 + m.load * 0.55) + (faulted ? 9 : 0);
    m.tempC = lerp(m.tempC, targetTemp, 1 - Math.exp(-dt / 12)) + (rng() - 0.5) * 0.3;

    const targetDb =
      d.nominalDb * (0.7 + m.load * 0.34) + (faulted ? 7.5 : 0) + Math.sin(world.clock * 0.9 + d.id.length) * 1.3;
    m.db = lerp(m.db, targetDb, 1 - Math.exp(-dt / 3)) + (rng() - 0.5) * 1.0;
    pushAcoustic(m, clamp(m.db + (rng() - 0.5) * 2.4, 12, 118));

    m.rpm = Math.round(lerp(m.rpm, d.nominalRpm * (0.8 + m.load * 0.25), 1 - Math.exp(-dt / 5)));
    m.vibration = clamp(lerp(m.vibration, 0.3 + m.load * 0.7 + (faulted ? 0.9 : 0), 1 - Math.exp(-dt / 6)), 0, 3);
    m.uptimePct = clamp(m.uptimePct + (faulted ? -0.035 : 0.012) * dt, 86, 99.9);
  }
}

function stepOperators(site: SiteRuntime, dt: number) {
  const p = site.physics;

  // Environmental strain: WBGT for the mill, solvent for the press hall.
  const strainTarget =
    p.kind === 'textile'
      ? clamp((p.wbgt - 24) / 12, 0, 1)
      : clamp(p.vocPpm / (VOC_LIMIT_PPM * 1.4), 0, 1) * 0.7 + clamp((p.indoorTempC - 26) / 10, 0, 1) * 0.3;

  for (const op of site.operators) {
    const machine = site.machines.find((m) => m.def.id === op.stationId);
    const blocked = machine ? machine.jammed || machine.status === 'critical' : false;

    op.strain = lerp(op.strain, strainTarget, 1 - Math.exp(-dt / 30));

    if (op.state === 1 && !blocked) {
      // Output falls off as strain rises — the environment reaches the people
      // before it reaches the numbers.
      const rate = (0.34 * op.efficiency + 0.08) * (1 - op.strain * 0.45);
      if (rng() < rate * dt) {
        op.units += 1 + (rng() < 0.18 ? 1 : 0);
      }
    }

    op.efficiency = clamp(
      op.efficiency + ((blocked ? -0.004 : 0.0018) + (rng() - 0.5) * 0.006) * dt,
      0.52,
      0.99,
    );
    op.gaitConfidence = clamp(op.gaitConfidence + (rng() - 0.5) * 0.004 * dt, 0.86, 0.995);
    op.heartRate = Math.round(
      clamp(
        lerp(op.heartRate, (op.state === 0 ? 96 : 78) + op.strain * 26, 1 - Math.exp(-dt / 8)) +
          (rng() - 0.5) * 2.4,
        62,
        148,
      ),
    );
    op.speed = lerp(op.speed, op.baseSpeed * (blocked ? 1.25 : 1) * (1 - op.strain * 0.25), 1 - Math.exp(-dt / 5));

    // Heat and solvent both drive more breaks. That is the mechanism by which
    // an environmental excursion becomes a labour-availability problem.
    if (op.state !== 2 && rng() < (0.002 + op.strain * 0.01) * dt) {
      op.state = 2;
      op.dwell = 6 + rng() * 10 + op.strain * 14;
    }
  }
}

/**
 * Keeps three thousand people's telemetry alive without touching three
 * thousand people per tick.
 *
 * A rolling window of 320 is refreshed each second, so everyone updates about
 * every six seconds — fast enough that no two glances at the same worker show
 * identical numbers, cheap enough to disappear into the frame budget. Whoever
 * is currently selected is refreshed every tick regardless, because a card
 * that is open in front of an investor has to be live.
 */
function stepMob(site: SiteRuntime, dt: number) {
  const mob = site.mob;
  if (mob.count === 0) return;

  const p = site.physics;
  const ambientStrain =
    p.kind === 'textile'
      ? clamp((p.wbgt - 24) / 12, 0, 1)
      : clamp(p.vocPpm / (VOC_LIMIT_PPM * 1.4), 0, 1) * 0.7 + clamp((p.indoorTempC - 26) / 10, 0, 1) * 0.3;

  const WINDOW = 320;
  const selected = useMegnetoStore.getState().selectedWorkerIndex;

  const refresh = (i: number) => {
    // Strain follows the room; output follows efficiency and strain.
    mob.strain[i] = clamp(lerp(mob.strain[i], ambientStrain + (rng() - 0.5) * 0.08, 0.25), 0, 1);
    mob.efficiency[i] = clamp(mob.efficiency[i] + (rng() - 0.5) * 0.012 - mob.strain[i] * 0.002, 0.45, 0.99);
    mob.cadence[i] = clamp(
      lerp(mob.cadence[i], 6 + mob.efficiency[i] * 30 * (1 - mob.strain[i] * 0.45), 0.3),
      1,
      60,
    );
    mob.heartRate[i] = Math.round(clamp(72 + mob.strain[i] * 46 + (rng() - 0.5) * 6, 58, 165));
    mob.gait[i] = clamp(mob.gait[i] + (rng() - 0.5) * 0.004, 0.84, 0.998);
    // Output accrues at the person's own cadence.
    const gained = (mob.cadence[i] / 3600) * dt * WINDOW;
    if (mob.units[i] < 65000) mob.units[i] = Math.min(65000, mob.units[i] + (rng() < gained ? 1 : 0));
  };

  let c = mob.refreshCursor;
  for (let n = 0; n < WINDOW; n++) {
    refresh(c);
    c = (c + 1) % mob.count;
  }
  mob.refreshCursor = c;

  if (selected !== null && selected >= 0 && selected < mob.count) refresh(selected);
}

function stepPillars(site: SiteRuntime, dt: number) {
  const p = site.physics;
  const t = site.totals;
  const def = site.def;

  let running = 0;
  let jammed = 0;
  let loadSum = 0;
  let rejects = 0;
  let produced = 0;
  let queue = 0;
  let kw = 0;
  for (const m of site.machines) {
    if (m.jammed) jammed += 1;
    else if (m.status !== 'idle') running += 1;
    loadSum += m.load;
    rejects += m.rejects;
    produced += m.jobsDone * m.def.yieldPerCycle;
    queue += m.queue;
    kw += m.kw;
  }

  const utilisation = loadSum / site.machines.length;
  const openAlerts = world.alerts.filter((a) => a.siteId === def.id && !a.resolved).length;
  const actionable = world.alerts.filter((a) => a.siteId === def.id && !a.resolved && a.actionable).length;

  t.shiftSeconds += dt;
  t.openAlerts = openAlerts;
  t.actionableAlerts = actionable;
  t.yieldPct = produced > 0 ? clamp(100 - (rejects / produced) * 100, 80, 100) : 100;
  t.oee = clamp(
    lerp(t.oee, (running / site.machines.length) * utilisation * (t.yieldPct / 100), 1 - Math.exp(-dt / 25)),
    0.2,
    0.99,
  );
  t.throughputPerHour = lerp(
    t.throughputPerHour,
    site.machines.reduce((s, m) => s + (m.jammed ? 0 : (m.def.yieldPerCycle / m.def.cycleSeconds) * m.load * 3600), 0),
    1 - Math.exp(-dt / 20),
  );

  // On-shift headcount drifts with strain (breaks) and with jams (reassignment).
  let onShift = 0;
  for (const s of def.sectors) {
    const base = s.headcount * s.shiftFactor;
    const strainPenalty = p.kind === 'textile' ? clamp((p.wbgt - 28) / 14, 0, 0.18) : clamp(p.vocPpm / 180, 0, 0.14);
    const live = Math.round(base * (1 - strainPenalty));
    site.sectorOnShift[s.id] = live;
    onShift += live;
  }
  t.onShift = onShift;

  const P = site.pillars;

  P.mob.value = onShift;
  P.mob.unit = 'on shift';
  P.mob.caption = `${t.headcount} enrolled · ${def.sectors.length} sectors`;
  P.mob.health = clamp(onShift / (t.headcount * 0.82), 0, 1);

  P.inventory.value = queue;
  P.inventory.unit = 'WIP lots';
  P.inventory.caption = `${(queue * 0.42).toFixed(1)} t staged · ${Math.round(queue / Math.max(1, site.machines.length))} per cell`;
  P.inventory.health = clamp(1 - Math.abs(queue - 60) / 120, 0, 1);

  P.product.value = t.unitsBuilt;
  P.product.unit = def.productUnit;
  P.product.caption = `${Math.round(t.throughputPerHour)} ${def.productUnit}/h · ${def.productName}`;
  P.product.health = clamp(t.throughputPerHour / 3600, 0, 1);

  P.machinery.value = running;
  P.machinery.unit = `/ ${site.machines.length} running`;
  P.machinery.caption = jammed > 0 ? `${jammed} jammed — dispatch required` : `${(utilisation * 100).toFixed(0)}% mean load`;
  P.machinery.health = clamp((running - jammed * 1.5) / site.machines.length, 0, 1);

  P.qa.value = t.yieldPct;
  P.qa.unit = '% first-pass';
  P.qa.caption = `${rejects} rejected this shift`;
  P.qa.health = clamp((t.yieldPct - 88) / 11, 0, 1);

  const siteConvoys = world.convoys.filter(
    (c) =>
      (c.kind === 'inter-site' && (c.id === 'inter-up' || c.id === 'inter-down')) ||
      true,
  );
  const inTransit = siteConvoys.reduce((s, c) => s + c.unitsInTransit, 0);
  P.logistics.value = inTransit;
  P.logistics.unit = 'in transit';
  P.logistics.caption = `${world.convoys.length} active lanes · corridor ${INTER_SITE_LANE.distanceKm} km`;
  P.logistics.health = clamp(1 - world.convoys.filter((c) => c.etaMinutes > 600).length / world.convoys.length, 0, 1);

  if (p.kind === 'textile') {
    P.utility.value = kw + p.zld.steamKw;
    P.utility.unit = 'kW';
    P.utility.caption = `${p.zld.steamKw.toFixed(0)} kW steam to ZLD · ${p.zld.feedM3h.toFixed(1)} m³/h effluent`;
    P.utility.health = clamp(1 - (kw + p.zld.steamKw) / (def.contractKva * 0.9), 0, 1);

    P.environment.value = p.rh;
    P.environment.unit = '%RH';
    P.environment.caption = `${p.indoorTempC.toFixed(1)} °C · WBGT ${p.wbgt.toFixed(1)} · ZLD ${p.zld.recoveryPct.toFixed(1)}%`;
    const band = p.rh < RH_BAND.lo ? (p.rh - RH_BAND.hardLo) / (RH_BAND.lo - RH_BAND.hardLo) : p.rh > RH_BAND.hi ? (RH_BAND.hardHi - p.rh) / (RH_BAND.hardHi - RH_BAND.hi) : 1;
    P.environment.health = clamp(band, 0, 1);
  } else {
    P.utility.value = p.grid.kva;
    P.utility.unit = 'kVA';
    P.utility.caption = `pf ${p.grid.powerFactor.toFixed(2)} · peak ${p.grid.peakKva.toFixed(0)} / ${def.contractKva} kVA`;
    P.utility.health = clamp(1 - p.grid.contractUsePct / 100, 0, 1);

    P.environment.value = p.vocPpm;
    P.environment.unit = 'ppm VOC';
    P.environment.caption = `PM ${p.dustUgM3.toFixed(0)} µg/m³ · ${p.indoorTempC.toFixed(1)} °C · AQI ${site.weather.aqi.toFixed(0)}`;
    P.environment.health = clamp(1 - p.vocPpm / (VOC_LIMIT_PPM * 1.5), 0, 1);
  }

  // Trends, computed from the eased display value before it catches up.
  for (const key of PILLARS) {
    const metric = P[key];
    metric.trend = clamp((metric.value - metric.display) / (Math.abs(metric.value) + 1), -1, 1);
  }
}

function stepConvoys(site: SiteRuntime, dt: number) {
  void site;
  for (const c of world.convoys) {
    // Traffic noise on the corridor speed, then progress along the lane.
    c.speedKph = clamp(c.speedKph + (rng() - 0.5) * 2.4 * dt, 18, 86);
    const laneKm = c.kind === 'inter-site' ? INTER_SITE_LANE.distanceKm : 900;
    // Simulated minutes per real second, so convoys visibly move on stage.
    c.progress += ((c.speedKph / laneKm) * (dt * SIM_MINUTES_PER_SECOND)) / 60;
    if (c.progress >= 1) {
      c.progress -= 1;
      c.unitsInTransit = Math.max(400, Math.round(c.unitsInTransit * (0.75 + rng() * 0.5)));
    }
    c.etaMinutes = ((1 - c.progress) * laneKm) / Math.max(1, c.speedKph) * 60;
  }
}

/* ========================================================================== */
/* TICK ORCHESTRATION                                                         */
/* ========================================================================== */

/** The 1Hz physics and events tick. Runs for BOTH sites, always. */
function eventTick(dt: number) {
  for (const id of SITE_IDS) {
    const site = world.sites[id];
    stepWeather(site, dt);
    if (site.physics.kind === 'textile') stepTextile(site, dt);
    else stepPrinting(site, dt);
    stepMachines(site, dt);
    stepOperators(site, dt);
    stepMob(site, dt);
    stepPillars(site, dt);
  }
  stepConvoys(world.sites[world.activeSite], dt);
}

/* ========================================================================== */
/* KINEMATIC ACTION RECOGNITION                                               */
/* ========================================================================== */

/**
 * Turns physical motion into product. This is the whole counting model.
 *
 * It runs PER FRAME, not on the one-second tick, because the phase it
 * integrates is the same phase the renderer uses to position a needle bar or
 * rotate an impression cylinder. The deep-dive view is not an animation that
 * happens to accompany a counter; it is a readout of the variable the counter
 * is made of.
 *
 * Consequences that are worth stating plainly, because they are the demo:
 *   · A jam sets strokeHz to 0. The phase freezes, the needle stops mid-air,
 *     the progress ring stops exactly where it was, and output stops. Not
 *     "stops soon" — stops on that frame.
 *   · Clearing the jam resumes from the SAME strokesThisUnit. A half-finished
 *     garment does not restart from zero, because the strokes already
 *     performed were really performed.
 *   · Environmental derating lowers load, which lowers strokeHz, which slows
 *     the animation AND the count together. You can watch the needle slow
 *     down as the humidity leaves band.
 */
function stepKinematics(site: SiteRuntime, dt: number) {
  for (const m of site.machines) {
    const profile = KINEMATICS[m.def.kind];

    // A jam must halt the motion on THIS frame, not on the next one-second
    // tick. Reading the jam flag here rather than relying on stepMachines to
    // have zeroed strokeHz closes a window of up to a second in which a
    // visibly stopped machine could still have credited strokes — which would
    // have made the whole "counted by motion" claim false by up to seven
    // stitches every time someone jammed a machine on stage.
    if (m.jammed || m.status === 'critical') m.strokeHz = 0;

    if (m.strokeHz <= 0) {
      // Frozen. Report progress so the ring holds its position rather than
      // snapping back, which is what makes a jam legible.
      m.unitProgress = (m.strokesThisUnit + m.kin) / profile.perUnit;
      continue;
    }

    m.kin += m.strokeHz * dt;

    // Guard: a tab that was backgrounded could hand us a large dt. Cap the
    // strokes credited in one frame so a stall cannot mint product.
    let guard = 0;
    while (m.kin >= 1 && guard++ < 16) {
      m.kin -= 1;
      m.strokes += 1;
      m.strokesThisUnit += 1;

      if (m.strokesThisUnit >= profile.perUnit) {
        m.strokesThisUnit = 0;
        m.jobsDone += 1;
        m.lastUnitAt = world.clock;

        // THE increment. The only one in the codebase.
        site.totals.unitsBuilt += m.def.yieldPerCycle;
        m.queue = Math.max(0, m.queue - 1);

        // QA rides on the completed cycle, so defects are per real unit.
        const faulted = m.status === 'warning' || m.status === 'critical';
        const stress = site.physics.kind === 'textile'
          ? clamp(Math.abs(site.physics.rh - 62.5) / 24, 0, 1)
          : clamp(site.physics.vocPpm / 70, 0, 1);
        if (rng() < 0.012 + stress * 0.14 + (faulted ? 0.05 : 0)) {
          m.rejects += 1 + Math.floor(rng() * 2);
        }
      }
    }

    m.unitProgress = (m.strokesThisUnit + m.kin) / profile.perUnit;
  }
}

/** Continuous motion for the ACTIVE site only — the only one being rendered. */
export function advance(dtRaw: number) {
  if (world.paused) return;
  const dt = clamp(dtRaw, 0, 0.1);
  world.clock += dt;

  for (const id of SITE_IDS) stepKinematics(world.sites[id], dt);

  const site = world.sites[world.activeSite];
  const pos = site.positions;
  const head = site.headings;
  const states = site.states;

  for (let i = 0; i < site.operators.length; i++) {
    const op = site.operators[i];
    const r = op.route;

    if (op.dwell > 0) {
      op.dwell -= dt;
      if (op.dwell <= 0) {
        op.dwell = 0;
        op.state = 0;
      }
    } else {
      let remaining = op.speed * dt;
      let guard = 0;
      while (remaining > 0 && guard++ < 8) {
        const len = r.segLen[op.seg];
        const left = (1 - op.segT) * len;
        if (remaining < left) {
          op.segT += remaining / len;
          remaining = 0;
        } else {
          remaining -= left;
          op.seg = (op.seg + 1) % r.count;
          op.segT = 0;
          if (r.isStation[op.seg]) {
            op.state = 1;
            op.dwell = 2.4 + rng() * 5.2;
            op.stationId = nearestMachineId(site.def, r.pts[op.seg * 2], r.pts[op.seg * 2 + 1]);
            remaining = 0;
          }
        }
      }

      const a = op.seg;
      const b = (op.seg + 1) % r.count;
      const ax = r.pts[a * 2];
      const az = r.pts[a * 2 + 1];
      const bx = r.pts[b * 2];
      const bz = r.pts[b * 2 + 1];
      op.x = lerp(ax, bx, op.segT);
      op.z = lerp(az, bz, op.segT);
      op.targetHeading = Math.atan2(bx - ax, bz - az);
    }

    op.heading = lerpAngle(op.heading, op.targetHeading, 1 - Math.exp(-8 * dt));
    op.bob += dt * (op.state === 0 ? 9.5 * (op.speed / 1.1) : 2.2);

    const o = i * 3;
    const bob = op.state === 0 ? Math.abs(Math.sin(op.bob)) * 0.055 : Math.sin(op.bob) * 0.012;
    pos[o] = op.x;
    // Elevation comes from the blueprint, never from the renderer.
    pos[o + 1] = floorElevation(site.def, op.floor) + bob;
    pos[o + 2] = op.z;
    head[i] = op.heading;
    states[i] = op.state;
  }

  // Ease the odometers for every site, so switching sites never shows a jump.
  for (const id of SITE_IDS) {
    const s = world.sites[id];
    s.totals.unitsDisplay = lerp(s.totals.unitsDisplay, s.totals.unitsBuilt, 1 - Math.exp(-6 * dt));
    for (const key of PILLARS) {
      const m = s.pillars[key];
      m.display = lerp(m.display, m.value, 1 - Math.exp(-5 * dt));
    }
  }

  world.eventAccum += dt;
  while (world.eventAccum >= 1) {
    world.eventAccum -= 1;
    eventTick(1);
  }
}

/* -------------------------------------------------------------------------- */
/* Simulator driver                                                            */
/* -------------------------------------------------------------------------- */

let intervalId: ReturnType<typeof setInterval> | null = null;
let lastIntervalAt = 0;

/**
 * Keeps both sites alive even when no R3F canvas is mounted (macro layer, or
 * during the VRAM handoff). When `useFrame` IS driving, this backs off so the
 * world is never advanced twice in the same wall-clock slice.
 */
export function startSimulator() {
  if (intervalId !== null || typeof window === 'undefined') return;
  lastIntervalAt = performance.now();
  intervalId = setInterval(() => {
    const now = performance.now();
    const dt = (now - lastIntervalAt) / 1000;
    lastIntervalAt = now;
    if (now - world.lastFrameAt < 250) return;
    advance(dt);
  }, 120);
}

export function stopSimulator() {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

/** Called from useFrame. Marks the frame clock and advances the world once. */
export function frameAdvance(dt: number) {
  world.lastFrameAt = performance.now();
  advance(dt);
}

/* ========================================================================== */
/* RESOLUTION ACTIONS — what clicking a 3D node actually does                 */
/* ========================================================================== */

/**
 * Clearing a jam. Not a flag flip: the machine restarts cold, its queue has
 * backed up while it was down, and the time it spent jammed is charged against
 * its uptime.
 */
export function clearJam(siteId: SiteId, machineId: string): boolean {
  const site = world.sites[siteId];
  const m = site.machines.find((x) => x.def.id === machineId);
  if (!m || !m.jammed) return false;

  m.jammed = false;
  m.status = 'nominal';
  m.faultCode = '';
  m.load = 0.08;
  m.cycleT = 0;
  // strokesThisUnit is deliberately NOT reset: those strokes happened, and
  // the part they were making is still half made.
  m.queue += Math.round(m.jamSeconds / m.def.cycleSeconds);
  m.uptimePct = clamp(m.uptimePct - m.jamSeconds / 180, 80, 99.9);
  m.jamSeconds = 0;

  for (const a of world.alerts) {
    if (!a.resolved && a.siteId === siteId && a.nodeId === machineId && a.code === 'JAM') a.resolved = true;
  }
  bumpAlerts();
  return true;
}

/**
 * Acting on an environmental node. Each case applies a REAL control change, and
 * the physics then has to converge — the number does not snap back, it recovers
 * at the rate the model allows.
 */
export function resolveEnvNode(siteId: SiteId, nodeId: string): boolean {
  const site = world.sites[siteId];
  const node = site.envNodes.find((n) => n.def.id === nodeId);
  if (!node || !node.alert) return false;

  const p = site.physics;

  if (p.kind === 'textile') {
    if (node.def.kind === 'humidity') {
      // Re-centre the setpoint, open the roof vents, and put the refrigerant
      // dehumidifier on full. Ventilation alone has a time constant of several
      // minutes in a shed this size; the dehumidifier is what actually pulls
      // 3 tonnes an hour of condensate out and brings the band back.
      p.rhSetpoint = (RH_BAND.lo + RH_BAND.hi) / 2;
      p.ventilationAch = p.rh > RH_BAND.hi ? 16 : 3.2;
      p.dehumidDuty = p.rh > RH_BAND.hi ? 1 : 0;
      // If it is too DRY instead, the humidifier gets the step rather than the
      // dehumidifier — the same control, in the other direction.
      if (p.rh < RH_BAND.lo) p.humidifierDuty = 1;
    }
  } else {
    if (node.def.kind === 'voc') {
      // Carbon bed to full duty and the hall onto emergency purge. The box
      // model then decays exponentially at the new, much larger removal rate.
      p.scrubberDuty = 1;
      p.extractionAch = 14;
      p.purgeT = 120;
    } else if (node.def.kind === 'dust') {
      p.extractionAch = 14;
      p.purgeT = 90;
    } else if (node.def.kind === 'power') {
      // Shed the laminator and reset the peak register — the only honest way
      // to come back under a contract demand ceiling.
      const lam = site.machines.find((m) => m.def.kind === 'laminator');
      if (lam) lam.status = 'idle';
      p.grid.peakKva = p.grid.kva;
    }
  }

  // Give the physics a window to converge before this alarm may fire again.
  node.correctingT = 150;

  node.alert = false;
  node.alertSeconds = 0;
  node.alertCode = '';
  node.alertMessage = '';

  for (const a of world.alerts) {
    if (!a.resolved && a.siteId === siteId && a.nodeId === nodeId) a.resolved = true;
  }
  bumpAlerts();
  return true;
}

/* -------------------------------------------------------------------------- */
/* Reactive slice                                                              */
/* -------------------------------------------------------------------------- */

interface MegnetoState {
  phase: Phase;
  activeSite: SiteId;
  /**
   * Which level the floor selector is isolating, or 'all' for the full stack.
   * A view concern only — the simulation always runs every floor.
   */
  activeFloor: FloorSelection;
  /** The site the user picked on the globe, which the dive is heading for. */
  targetSite: SiteId;
  selectedMachineId: string | null;
  /**
   * The machine currently in exploded view. Separate from selection because
   * selecting opens a panel, while exploding moves the camera and takes the
   * machine apart — two different commitments.
   */
  explodedMachineId: string | null;
  selectedEnvNodeId: string | null;
  hoveredOperatorIndex: number | null;
  /** Instance id of the worker whose inspection card is open, 0..2999. */
  selectedWorkerIndex: number | null;
  /** Instance id the camera has been asked to fly to. */
  focusedWorkerIndex: number | null;
  /** Machine whose kinematics are under the macro lens. */
  kinematicMachineId: string | null;
  focusedPillar: Pillar | null;
  alertRevision: number;
  paused: boolean;
  hudOpen: boolean;
  globeDegraded: boolean;

  beginDive: (site: SiteId) => void;
  enterHandoff: () => void;
  completeDive: () => void;
  beginAscent: () => void;
  completeAscent: () => void;
  setActiveFloor: (floor: FloorSelection) => void;
  /** Take a machine apart and fly the camera into it. */
  explodeMachine: (id: string) => void;
  /** Reassemble and return to the floor framing. */
  collapseMachine: () => void;
  /**
   * Boot straight into a deep link: ?site=tiruppur&floor=2 skips the globe
   * entirely, which also means the Cesium chunk is never fetched.
   */
  hydrateFromUrl: (site: SiteId | null, floor: FloorSelection) => void;
  selectMachine: (id: string | null) => void;
  selectEnvNode: (id: string | null) => void;
  hoverOperator: (index: number | null) => void;
  /** Open (or close) the inspection card for one worker. */
  selectWorker: (index: number | null) => void;
  /** Fly the camera to a worker. Null returns to the floor framing. */
  focusWorker: (index: number | null) => void;
  /** Enter (or leave) the macro-lens kinematic view of a machine. */
  inspectKinematics: (id: string | null) => void;
  focusPillar: (p: Pillar | null) => void;
  /** Click-through from the 3D scene. Returns true when something was resolved. */
  actOnMachine: (id: string) => boolean;
  actOnEnvNode: (id: string) => boolean;
  togglePause: () => void;
  toggleHud: () => void;
  setGlobeDegraded: (v: boolean) => void;
}

export const useMegnetoStore = create<MegnetoState>((set, get) => ({
  phase: 'macro',
  activeSite: 'tiruppur',
  activeFloor: 'all',
  targetSite: 'tiruppur',
  selectedMachineId: null,
  explodedMachineId: null,
  selectedEnvNodeId: null,
  hoveredOperatorIndex: null,
  selectedWorkerIndex: null,
  focusedWorkerIndex: null,
  kinematicMachineId: null,
  focusedPillar: null,
  alertRevision: 0,
  paused: false,
  hudOpen: true,
  globeDegraded: false,

  beginDive: (site) => {
    if (get().phase !== 'macro') return;
    world.activeSite = site;
    set({ phase: 'descending', targetSite: site, activeSite: site });
  },

  enterHandoff: () => {
    if (get().phase !== 'descending') return;
    set({ phase: 'handoff' });
  },

  completeDive: () => {
    if (get().phase !== 'handoff') return;
    set({ phase: 'micro' });
  },

  beginAscent: () => {
    if (get().phase !== 'micro') return;
    set({
      phase: 'ascending',
      selectedMachineId: null,
      selectedEnvNodeId: null,
      explodedMachineId: null,
      hoveredOperatorIndex: null,
      selectedWorkerIndex: null,
      focusedWorkerIndex: null,
      kinematicMachineId: null,
    });
  },

  completeAscent: () => set({ phase: 'macro' }),

  explodeMachine: (id) => {
    const st = get();
    if (st.explodedMachineId === id) return;
    const floor = floorOfNode(st.activeSite, id);
    // Exploding a machine on a hidden level would fly the camera into a
    // wireframe cage, so isolating that level is part of the same action.
    set({
      explodedMachineId: id,
      selectedMachineId: id,
      selectedEnvNodeId: null,
      activeFloor: floor ?? st.activeFloor,
    });
  },

  collapseMachine: () => {
    if (get().explodedMachineId === null) return;
    set({ explodedMachineId: null });
  },

  setActiveFloor: (floor) => {
    if (get().activeFloor === floor) return;
    // Isolating a floor closes any panel anchored on another one, so the
    // camera never flies away from an open card.
    set({
      activeFloor: floor,
      selectedMachineId: null,
      selectedEnvNodeId: null,
      explodedMachineId: null,
      selectedWorkerIndex: null,
      focusedWorkerIndex: null,
      kinematicMachineId: null,
    });
  },

  hydrateFromUrl: (site, floor) => {
    const st = get();
    // Only ever runs once, at boot, and only forward: a link may open the
    // floor view, but it must never yank a presenter out of one mid-demo.
    if (st.phase !== 'macro') {
      if (floor !== st.activeFloor) set({ activeFloor: floor });
      return;
    }
    if (site) {
      world.activeSite = site;
      set({ phase: 'micro', activeSite: site, targetSite: site, activeFloor: floor });
    } else if (floor !== st.activeFloor) {
      set({ activeFloor: floor });
    }
  },

  selectMachine: (id) => {
    if (get().selectedMachineId === id) return;
    set({ selectedMachineId: id, selectedEnvNodeId: null });
  },

  selectEnvNode: (id) => {
    if (get().selectedEnvNodeId === id) return;
    set({ selectedEnvNodeId: id, selectedMachineId: null });
  },

  hoverOperator: (index) => {
    if (get().hoveredOperatorIndex === index) return; // pointermove fires constantly
    set({ hoveredOperatorIndex: index });
  },

  selectWorker: (index) => {
    if (get().selectedWorkerIndex === index) return;
    // Opening a person closes machine panels: one subject at a time.
    set({ selectedWorkerIndex: index, selectedMachineId: null, selectedEnvNodeId: null });
  },

  focusWorker: (index) => {
    if (get().focusedWorkerIndex === index) return;
    set({ focusedWorkerIndex: index, explodedMachineId: index === null ? get().explodedMachineId : null });
  },

  inspectKinematics: (id) => {
    const st = get();
    if (st.kinematicMachineId === id) return;
    if (id === null) {
      set({ kinematicMachineId: null });
      return;
    }
    const floor = floorOfNode(st.activeSite, id);
    set({
      kinematicMachineId: id,
      selectedMachineId: id,
      explodedMachineId: null,
      selectedWorkerIndex: null,
      focusedWorkerIndex: null,
      activeFloor: floor ?? st.activeFloor,
    });
  },

  focusPillar: (p) => {
    if (get().focusedPillar === p) return;
    set({ focusedPillar: p });
  },

  actOnMachine: (id) => {
    const resolved = clearJam(get().activeSite, id);
    set({ selectedMachineId: id, selectedEnvNodeId: null });
    return resolved;
  },

  actOnEnvNode: (id) => {
    const resolved = resolveEnvNode(get().activeSite, id);
    set({ selectedEnvNodeId: id, selectedMachineId: null });
    return resolved;
  },

  togglePause: () => {
    const next = !get().paused;
    world.paused = next;
    set({ paused: next });
  },

  toggleHud: () => set((s) => ({ hudOpen: !s.hudOpen })),

  setGlobeDegraded: (v) => {
    if (get().globeDegraded === v) return;
    set({ globeDegraded: v });
  },
}));

/* -------------------------------------------------------------------------- */
/* Transient helpers (no hooks, no subscriptions)                              */
/* -------------------------------------------------------------------------- */

export const peekPhase = (): Phase => useMegnetoStore.getState().phase;

export const findMachine = (siteId: SiteId, id: string | null): MachineRuntime | undefined =>
  id ? world.sites[siteId].machines.find((m) => m.def.id === id) : undefined;

export const findEnvNode = (siteId: SiteId, id: string | null): EnvNodeRuntime | undefined =>
  id ? world.sites[siteId].envNodes.find((n) => n.def.id === id) : undefined;

/** Open, unresolved alerts for a site, newest first. */
export const openAlerts = (siteId?: SiteId): AlertRecord[] =>
  world.alerts.filter((a) => !a.resolved && (!siteId || a.siteId === siteId));

/** One worker's full record, assembled on demand. */
export interface WorkerSnapshot {
  index: number;
  /** Display id, e.g. #MG-1042. */
  workerId: string;
  name: string | null;
  floor: FloorIndex;
  zoneLabel: string;
  stationId: string;
  stationName: string;
  rfid: string;
  gait: number;
  efficiency: number;
  units: number;
  cadence: number;
  heartRate: number;
  strain: number;
  /** True for the 21 RF-tagged operators with a full route simulation. */
  tracked: boolean;
  /** Live world position. */
  x: number;
  y: number;
  z: number;
}

/**
 * Reads one worker out of the flat arrays. Allocates a single object, on
 * demand, for the one person a human is actually looking at — which is the
 * whole reason the other 2,999 live in typed arrays.
 *
 * The first RENDERED_OPERATORS indices are the fully-simulated operators, so
 * their richer figures (route-driven output, live heart rate, real names) win
 * over the ambient arrays.
 */
export function workerSnapshot(siteId: SiteId, index: number): WorkerSnapshot | null {
  const site = world.sites[siteId];
  const mob = site.mob;
  if (index < 0 || index >= mob.count) return null;

  const def = site.def;
  const tracked = index < site.operators.length;
  const op = tracked ? site.operators[index] : null;

  const floor = (tracked ? op!.floor : mob.floors[index]) as FloorIndex;
  const zone = def.zones[mob.zone[index]] ?? def.zones[0];
  const machine = def.machines[mob.station[index]] ?? def.machines[0];
  const stationId = tracked ? op!.stationId : machine.id;
  const stationDef = def.machines.find((m) => m.id === stationId) ?? machine;

  const o = index * 3;
  const pos = tracked ? site.positions : mob.positions;

  return {
    index,
    workerId: `#MG-${1000 + index}`,
    name: op ? op.name : null,
    floor,
    zoneLabel: zone.label,
    stationId,
    stationName: stationDef.name,
    rfid: op ? op.rfid : `RF:${mob.rfid[index].toString(16).toUpperCase().padStart(8, '0')}`,
    gait: op ? op.gaitConfidence : mob.gait[index],
    efficiency: op ? op.efficiency : mob.efficiency[index],
    units: op ? op.units : mob.units[index],
    cadence: op ? op.efficiency * 26 : mob.cadence[index],
    heartRate: op ? op.heartRate : mob.heartRate[index],
    strain: op ? op.strain : mob.strain[index],
    tracked,
    x: pos[o],
    y: pos[o + 1],
    z: pos[o + 2],
  };
}

/** Which floor a node sits on, for routing alerts to the floor selector. */
export function floorOfNode(siteId: SiteId, nodeId: string): FloorIndex | null {
  const def = world.sites[siteId].def;
  const m = def.machines.find((x) => x.id === nodeId);
  if (m) return m.floor;
  const n = def.envNodes.find((x) => x.id === nodeId);
  return n ? n.floor : null;
}

/** Enrolled and on-shift headcount for one level. Drives the floor pills. */
export function floorHeadcount(siteId: SiteId, floor: FloorIndex): { enrolled: number; onShift: number } {
  const site = world.sites[siteId];
  let enrolled = 0;
  let onShift = 0;
  for (const sec of site.def.sectors) {
    if (sec.floor !== floor) continue;
    enrolled += sec.headcount;
    onShift += site.sectorOnShift[sec.id] ?? 0;
  }
  return { enrolled, onShift };
}

/** Unresolved alerts standing on one level, split by whether they need a click. */
export function floorAlertCount(siteId: SiteId, floor: FloorIndex): { open: number; actionable: number } {
  let open = 0;
  let actionable = 0;
  for (const a of world.alerts) {
    if (a.resolved || a.siteId !== siteId) continue;
    if (floorOfNode(siteId, a.nodeId) !== floor) continue;
    open += 1;
    if (a.actionable) actionable += 1;
  }
  return { open, actionable };
}

/** Every level of a site, for iteration in the HUD. */
export const floorsOf = (siteId: SiteId) => world.sites[siteId].def.floors;

export { FLOOR_INDICES };

/* -------------------------------------------------------------------------- */
/* Rehearsal console                                                           */
/* -------------------------------------------------------------------------- */

/**
 * In development, `__megneto` in the browser console gives you the live world
 * and the store — handy for forcing a state on cue mid-rehearsal:
 *
 *   __megneto.world.sites.tiruppur.physics.ah *= 1.35   // force a humidity alert
 *   __megneto.world.sites.rajajinagar.physics.vocMgM3 = 220
 *   __megneto.world.sites.tiruppur.machines[0].jammed = true
 */
if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production') {
  (window as unknown as Record<string, unknown>).__megneto = {
    world,
    store: useMegnetoStore,
    advance,
    clearJam,
    resolveEnvNode,
  };
}
