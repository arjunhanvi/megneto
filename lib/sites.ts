/**
 * Megneto V3 — the two-node, three-storey blueprint.
 *
 * Everything spatial and every nominal operating value lives here as frozen,
 * plain data, so the simulation engine and the renderers agree on one
 * coordinate system and neither allocates at runtime.
 *
 * Units are metres, degrees Celsius, kilowatts, cubic metres per hour, ppm and
 * micrograms per cubic metre. Origin of each facility is the centre of the
 * GROUND floor slab. +X east, +Z south, +Y up.
 *
 * ============================================================================
 * WHY THREE FLOORS
 * ============================================================================
 * Three thousand people and fifty machines laid out on one slab is visual
 * mush — you cannot point at anything during a pitch. Stacking the plant the
 * way a real mill is stacked fixes that: heavy, wet, loud processes sit on the
 * ground where the foundations and drains are; the labour-dense lines sit above
 * them; QA, logistics and admin sit at the top. Each floor then holds three
 * zones across the full footprint, which is a layout you can actually read.
 *
 * `floor` is an index: 0 = ground, 1, 2. World Y for a floor is
 * `floor * floorHeight`, and that is the ONLY place elevation is computed.
 * ============================================================================
 */

/* ========================================================================== */
/* Shared shapes                                                              */
/* ========================================================================== */

export type SiteId = 'tiruppur' | 'rajajinagar';
export type SiteKind = 'textile' | 'printing';

/** 0 = ground, 1, 2. `'all'` is a view mode, never a placement. */
export type FloorIndex = 0 | 1 | 2;
export type FloorSelection = FloorIndex | 'all';

export const FLOOR_INDICES: readonly FloorIndex[] = Object.freeze([0, 1, 2]);

export type MachineKind =
  | 'spinning'
  | 'knitting'
  | 'dyeing'
  | 'stenter'
  | 'cutting'
  | 'stitching'
  | 'press'
  | 'prepress'
  | 'binding'
  | 'laminator'
  | 'guillotine'
  | 'inspection'
  | 'dispatch'
  | 'packing';

export type MachineStatus = 'nominal' | 'warning' | 'critical' | 'idle' | 'jammed';

/** The eight pillars the command centre is organised around. */
export type Pillar =
  | 'mob'
  | 'inventory'
  | 'product'
  | 'machinery'
  | 'qa'
  | 'logistics'
  | 'utility'
  | 'environment';

export const PILLARS: readonly Pillar[] = Object.freeze([
  'mob',
  'inventory',
  'product',
  'machinery',
  'qa',
  'logistics',
  'utility',
  'environment',
]);

export const PILLAR_LABEL: Record<Pillar, string> = {
  mob: 'Workforce',
  inventory: 'Inventory',
  product: 'Output',
  machinery: 'Machinery',
  qa: 'Quality',
  logistics: 'Logistics',
  utility: 'Utility',
  environment: 'Environment',
};

export interface FloorDef {
  readonly index: FloorIndex;
  /** Short label for the floor selector pill: L1, L2, L3. */
  readonly pill: string;
  readonly name: string;
  /** One line describing what happens up here. */
  readonly caption: string;
}

export interface ZoneDef {
  readonly id: string;
  readonly label: string;
  readonly floor: FloorIndex;
  /** [minX, minZ, maxX, maxZ] */
  readonly bounds: readonly [number, number, number, number];
  readonly tone: string;
}

export interface MachineDef {
  readonly id: string;
  readonly name: string;
  readonly kind: MachineKind;
  readonly zone: string;
  readonly floor: FloorIndex;
  /** [x, yOffsetWithinFloor, z]. World Y adds `floor * floorHeight`. */
  readonly position: readonly [number, number, number];
  readonly size: readonly [number, number, number];
  readonly rotation: number;
  readonly nominalTempC: number;
  readonly nominalDb: number;
  readonly nominalRpm: number;
  readonly cycleSeconds: number;
  /** Rated electrical draw, kW. Feeds the utility pillar directly. */
  readonly ratedKw: number;
  readonly yieldPerCycle: number;
}

export interface RouteDef {
  readonly id: string;
  readonly label: string;
  readonly floor: FloorIndex;
  /** Closed loop of floor waypoints: [x, z]. */
  readonly waypoints: readonly (readonly [number, number])[];
  readonly stations: readonly number[];
}

export type EnvNodeKind = 'zld' | 'dyevat' | 'humidity' | 'voc' | 'dust' | 'power';

export interface EnvNodeDef {
  readonly id: string;
  readonly name: string;
  readonly kind: EnvNodeKind;
  readonly floor: FloorIndex;
  readonly position: readonly [number, number, number];
  readonly size: readonly [number, number, number];
  readonly caption: string;
}

export interface SectorDef {
  readonly id: string;
  readonly label: string;
  readonly floor: FloorIndex;
  readonly headcount: number;
  readonly shiftFactor: number;
}

export interface SiteDef {
  readonly id: SiteId;
  readonly kind: SiteKind;
  readonly name: string;
  readonly shortName: string;
  readonly city: string;
  readonly lat: number;
  readonly lon: number;
  readonly alt: number;
  readonly shell: {
    readonly width: number;
    readonly depth: number;
    /** Floor-to-floor height. Total building height is 3× this. */
    readonly floorHeight: number;
    readonly wallThickness: number;
    readonly modelUrl: string;
  };
  readonly floors: readonly FloorDef[];
  readonly zones: readonly ZoneDef[];
  readonly machines: readonly MachineDef[];
  readonly routes: readonly RouteDef[];
  readonly envNodes: readonly EnvNodeDef[];
  readonly sectors: readonly SectorDef[];
  readonly productUnit: string;
  readonly productName: string;
  readonly contractKva: number;
  readonly climate: {
    readonly meanTempC: number;
    readonly diurnalSwingC: number;
    readonly meanRh: number;
    readonly monsoonBias: number;
  };
}

/** Hard cap on rendered operators. The HUD reports thousands; the GPU draws 21. */
export const RENDERED_OPERATORS = 21;
export const MAX_RENDERED_OPERATORS = 24;

/** World Y of a floor's slab. The single source of elevation truth. */
export function floorElevation(site: SiteDef, floor: FloorIndex): number {
  return floor * site.shell.floorHeight;
}

/* ========================================================================== */
/* SITE A — Swift Merchandise Textile Factory, Tiruppur                       */
/* ========================================================================== */

const TPR_FLOORS: readonly FloorDef[] = Object.freeze([
  { index: 0, pill: 'L1', name: 'Heavy Process', caption: 'Spinning · dye house · ZLD effluent' },
  { index: 1, pill: 'L2', name: 'Sewing Lines', caption: 'Knitting · cutting · stitching' },
  { index: 2, pill: 'L3', name: 'QA & Export', caption: 'Checking · packing · admin' },
]);

const TPR_ZONES: readonly ZoneDef[] = Object.freeze([
  // Ground — heavy, wet, loud. Foundations and drains live here.
  { id: 'spin', label: 'A1 · SPINNING', floor: 0, bounds: [-15, -11, -4, 11], tone: '#dceaf7' },
  { id: 'dye', label: 'A2 · DYE HOUSE', floor: 0, bounds: [-4, -11, 7, 11], tone: '#d7e8f6' },
  { id: 'zld', label: 'A3 · ZLD EFFLUENT', floor: 0, bounds: [7, -11, 15, 11], tone: '#d2e5f4' },
  // First — labour-dense lines.
  { id: 'knit', label: 'B1 · KNITTING', floor: 1, bounds: [-15, -11, -4, 11], tone: '#e4f1fb' },
  { id: 'cut', label: 'B2 · CUTTING', floor: 1, bounds: [-4, -11, 7, 11], tone: '#e8f3fc' },
  { id: 'stitch', label: 'B3 · STITCHING', floor: 1, bounds: [7, -11, 15, 11], tone: '#dfeef9' },
  // Second — QA, packing, admin.
  { id: 'qc', label: 'C1 · CHECKING', floor: 2, bounds: [-15, -11, -3, 11], tone: '#e4f1fb' },
  { id: 'pack', label: 'C2 · PACKING', floor: 2, bounds: [-3, -11, 8, 11], tone: '#dfeef9' },
  { id: 'admin', label: 'C3 · EXPORT DESK', floor: 2, bounds: [8, -11, 15, 11], tone: '#d2e5f4' },
]);

const TPR_MACHINES: readonly MachineDef[] = Object.freeze([
  /* ---- Ground ---- */
  {
    id: 'SPN-01', name: 'Ring Spinning Frame', kind: 'spinning', zone: 'spin', floor: 0,
    position: [-11.6, 0, -6.0], size: [3.6, 1.8, 1.4], rotation: 0,
    nominalTempC: 41, nominalDb: 84, nominalRpm: 16000, cycleSeconds: 46, ratedKw: 58, yieldPerCycle: 4,
  },
  {
    id: 'SPN-02', name: 'Open-End Rotor Frame', kind: 'spinning', zone: 'spin', floor: 0,
    position: [-11.6, 0, 0.4], size: [3.6, 1.8, 1.4], rotation: 0,
    nominalTempC: 44, nominalDb: 88, nominalRpm: 92000, cycleSeconds: 38, ratedKw: 71, yieldPerCycle: 5,
  },
  {
    id: 'SPN-03', name: 'Draw Frame', kind: 'spinning', zone: 'spin', floor: 0,
    position: [-11.6, 0, 6.6], size: [3.0, 1.5, 1.3], rotation: 0,
    nominalTempC: 36, nominalDb: 76, nominalRpm: 4200, cycleSeconds: 52, ratedKw: 22, yieldPerCycle: 6,
  },
  {
    id: 'DYE-01', name: 'Soft-Flow Dyeing Vessel', kind: 'dyeing', zone: 'dye', floor: 0,
    position: [-0.6, 0, -6.4], size: [2.6, 2.6, 2.6], rotation: 0,
    nominalTempC: 98, nominalDb: 68, nominalRpm: 0, cycleSeconds: 420, ratedKw: 44, yieldPerCycle: 24,
  },
  {
    id: 'DYE-02', name: 'Soft-Flow Dyeing Vessel', kind: 'dyeing', zone: 'dye', floor: 0,
    position: [3.4, 0, -6.4], size: [2.6, 2.6, 2.6], rotation: 0,
    nominalTempC: 96, nominalDb: 67, nominalRpm: 0, cycleSeconds: 440, ratedKw: 44, yieldPerCycle: 24,
  },
  {
    id: 'STN-01', name: 'Stenter Drying Range', kind: 'stenter', zone: 'dye', floor: 0,
    position: [1.4, 0, 3.0], size: [5.4, 2.0, 1.8], rotation: 0,
    nominalTempC: 165, nominalDb: 74, nominalRpm: 0, cycleSeconds: 95, ratedKw: 96, yieldPerCycle: 12,
  },

  /* ---- First ---- */
  {
    id: 'KNT-01', name: 'Circular Knitting M/C 1', kind: 'knitting', zone: 'knit', floor: 1,
    position: [-11.8, 0, -6.6], size: [2.2, 2.3, 2.2], rotation: 0,
    nominalTempC: 38, nominalDb: 79, nominalRpm: 26, cycleSeconds: 64, ratedKw: 12, yieldPerCycle: 3,
  },
  {
    id: 'KNT-02', name: 'Circular Knitting M/C 2', kind: 'knitting', zone: 'knit', floor: 1,
    position: [-7.4, 0, -6.6], size: [2.2, 2.3, 2.2], rotation: 0,
    nominalTempC: 37, nominalDb: 78, nominalRpm: 24, cycleSeconds: 68, ratedKw: 12, yieldPerCycle: 3,
  },
  {
    id: 'KNT-03', name: 'Flat-Bed Collar Knitter', kind: 'knitting', zone: 'knit', floor: 1,
    position: [-9.6, 0, 4.4], size: [3.0, 1.5, 1.3], rotation: 0,
    nominalTempC: 34, nominalDb: 71, nominalRpm: 18, cycleSeconds: 52, ratedKw: 7, yieldPerCycle: 6,
  },
  {
    id: 'CUT-01', name: 'CNC Fabric Cutter', kind: 'cutting', zone: 'cut', floor: 1,
    position: [1.4, 0, -5.4], size: [4.2, 1.1, 2.0], rotation: 0,
    nominalTempC: 32, nominalDb: 66, nominalRpm: 3400, cycleSeconds: 41, ratedKw: 9, yieldPerCycle: 18,
  },
  {
    id: 'CUT-02', name: 'Spreading Table', kind: 'cutting', zone: 'cut', floor: 1,
    position: [1.4, 0, 4.2], size: [4.6, 0.9, 1.8], rotation: 0,
    nominalTempC: 29, nominalDb: 58, nominalRpm: 240, cycleSeconds: 60, ratedKw: 4, yieldPerCycle: 22,
  },
  {
    id: 'STH-01', name: 'Stitching Line Alpha', kind: 'stitching', zone: 'stitch', floor: 1,
    position: [11.2, 0, -6.2], size: [4.6, 1.2, 1.6], rotation: 0,
    nominalTempC: 31, nominalDb: 72, nominalRpm: 5200, cycleSeconds: 26, ratedKw: 6, yieldPerCycle: 8,
  },
  {
    id: 'STH-02', name: 'Stitching Line Bravo', kind: 'stitching', zone: 'stitch', floor: 1,
    position: [11.2, 0, 0.6], size: [4.6, 1.2, 1.6], rotation: 0,
    nominalTempC: 31, nominalDb: 73, nominalRpm: 5400, cycleSeconds: 25, ratedKw: 6, yieldPerCycle: 8,
  },
  {
    id: 'STH-03', name: 'Stitching Line Charlie', kind: 'stitching', zone: 'stitch', floor: 1,
    position: [11.2, 0, 7.0], size: [4.6, 1.2, 1.6], rotation: 0,
    nominalTempC: 32, nominalDb: 74, nominalRpm: 5300, cycleSeconds: 27, ratedKw: 6, yieldPerCycle: 8,
  },

  /* ---- Second ---- */
  {
    id: 'QCX-01', name: 'Vision Inspection Rig', kind: 'inspection', zone: 'qc', floor: 2,
    position: [-10.4, 0, -5.0], size: [2.4, 1.7, 1.6], rotation: 0,
    nominalTempC: 30, nominalDb: 44, nominalRpm: 0, cycleSeconds: 19, ratedKw: 5, yieldPerCycle: 26,
  },
  {
    id: 'QCX-02', name: 'Metal Detection Gate', kind: 'inspection', zone: 'qc', floor: 2,
    position: [-10.4, 0, 3.8], size: [2.0, 2.2, 1.2], rotation: 0,
    nominalTempC: 28, nominalDb: 41, nominalRpm: 0, cycleSeconds: 12, ratedKw: 3, yieldPerCycle: 34,
  },
  {
    id: 'PKG-01', name: 'Carton Packing Line', kind: 'packing', zone: 'pack', floor: 2,
    position: [2.4, 0, -4.4], size: [4.0, 1.3, 1.8], rotation: 0,
    nominalTempC: 30, nominalDb: 64, nominalRpm: 320, cycleSeconds: 31, ratedKw: 8, yieldPerCycle: 20,
  },
  {
    id: 'DSP-01', name: 'Export Sorter', kind: 'dispatch', zone: 'admin', floor: 2,
    position: [11.6, 0, 1.0], size: [2.6, 1.2, 3.0], rotation: 0,
    nominalTempC: 29, nominalDb: 57, nominalRpm: 260, cycleSeconds: 23, ratedKw: 7, yieldPerCycle: 28,
  },
]);

const TPR_ENV: readonly EnvNodeDef[] = Object.freeze([
  {
    id: 'ZLD-RO', name: 'RO Membrane Train', kind: 'zld', floor: 0,
    position: [10.4, 0, -5.6], size: [2.4, 2.2, 3.2],
    caption: 'Reverse osmosis · permeate recovery',
  },
  {
    id: 'ZLD-MEE', name: 'Multi-Effect Evaporator', kind: 'zld', floor: 0,
    position: [13.0, 0, 2.4], size: [2.6, 3.0, 2.6],
    caption: 'Brine concentration · salt recovery',
  },
  {
    id: 'ENV-VAT', name: 'Dye Vat Thermal Bank', kind: 'dyevat', floor: 0,
    position: [5.4, 0, -1.0], size: [3.2, 1.6, 1.4],
    caption: 'Steam header · vat setpoint tracking',
  },
  {
    id: 'ENV-RH', name: 'Humidification Plant', kind: 'humidity', floor: 1,
    position: [4.6, 0, 8.4], size: [2.2, 2.4, 1.6],
    caption: 'Cotton conditioning · 55-70 %RH band',
  },
]);

const TPR_ROUTES: readonly RouteDef[] = Object.freeze([
  {
    id: 't-spin', label: 'Spinning aisle', floor: 0,
    waypoints: [[-8.4, -6.0], [-8.4, 6.6], [-6.0, 8.2], [-6.0, -7.6], [-9.4, -9.2]],
    stations: [0, 1, 3],
  },
  {
    id: 't-dye', label: 'Dye house', floor: 0,
    waypoints: [[-0.6, -3.4], [3.4, -3.4], [5.2, 0.4], [1.4, 0.6], [-2.4, -0.6]],
    stations: [0, 1, 3],
  },
  {
    id: 't-zld', label: 'Effluent walk', floor: 0,
    waypoints: [[8.8, -5.6], [8.8, 2.4], [11.0, 6.4], [13.0, 6.4], [13.4, -8.0], [9.6, -8.6]],
    stations: [0, 1, 3],
  },
  {
    id: 't-knit', label: 'Knitting aisle', floor: 1,
    waypoints: [[-11.8, -3.6], [-7.4, -3.6], [-5.6, 1.2], [-9.6, 1.6], [-13.0, -1.0]],
    stations: [0, 1, 3],
  },
  {
    id: 't-cut', label: 'Cutting floor', floor: 1,
    waypoints: [[1.4, -2.6], [5.2, -2.6], [5.2, 6.8], [-1.2, 6.8], [-2.0, 0.4]],
    stations: [0, 2, 3],
  },
  {
    id: 't-stitch', label: 'Stitching lines', floor: 1,
    waypoints: [[8.4, -6.2], [8.4, 0.6], [8.4, 7.0], [13.6, 7.6], [13.6, -7.4]],
    stations: [0, 1, 2],
  },
  {
    id: 't-qc', label: 'Checking hall', floor: 2,
    waypoints: [[-10.4, -2.2], [-10.4, 3.8], [-6.4, 6.6], [-6.4, -7.0], [-12.8, -7.4]],
    stations: [0, 1, 3],
  },
  {
    id: 't-pack', label: 'Packing spine', floor: 2,
    waypoints: [[2.4, -1.8], [6.0, -1.8], [6.0, 7.2], [-0.4, 7.2], [-1.6, -0.8]],
    stations: [0, 2, 3],
  },
  {
    id: 't-export', label: 'Export desk', floor: 2,
    waypoints: [[11.6, -2.6], [13.8, -2.6], [13.8, 7.8], [9.6, 7.8], [9.4, 1.0]],
    stations: [0, 2, 4],
  },
]);

const TPR_SECTORS: readonly SectorDef[] = Object.freeze([
  { id: 'spinning', label: 'Spinning', floor: 0, headcount: 240, shiftFactor: 0.82 },
  { id: 'dyeing', label: 'Dyeing & Finishing', floor: 0, headcount: 285, shiftFactor: 0.71 },
  { id: 'effluent', label: 'Effluent & Utilities', floor: 0, headcount: 65, shiftFactor: 0.68 },
  { id: 'knitting', label: 'Knitting', floor: 1, headcount: 310, shiftFactor: 0.78 },
  { id: 'cutting', label: 'Cutting', floor: 1, headcount: 190, shiftFactor: 0.86 },
  { id: 'stitching', label: 'Stitching', floor: 1, headcount: 425, shiftFactor: 0.88 },
  { id: 'checking', label: 'Checking & QA', floor: 2, headcount: 175, shiftFactor: 0.9 },
  { id: 'packing', label: 'Packing & Export', floor: 2, headcount: 160, shiftFactor: 0.74 },
]);

export const TIRUPPUR: SiteDef = Object.freeze({
  id: 'tiruppur',
  kind: 'textile',
  name: 'Swift Merchandise Textile Factory',
  shortName: 'SWIFT MERCHANDISE',
  city: 'Tiruppur, Tamil Nadu',
  lat: 11.1085,
  lon: 77.3411,
  alt: 300,
  shell: { width: 32, depth: 24, floorHeight: 4.6, wallThickness: 0.26, modelUrl: '/models/factory.glb' },
  floors: TPR_FLOORS,
  zones: TPR_ZONES,
  machines: TPR_MACHINES,
  routes: TPR_ROUTES,
  envNodes: TPR_ENV,
  sectors: TPR_SECTORS,
  productUnit: 'pcs',
  productName: 'Knitted garments',
  contractKva: 2600,
  climate: { meanTempC: 29.5, diurnalSwingC: 7.5, meanRh: 64, monsoonBias: 0.22 },
});

/* ========================================================================== */
/* SITE B — Industrial Printing Hub, Rajajinagar, Bengaluru                   */
/* ========================================================================== */

const RJN_FLOORS: readonly FloorDef[] = Object.freeze([
  { index: 0, pill: 'L1', name: 'Press Hall', caption: 'Offset presses · ink · HT intake' },
  { index: 1, pill: 'L2', name: 'Bindery', caption: 'Prepress · binding · finishing' },
  { index: 2, pill: 'L3', name: 'Dispatch', caption: 'Paper store · QA · dispatch' },
]);

const RJN_ZONES: readonly ZoneDef[] = Object.freeze([
  { id: 'press', label: 'A1 · PRESS HALL', floor: 0, bounds: [-13, -9, 3, 9], tone: '#dceaf7' },
  { id: 'ink', label: 'A2 · INK & SOLVENT', floor: 0, bounds: [3, -9, 9, 9], tone: '#d7e8f6' },
  { id: 'sub', label: 'A3 · HT SUBSTATION', floor: 0, bounds: [9, -9, 13, 9], tone: '#d2e5f4' },
  { id: 'prepress', label: 'B1 · PREPRESS', floor: 1, bounds: [-13, -9, -4, 9], tone: '#e8f3fc' },
  { id: 'bind', label: 'B2 · BINDERY', floor: 1, bounds: [-4, -9, 5, 9], tone: '#e4f1fb' },
  { id: 'finish', label: 'B3 · FINISHING', floor: 1, bounds: [5, -9, 13, 9], tone: '#dfeef9' },
  { id: 'paper', label: 'C1 · PAPER STORE', floor: 2, bounds: [-13, -9, -2, 9], tone: '#e4f1fb' },
  { id: 'qa', label: 'C2 · QUALITY', floor: 2, bounds: [-2, -9, 6, 9], tone: '#e8f3fc' },
  { id: 'disp', label: 'C3 · DISPATCH', floor: 2, bounds: [6, -9, 13, 9], tone: '#d2e5f4' },
]);

const RJN_MACHINES: readonly MachineDef[] = Object.freeze([
  /* ---- Ground ---- */
  {
    id: 'PRS-01', name: '6-Colour Offset Press', kind: 'press', zone: 'press', floor: 0,
    position: [-6.4, 0, -5.4], size: [7.2, 2.4, 2.6], rotation: 0,
    nominalTempC: 43, nominalDb: 86, nominalRpm: 15000, cycleSeconds: 18, ratedKw: 128, yieldPerCycle: 180,
  },
  {
    id: 'PRS-02', name: '4-Colour Offset Press', kind: 'press', zone: 'press', floor: 0,
    position: [-6.4, 0, 1.6], size: [5.4, 2.2, 2.4], rotation: 0,
    nominalTempC: 41, nominalDb: 83, nominalRpm: 12000, cycleSeconds: 22, ratedKw: 94, yieldPerCycle: 140,
  },
  {
    id: 'DGP-01', name: 'Digital Web Press', kind: 'press', zone: 'press', floor: 0,
    position: [-2.0, 0, 6.8], size: [4.4, 1.8, 1.6], rotation: 0,
    nominalTempC: 48, nominalDb: 71, nominalRpm: 0, cycleSeconds: 12, ratedKw: 36, yieldPerCycle: 90,
  },

  /* ---- First ---- */
  {
    id: 'CTP-01', name: 'Computer-to-Plate Setter', kind: 'prepress', zone: 'prepress', floor: 1,
    position: [-10.0, 0, -5.0], size: [2.6, 1.6, 1.8], rotation: 0,
    nominalTempC: 29, nominalDb: 52, nominalRpm: 0, cycleSeconds: 72, ratedKw: 5, yieldPerCycle: 2,
  },
  {
    id: 'CTP-02', name: 'Plate Processor', kind: 'prepress', zone: 'prepress', floor: 1,
    position: [-10.0, 0, 3.4], size: [2.8, 1.3, 1.6], rotation: 0,
    nominalTempC: 34, nominalDb: 49, nominalRpm: 0, cycleSeconds: 54, ratedKw: 8, yieldPerCycle: 3,
  },
  {
    id: 'BND-01', name: 'Perfect Binding Line', kind: 'binding', zone: 'bind', floor: 1,
    position: [0.4, 0, -5.0], size: [5.6, 1.7, 1.8], rotation: 0,
    nominalTempC: 86, nominalDb: 77, nominalRpm: 420, cycleSeconds: 21, ratedKw: 33, yieldPerCycle: 75,
  },
  {
    id: 'BND-02', name: 'Saddle Stitcher', kind: 'binding', zone: 'bind', floor: 1,
    position: [0.4, 0, 3.6], size: [3.2, 1.4, 1.6], rotation: 0,
    nominalTempC: 34, nominalDb: 74, nominalRpm: 680, cycleSeconds: 14, ratedKw: 11, yieldPerCycle: 110,
  },
  {
    id: 'LAM-01', name: 'Thermal Laminator', kind: 'laminator', zone: 'finish', floor: 1,
    position: [9.0, 0, -4.6], size: [3.8, 1.5, 1.5], rotation: 0,
    nominalTempC: 118, nominalDb: 64, nominalRpm: 240, cycleSeconds: 29, ratedKw: 41, yieldPerCycle: 60,
  },
  {
    id: 'GUI-01', name: 'Programmatic Guillotine', kind: 'guillotine', zone: 'finish', floor: 1,
    position: [9.0, 0, 3.8], size: [2.4, 1.4, 2.0], rotation: 0,
    nominalTempC: 30, nominalDb: 69, nominalRpm: 0, cycleSeconds: 16, ratedKw: 7, yieldPerCycle: 220,
  },

  /* ---- Second ---- */
  {
    id: 'QCX-03', name: 'Colour Verification Bench', kind: 'inspection', zone: 'qa', floor: 2,
    position: [2.0, 0, -4.2], size: [2.6, 1.3, 1.6], rotation: 0,
    nominalTempC: 27, nominalDb: 42, nominalRpm: 0, cycleSeconds: 15, ratedKw: 3, yieldPerCycle: 120,
  },
  {
    id: 'PKG-02', name: 'Shrink-Wrap & Palletiser', kind: 'packing', zone: 'disp', floor: 2,
    position: [9.4, 0, -3.4], size: [4.2, 1.4, 1.8], rotation: 0,
    nominalTempC: 74, nominalDb: 66, nominalRpm: 300, cycleSeconds: 27, ratedKw: 14, yieldPerCycle: 160,
  },
  {
    id: 'DSP-02', name: 'Dispatch Sorter', kind: 'dispatch', zone: 'disp', floor: 2,
    position: [9.4, 0, 4.4], size: [2.6, 1.2, 3.0], rotation: 0,
    nominalTempC: 29, nominalDb: 58, nominalRpm: 260, cycleSeconds: 20, ratedKw: 8, yieldPerCycle: 190,
  },
]);

const RJN_ENV: readonly EnvNodeDef[] = Object.freeze([
  {
    id: 'VOC-01', name: 'Solvent VOC Scrubber', kind: 'voc', floor: 0,
    position: [6.0, 0, -4.6], size: [2.2, 3.0, 2.2],
    caption: 'Carbon bed · press-hall extraction',
  },
  {
    id: 'PWR-01', name: 'HT Substation Intake', kind: 'power', floor: 0,
    position: [11.0, 0, 2.0], size: [2.6, 2.6, 2.8],
    caption: '11 kV intake · demand and power factor',
  },
  {
    id: 'DST-01', name: 'Paper-Dust Extraction', kind: 'dust', floor: 1,
    position: [4.6, 0, 7.4], size: [2.6, 2.6, 1.8],
    caption: 'Cyclone + HEPA · guillotine and bindery',
  },
]);

const RJN_ROUTES: readonly RouteDef[] = Object.freeze([
  {
    id: 'r-press-a', label: 'Press hall north', floor: 0,
    waypoints: [[-6.4, -2.6], [-1.6, -2.6], [-1.6, -7.8], [-11.0, -7.8], [-11.4, -2.0]],
    stations: [0, 2],
  },
  {
    id: 'r-press-b', label: 'Press hall south', floor: 0,
    waypoints: [[-6.4, 4.4], [-2.0, 6.8], [1.0, 6.0], [1.0, -0.4], [-9.8, -0.4]],
    stations: [0, 1, 3],
  },
  {
    id: 'r-utility', label: 'Ink and intake', floor: 0,
    waypoints: [[6.0, -2.0], [11.0, 2.0], [11.6, 7.0], [5.0, 7.4], [4.4, -7.0]],
    stations: [0, 1, 3],
  },
  {
    id: 'r-prepress', label: 'Prepress bay', floor: 1,
    waypoints: [[-10.0, -2.6], [-10.0, 3.4], [-6.0, 6.4], [-6.0, -7.2], [-12.0, -7.4]],
    stations: [0, 1, 3],
  },
  {
    id: 'r-bindery', label: 'Bindery loop', floor: 1,
    waypoints: [[0.4, -2.6], [0.4, 3.6], [3.6, 6.6], [-2.6, 6.6], [-2.6, -7.0]],
    stations: [0, 1, 3],
  },
  {
    id: 'r-finish', label: 'Finishing loop', floor: 1,
    waypoints: [[9.0, -2.0], [9.0, 3.8], [11.8, 6.8], [11.8, -7.0], [6.4, -6.6]],
    stations: [0, 1, 3],
  },
  {
    id: 'r-paper', label: 'Paper store', floor: 2,
    waypoints: [[-10.6, -5.4], [-10.6, 5.4], [-5.0, 7.0], [-5.0, -7.0], [-12.2, -7.2]],
    stations: [0, 1, 3],
  },
  {
    id: 'r-qa', label: 'Quality bench', floor: 2,
    waypoints: [[2.0, -2.0], [4.4, 1.0], [4.4, 7.0], [-0.6, 7.0], [-0.6, -6.6]],
    stations: [0, 2, 3],
  },
  {
    id: 'r-dispatch', label: 'Dispatch spine', floor: 2,
    waypoints: [[9.4, -1.2], [9.4, 4.4], [12.0, 7.4], [7.0, 7.4], [6.8, -6.8]],
    stations: [0, 1, 3],
  },
]);

const RJN_SECTORS: readonly SectorDef[] = Object.freeze([
  { id: 'press', label: 'Press Operators', floor: 0, headcount: 370, shiftFactor: 0.85 },
  { id: 'ink', label: 'Ink & Solvent', floor: 0, headcount: 70, shiftFactor: 0.66 },
  { id: 'prepress', label: 'Prepress & Plates', floor: 1, headcount: 95, shiftFactor: 0.8 },
  { id: 'bindery', label: 'Bindery', floor: 1, headcount: 285, shiftFactor: 0.83 },
  { id: 'finishing', label: 'Finishing', floor: 1, headcount: 210, shiftFactor: 0.81 },
  { id: 'warehouse', label: 'Paper & Dispatch', floor: 2, headcount: 120, shiftFactor: 0.76 },
]);

export const RAJAJINAGAR: SiteDef = Object.freeze({
  id: 'rajajinagar',
  kind: 'printing',
  name: 'Industrial Printing Hub',
  shortName: 'RAJAJINAGAR PRINT',
  city: 'Rajajinagar, Bengaluru',
  lat: 12.9916,
  lon: 77.5522,
  alt: 912,
  shell: { width: 28, depth: 20, floorHeight: 4.9, wallThickness: 0.26, modelUrl: '/models/factory.glb' },
  floors: RJN_FLOORS,
  zones: RJN_ZONES,
  machines: RJN_MACHINES,
  routes: RJN_ROUTES,
  envNodes: RJN_ENV,
  sectors: RJN_SECTORS,
  productUnit: 'impr',
  productName: 'Printed impressions',
  contractKva: 1800,
  climate: { meanTempC: 26.0, diurnalSwingC: 9.0, meanRh: 56, monsoonBias: 0.16 },
});

/* ========================================================================== */
/* Registry                                                                   */
/* ========================================================================== */

export const SITES: Record<SiteId, SiteDef> = Object.freeze({
  tiruppur: TIRUPPUR,
  rajajinagar: RAJAJINAGAR,
});

export const SITE_IDS: readonly SiteId[] = Object.freeze(['tiruppur', 'rajajinagar']);

/** Total headcount across both nodes — the "3,000 person mob" on the HUD. */
export const TOTAL_HEADCOUNT = SITE_IDS.reduce(
  (sum, id) => sum + SITES[id].sectors.reduce((s, sec) => s + sec.headcount, 0),
  0,
);

/** Is this string a site id we know? Used when hydrating from the URL. */
export function isSiteId(v: unknown): v is SiteId {
  return typeof v === 'string' && (SITE_IDS as readonly string[]).includes(v);
}

/**
 * Parse a floor from a URL parameter. Accepts 0/1/2 and the friendlier 1/2/3
 * that people actually type, plus 'all'. Anything else is 'all'.
 */
export function parseFloorParam(v: string | null | undefined): FloorSelection {
  if (!v) return 'all';
  const s = v.trim().toLowerCase();
  if (s === 'all' || s === '*') return 'all';
  const n = Number(s);
  if (!Number.isFinite(n)) return 'all';
  // `?floor=2` from an investor means "the second floor", i.e. index 1 is
  // ambiguous — so accept both conventions: 0-2 as index, 3 as top floor.
  if (n >= 0 && n <= 2) return n as FloorIndex;
  if (n === 3) return 2;
  return 'all';
}

/* ========================================================================== */
/* Macro layer                                                               */
/* ========================================================================== */

export interface MacroNode {
  readonly id: string;
  readonly label: string;
  readonly lat: number;
  readonly lon: number;
  readonly kind: 'supplier' | 'customer' | 'hub';
  readonly volume: number;
}

export const MACRO_NODES: readonly MacroNode[] = Object.freeze([
  { id: 'coimbatore', label: 'Coimbatore Cotton', lat: 11.0168, lon: 76.9558, kind: 'supplier', volume: 1420 },
  { id: 'chennai', label: 'Chennai Port', lat: 13.0827, lon: 80.2707, kind: 'hub', volume: 2140 },
  { id: 'kochi', label: 'Kochi Pigments', lat: 9.9312, lon: 76.2673, kind: 'supplier', volume: 540 },
  { id: 'mumbai', label: 'Mumbai Freight', lat: 19.076, lon: 72.8777, kind: 'hub', volume: 1980 },
  { id: 'delhi', label: 'Delhi Retail', lat: 28.6139, lon: 77.209, kind: 'customer', volume: 1620 },
  { id: 'singapore', label: 'Singapore Export', lat: 1.3521, lon: 103.8198, kind: 'customer', volume: 3050 },
]);

export const INTER_SITE_LANE = Object.freeze({
  id: 'inter-site',
  label: 'TIRUPPUR ↔ RAJAJINAGAR',
  from: 'tiruppur' as SiteId,
  to: 'rajajinagar' as SiteId,
  distanceKm: 298,
  meanSpeedKph: 46,
});

/* ========================================================================== */
/* Status palette (light theme — contrast tuned against white panels)         */
/* ========================================================================== */

export const STATUS_COLOR: Record<MachineStatus, string> = {
  nominal: '#0c9183',
  warning: '#c57600',
  critical: '#d13a57',
  jammed: '#a3338f',
  idle: '#86a8bd',
};

export const STATUS_COLOR_HEX: Record<MachineStatus, number> = {
  nominal: 0x0c9183,
  warning: 0xc57600,
  critical: 0xd13a57,
  jammed: 0xa3338f,
  idle: 0x86a8bd,
};

export const PILLAR_COLOR: Record<Pillar, string> = {
  mob: '#1a8fd1',
  inventory: '#5b55c9',
  product: '#0c9183',
  machinery: '#2b6fb0',
  qa: '#0f7f9e',
  logistics: '#7a52c4',
  utility: '#c57600',
  environment: '#1d9465',
};

export const OPERATOR_NAMES: readonly string[] = Object.freeze([
  'R. Iyer', 'S. Kulkarni', 'A. Fernandes', 'M. Reddy', 'P. Nair', 'D. Bose',
  'K. Venkatesh', 'N. Dsouza', 'T. Shetty', 'L. Mathew', 'H. Gowda', 'V. Pillai',
  'J. Abraham', 'C. Rao', 'B. Saravanan', 'G. Lakshmi', 'U. Thangam', 'E. Velan',
  'F. Meera', 'Q. Rahman', 'W. Devi', 'Y. Prasad', 'Z. Anand', 'X. Kavitha',
]);
