/**
 * THE MACHINE INVENTORY — nut-and-bolt archetypes
 *
 * ============================================================================
 * WHAT THIS FILE IS FOR
 * ============================================================================
 * `lib/sites.ts` says WHERE a machine stands and how much power it draws.
 * This file says what it IS: the actual mechanism, part by part, with the axis
 * each part moves on and the amplitude it moves through.
 *
 * It exists because the deep-dive X-ray view cannot be hand-authored per
 * machine — there are 27 of them across two sites. Instead every machine
 * resolves to an ARCHETYPE, and `DeepDiveXRay` walks the archetype's part
 * list and builds the mechanism from it. Adding a new press is a data edit,
 * not a new component.
 *
 * ============================================================================
 * THE PHYSICS CONTRACT — READ THIS BEFORE CHANGING A `motion` BLOCK
 * ============================================================================
 * Every driven part declares an axis and an amplitude. It does NOT declare a
 * speed, a period, or a timer. There is no clock in this file.
 *
 * At render time each driven part is evaluated as:
 *
 *     value = profile(kin) * amplitude
 *
 * where `kin` is the machine's kinematic phase accumulator, owned by the
 * store and advanced by `stepKinematics` — the same variable that increments
 * `unitsBuilt`. So a part cannot move unless the machine is producing, and it
 * cannot stop while the machine is producing. They are the same number.
 *
 * This is the whole reason the product count is defensible: jam the machine
 * and `strokeHz` goes to zero, so `kin` stops advancing, so every bolt in
 * this catalogue freezes on the same frame the counter does.
 *
 * Axis conventions, in the machine's own local space (after `def.rotation`):
 *   - a press/anilox/impression cylinder turns about Z  (`rotate-z`)
 *   - a spindle, rotor or vertical shaft turns about Y   (`rotate-y`)
 *   - a carding cylinder or bobbin hook turns about X    (`rotate-x`)
 *   - a needle bar, blade or platen moves on Y           (`translate-y`)
 *   - a gantry, carriage or rapier moves on X            (`translate-x`)
 * ============================================================================
 */

import type { KinematicKind, MachineDef, MachineKind } from '@/lib/sites';

/* -------------------------------------------------------------------------- */
/* Motion                                                                      */
/* -------------------------------------------------------------------------- */

export type MotionAxis =
  | 'rotate-x'
  | 'rotate-y'
  | 'rotate-z'
  | 'translate-x'
  | 'translate-y'
  | 'translate-z';

/**
 * How phase maps to displacement. These are the shapes real mechanisms make,
 * and picking the wrong one is immediately visible — a needle bar on `linear`
 * looks like a drill, a cylinder on `triangle` looks like it is rocking.
 */
export type MotionProfile =
  /** Monotonic: one full revolution per stroke. Cylinders, rollers, spindles. */
  | 'linear'
  /** Snap down, ease back. Sewing needle bars and punch presses. */
  | 'needle'
  /** Out and back, constant speed. Gantries, rapiers, carriages. */
  | 'triangle'
  /** Dwell, then a fast move, then dwell. Platens, guillotine blades, grippers. */
  | 'cam'
  /** Smooth reciprocation. Take-up levers, ring rails, reed beat-up. */
  | 'sine';

export interface PartMotion {
  readonly axis: MotionAxis;
  /** Radians for a rotation, metres for a translation. */
  readonly amplitude: number;
  readonly profile: MotionProfile;
  /**
   * Phase offset, in strokes. A six-colour press has its units offset so the
   * sheet is gripped by one while the next is still inking.
   */
  readonly offset?: number;
  /** Multiplies the phase. 6 means this part turns six times per stroke. */
  readonly ratio?: number;
}

/* -------------------------------------------------------------------------- */
/* Parts                                                                       */
/* -------------------------------------------------------------------------- */

export type PartShape = 'box' | 'cylinder' | 'sphere' | 'cone' | 'torus';

/**
 * Finishes, not colours. The X-ray view picks the actual material from these
 * so a steel shaft and a rubber nip roller never end up looking the same.
 */
export type PartFinish =
  | 'castIron'
  | 'steel'
  | 'chrome'
  | 'rubber'
  | 'brass'
  | 'copper'
  | 'housing'
  | 'glass'
  | 'emissive';

export interface MechanismPart {
  readonly id: string;
  /** Shown on the blueprint callout when this part is the tracked one. */
  readonly label: string;
  readonly shape: PartShape;
  /** Geometry args, passed straight through to the three.js constructor. */
  readonly args: readonly number[];
  readonly position: readonly [number, number, number];
  readonly rotation?: readonly [number, number, number];
  readonly finish: PartFinish;
  /** Absent means structural: it holds still and the moving parts hang off it. */
  readonly motion?: PartMotion;
  /**
   * Bolted flange: draws a ring of `count` hex heads of this radius around the
   * part's local origin. This is the "nut and bolt" in nut-and-bolt.
   */
  readonly bolts?: { readonly count: number; readonly radius: number; readonly plane: 'xy' | 'xz' };
}

/* -------------------------------------------------------------------------- */
/* Faults                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The fault the diagnostic HUD points at. Keyed to a part id so the callout
 * lands on the actual geometry rather than floating in the middle of the
 * machine.
 */
export interface FaultSpec {
  readonly code: string;
  readonly label: string;
  /** Which part is at fault. Must match a `MechanismPart.id`. */
  readonly partId: string;
  /** What the operator is told to do. */
  readonly remedy: string;
  /** Why the tracker loses lock when this fault is active. */
  readonly lockEffect: string;
}

/* -------------------------------------------------------------------------- */
/* Archetype                                                                   */
/* -------------------------------------------------------------------------- */

export interface MachineArchetype {
  /** Short code for the blueprint header. */
  readonly code: string;
  readonly label: string;
  readonly category: 'printing' | 'textile';
  /** Plausible OEM, for the spec plate. */
  readonly oem: string;
  readonly kinematic: KinematicKind;
  /**
   * The part the vision model is actually watching, and the axis it watches it
   * on. This is the sentence the investor hears during the demo.
   */
  readonly tracked: { readonly partId: string; readonly axisNote: string };
  readonly parts: readonly MechanismPart[];
  readonly faults: readonly FaultSpec[];
  /** Spec plate rows: [label, value]. */
  readonly plate: readonly (readonly [string, string])[];
  /**
   * Optional high-fidelity asset. When present the X-ray view loads it inside
   * a <Suspense> boundary and swaps it in for the primitive mechanism; when
   * absent — which is the case for every machine today — the primitives ARE
   * the high-fidelity mesh. See `DeepDiveXRay` for the LOD swap.
   */
  readonly glb?: string;
}

/* ========================================================================== */
/* SHARED GEOMETRY HELPERS                                                    */
/* ========================================================================== */

/** A cylinder lying on its side, turning about Z — i.e. every print roller. */
function roller(
  id: string,
  label: string,
  radius: number,
  length: number,
  position: readonly [number, number, number],
  finish: PartFinish,
  motion?: PartMotion,
  segments = 24,
): MechanismPart {
  return {
    id,
    label,
    shape: 'cylinder',
    args: [radius, radius, length, segments],
    position,
    // A three.js cylinder stands on Y; rotating 90° about X lays it along Z,
    // which is the axis a print cylinder turns on.
    rotation: [Math.PI / 2, 0, 0],
    finish,
    motion,
    bolts: { count: 8, radius: radius * 0.55, plane: 'xy' },
  };
}

/** A drum standing upright, turning about Y — spindles, rotors, vats. */
function drum(
  id: string,
  label: string,
  radius: number,
  height: number,
  position: readonly [number, number, number],
  finish: PartFinish,
  motion?: PartMotion,
  segments = 24,
): MechanismPart {
  return {
    id,
    label,
    shape: 'cylinder',
    args: [radius, radius, height, segments],
    position,
    finish,
    motion,
    bolts: { count: 10, radius: radius * 0.7, plane: 'xz' },
  };
}

/* ========================================================================== */
/* PRINTING ARCHETYPES                                                        */
/* ========================================================================== */

/**
 * A lithographic printing unit: plate cylinder inks up, transfers to the
 * blanket, blanket transfers to the sheet, impression cylinder provides the
 * nip. Three cylinders, all on Z, geared together — which is why they share a
 * ratio and differ only in direction.
 */
function offsetUnit(index: number, x: number): MechanismPart[] {
  const sign = index % 2 === 0 ? 1 : -1;
  const offset = index * 0.11;
  return [
    roller(`u${index}-plate`, `Unit ${index + 1} plate cylinder`, 0.30, 1.9, [x, 1.46, 0], 'chrome', {
      axis: 'rotate-z',
      amplitude: Math.PI * 2,
      profile: 'linear',
      ratio: 1,
      offset,
    }),
    roller(`u${index}-blanket`, `Unit ${index + 1} blanket cylinder`, 0.31, 1.9, [x, 0.84, 0], 'rubber', {
      axis: 'rotate-z',
      amplitude: -Math.PI * 2,
      profile: 'linear',
      ratio: 1,
      offset,
    }),
    roller(`u${index}-impression`, `Unit ${index + 1} impression cylinder`, 0.33, 1.9, [x, 0.22, 0], 'castIron', {
      axis: 'rotate-z',
      amplitude: Math.PI * 2,
      profile: 'linear',
      ratio: 1,
      offset,
    }),
    // Ink train: small, fast, and the thing that smears when it goes wrong.
    roller(`u${index}-ink-a`, `Unit ${index + 1} ink form roller`, 0.12, 1.8, [x - 0.36, 1.92, 0], 'rubber', {
      axis: 'rotate-z',
      amplitude: Math.PI * 2 * 2.5 * sign,
      profile: 'linear',
      ratio: 2.5,
      offset,
    }),
    roller(`u${index}-ink-b`, `Unit ${index + 1} oscillator`, 0.10, 1.7, [x + 0.30, 2.04, 0], 'brass', {
      axis: 'rotate-z',
      amplitude: -Math.PI * 2 * 3,
      profile: 'linear',
      ratio: 3,
      offset,
    }),
    // Dampening fountain, and the ink duct it draws from.
    {
      id: `u${index}-duct`,
      label: `Unit ${index + 1} ink duct`,
      shape: 'box',
      args: [0.46, 0.22, 1.8],
      position: [x, 2.34, 0],
      finish: 'housing',
    },
  ];
}

function offsetPress(colours: 4 | 6): MachineArchetype {
  const pitch = 1.04;
  const span = (colours - 1) * pitch;
  const units: MechanismPart[] = [];
  for (let i = 0; i < colours; i++) units.push(...offsetUnit(i, -span / 2 + i * pitch));

  return {
    code: colours === 6 ? 'OFS-6C' : 'OFS-4C',
    label: `${colours}-Colour Sheetfed Offset Press`,
    category: 'printing',
    oem: 'Heidelberg Speedmaster class',
    kinematic: 'roller',
    tracked: {
      partId: 'u0-impression',
      axisNote: 'Impression cylinder — one revolution about Z per sheet gripped',
    },
    parts: [
      /* ---- structure ---- */
      {
        id: 'bed',
        label: 'Machine bed',
        shape: 'box',
        args: [span + 2.4, 0.26, 2.4],
        position: [0, -0.14, 0],
        finish: 'castIron',
        bolts: { count: 12, radius: 0.9, plane: 'xz' },
      },
      {
        id: 'frame-near',
        label: 'Side frame (operator)',
        shape: 'box',
        args: [span + 2.0, 2.7, 0.18],
        position: [0, 1.2, 1.12],
        finish: 'housing',
      },
      {
        id: 'frame-far',
        label: 'Side frame (drive)',
        shape: 'box',
        args: [span + 2.0, 2.7, 0.18],
        position: [0, 1.2, -1.12],
        finish: 'housing',
      },
      /* ---- feeder and delivery ---- */
      {
        id: 'feeder',
        label: 'Sheet feeder pile',
        shape: 'box',
        args: [1.1, 1.0, 1.9],
        position: [-span / 2 - 1.1, 0.5, 0],
        finish: 'housing',
      },
      {
        id: 'delivery',
        label: 'Delivery pile',
        shape: 'box',
        args: [1.1, 0.8, 1.9],
        position: [span / 2 + 1.1, 0.4, 0],
        finish: 'housing',
      },
      /* ---- the gripper bar that physically moves each sheet ---- */
      {
        id: 'gripper',
        label: 'Gripper bar',
        shape: 'box',
        args: [0.14, 0.10, 1.86],
        position: [0, 0.60, 0],
        finish: 'steel',
        motion: { axis: 'translate-x', amplitude: span * 0.5, profile: 'cam' },
      },
      /* ---- main drive ---- */
      drum('drive-motor', 'Main drive motor', 0.26, 0.56, [span / 2 + 0.5, 0.3, -1.02], 'steel'),
      roller('drive-gear', 'Drive gear train', 0.22, 0.14, [span / 2 + 0.16, 0.22, -1.02], 'brass', {
        axis: 'rotate-z',
        amplitude: Math.PI * 2 * 4,
        profile: 'linear',
        ratio: 4,
      }, 16),
      /* ---- the units ---- */
      ...units,
    ],
    faults: [
      {
        code: 'BLK-WEAR',
        label: 'Blanket packing out of tolerance',
        partId: 'u0-blanket',
        remedy: 'Re-pack blanket to 0.10 mm; verify nip across the barrel',
        lockEffect: 'Cylinder surface velocity drifts from the geared rate',
      },
      {
        code: 'INK-STARVE',
        label: 'Ink duct starving on unit 2',
        partId: 'u1-duct',
        remedy: 'Reset duct keys; check fountain roller sweep',
        lockEffect: 'Density falls below the vision threshold mid-sheet',
      },
      {
        code: 'GRP-TIMING',
        label: 'Gripper bar timing late',
        partId: 'gripper',
        remedy: 'Re-time gripper cam to 14° before transfer',
        lockEffect: 'Sheet arrives off-phase; the counter rejects the stroke',
      },
    ],
    plate: [
      ['Format', '740 × 1050 mm'],
      ['Max speed', colours === 6 ? '18,000 sph' : '15,000 sph'],
      ['Print units', String(colours)],
      ['Tracked axis', 'Z (impression cylinder)'],
    ],
  };
}

const FLEXO: MachineArchetype = {
  code: 'FLX-CI',
  label: 'Central-Impression Flexographic Line',
  category: 'printing',
  oem: 'Bobst / Uteco class',
  kinematic: 'roller',
  tracked: { partId: 'ci-drum', axisNote: 'Central impression drum — one revolution about Z per repeat' },
  parts: [
    {
      id: 'bed',
      label: 'Machine bed',
      shape: 'box',
      args: [4.6, 0.24, 2.2],
      position: [0, -0.12, 0],
      finish: 'castIron',
      bolts: { count: 10, radius: 0.8, plane: 'xz' },
    },
    // One big chilled drum with the colour decks arranged around it. That
    // arrangement is what makes a CI press recognisable.
    roller('ci-drum', 'Central impression drum', 1.0, 1.8, [0, 1.2, 0], 'chrome', {
      axis: 'rotate-z',
      amplitude: Math.PI * 2,
      profile: 'linear',
    }, 36),
    ...[0, 1, 2, 3, 4, 5].map((i) => {
      const a = -Math.PI * 0.62 + (i / 5) * Math.PI * 1.24;
      const r = 1.28;
      return roller(
        `deck-${i}`,
        `Deck ${i + 1} anilox roller`,
        0.21,
        1.7,
        [Math.cos(a) * r, 1.2 + Math.sin(a) * r, 0],
        'copper',
        { axis: 'rotate-z', amplitude: -Math.PI * 2 * 4.8, profile: 'linear', ratio: 4.8, offset: i * 0.08 },
        18,
      );
    }),
    ...[0, 1, 2, 3, 4, 5].map((i) => {
      const a = -Math.PI * 0.62 + (i / 5) * Math.PI * 1.24;
      const r = 1.66;
      return {
        id: `blade-${i}`,
        label: `Deck ${i + 1} doctor blade`,
        shape: 'box' as const,
        args: [0.06, 0.20, 1.7],
        position: [Math.cos(a) * r, 1.2 + Math.sin(a) * r, 0] as [number, number, number],
        rotation: [0, 0, a] as [number, number, number],
        finish: 'steel' as const,
      };
    }),
    drum('unwind', 'Substrate unwind', 0.52, 1.8, [-2.1, 0.6, 0], 'housing', {
      axis: 'rotate-y',
      amplitude: Math.PI * 2 * 0.6,
      profile: 'linear',
      ratio: 0.6,
    }),
    drum('rewind', 'Substrate rewind', 0.46, 1.8, [2.1, 0.6, 0], 'housing', {
      axis: 'rotate-y',
      amplitude: -Math.PI * 2 * 0.7,
      profile: 'linear',
      ratio: 0.7,
    }),
    drum('dryer', 'Inter-deck dryer', 0.3, 1.1, [0, 2.6, 0], 'housing'),
  ],
  faults: [
    {
      code: 'ANX-CLOG',
      label: 'Anilox cells clogged on deck 3',
      partId: 'deck-2',
      remedy: 'Ultrasonic clean the anilox; re-set blade pressure',
      lockEffect: 'Ink transfer falls; the repeat edge stops registering',
    },
    {
      code: 'WEB-TENSION',
      label: 'Web tension oscillating',
      partId: 'unwind',
      remedy: 'Re-calibrate the unwind dancer; check brake torque',
      lockEffect: 'Repeat length varies, so the drum revolution no longer equals one unit',
    },
  ],
  plate: [
    ['Web width', '1,270 mm'],
    ['Max speed', '400 m/min'],
    ['Decks', '6'],
    ['Tracked axis', 'Z (CI drum)'],
  ],
};

const DIECUT: MachineArchetype = {
  code: 'DCT-RTY',
  label: 'Rotary Die-Cutting & Creasing Station',
  category: 'printing',
  oem: 'Bobst Mastercut class',
  kinematic: 'roller',
  tracked: { partId: 'die-cyl', axisNote: 'Die cylinder — one revolution about Z per blank cut' },
  parts: [
    {
      id: 'bed',
      label: 'Machine bed',
      shape: 'box',
      args: [3.2, 0.24, 1.8],
      position: [0, -0.12, 0],
      finish: 'castIron',
      bolts: { count: 10, radius: 0.7, plane: 'xz' },
    },
    {
      id: 'frame-near',
      label: 'Side frame',
      shape: 'box',
      args: [2.8, 2.0, 0.16],
      position: [0, 0.9, 0.82],
      finish: 'housing',
    },
    {
      id: 'frame-far',
      label: 'Side frame',
      shape: 'box',
      args: [2.8, 2.0, 0.16],
      position: [0, 0.9, -0.82],
      finish: 'housing',
    },
    roller('die-cyl', 'Rotary die cylinder', 0.42, 1.5, [0, 1.18, 0], 'steel', {
      axis: 'rotate-z',
      amplitude: Math.PI * 2,
      profile: 'linear',
    }, 28),
    // The cutting rules standing proud of the die cylinder: eight blades in a
    // ring, so you can see which one is in the nip.
    ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
      const a = (i / 8) * Math.PI * 2;
      return {
        id: `rule-${i}`,
        label: `Cutting rule ${i + 1}`,
        shape: 'box' as const,
        args: [0.035, 0.12, 1.42],
        position: [Math.cos(a) * 0.46, 1.18 + Math.sin(a) * 0.46, 0] as [number, number, number],
        rotation: [0, 0, a] as [number, number, number],
        finish: 'chrome' as const,
        motion: { axis: 'rotate-z' as const, amplitude: Math.PI * 2, profile: 'linear' as const },
      };
    }),
    roller('anvil', 'Hardened anvil roller', 0.40, 1.5, [0, 0.34, 0], 'chrome', {
      axis: 'rotate-z',
      amplitude: -Math.PI * 2 * 1.05,
      profile: 'linear',
      ratio: 1.05,
    }, 24),
    roller('feed', 'Infeed nip', 0.14, 1.4, [-1.24, 0.76, 0], 'rubber', {
      axis: 'rotate-z',
      amplitude: Math.PI * 2 * 3,
      profile: 'linear',
      ratio: 3,
    }, 14),
    {
      id: 'stripper',
      label: 'Stripping station',
      shape: 'box',
      args: [0.7, 0.5, 1.4],
      position: [1.3, 0.75, 0],
      finish: 'housing',
      motion: { axis: 'translate-y', amplitude: 0.1, profile: 'cam' },
    },
  ],
  faults: [
    {
      code: 'RULE-DULL',
      label: 'Cutting rule height loss',
      partId: 'rule-0',
      remedy: 'Re-shim the rule to 23.8 pt; inspect the anvil for tracking',
      lockEffect: 'Blanks stay attached, so the separation event never fires',
    },
    {
      code: 'ANV-SCORE',
      label: 'Anvil scored at 420 mm',
      partId: 'anvil',
      remedy: 'Index the anvil 3 mm axially; schedule regrind',
      lockEffect: 'Intermittent cut depth breaks the per-revolution count',
    },
  ],
  plate: [
    ['Max sheet', '1,600 × 1,200 mm'],
    ['Max speed', '9,000 sph'],
    ['Nip force', '300 t'],
    ['Tracked axis', 'Z (die cylinder)'],
  ],
};

const PASTING: MachineArchetype = {
  code: 'PST-CIN',
  label: 'Case-In Gluing & Pasting Machine',
  category: 'printing',
  oem: 'Kolbus class',
  kinematic: 'roller',
  tracked: { partId: 'glue-roller', axisNote: 'Glue applicator roller — one revolution about Z per spine' },
  parts: [
    {
      id: 'bed',
      label: 'Machine bed',
      shape: 'box',
      args: [3.8, 0.22, 1.7],
      position: [0, -0.11, 0],
      finish: 'castIron',
      bolts: { count: 10, radius: 0.8, plane: 'xz' },
    },
    {
      id: 'pot',
      label: 'Hot-melt glue pot',
      shape: 'box',
      args: [0.9, 0.5, 1.2],
      position: [-0.2, 0.3, 0],
      finish: 'housing',
    },
    roller('glue-roller', 'Glue applicator roller', 0.22, 1.1, [-0.2, 0.68, 0], 'brass', {
      axis: 'rotate-z',
      amplitude: Math.PI * 2,
      profile: 'linear',
    }, 20),
    roller('doctor', 'Metering roller', 0.11, 1.1, [0.18, 0.80, 0], 'steel', {
      axis: 'rotate-z',
      amplitude: -Math.PI * 2 * 2,
      profile: 'linear',
      ratio: 2,
    }, 14),
    // The clamp that actually presses the case onto the block.
    {
      id: 'clamp',
      label: 'Building-in clamp',
      shape: 'box',
      args: [0.8, 0.34, 1.0],
      position: [1.3, 1.02, 0],
      finish: 'steel',
      motion: { axis: 'translate-y', amplitude: -0.30, profile: 'cam' },
      bolts: { count: 6, radius: 0.28, plane: 'xz' },
    },
    {
      id: 'anvil-plate',
      label: 'Forming anvil',
      shape: 'box',
      args: [0.8, 0.14, 1.0],
      position: [1.3, 0.5, 0],
      finish: 'castIron',
    },
    {
      id: 'chain',
      label: 'Book-block transport chain',
      shape: 'box',
      args: [3.4, 0.08, 0.16],
      position: [0, 0.46, 0.62],
      finish: 'steel',
      motion: { axis: 'translate-x', amplitude: 0.34, profile: 'triangle' },
    },
    drum('drive-motor', 'Drive motor', 0.22, 0.48, [-1.6, 0.26, -0.7], 'steel'),
  ],
  faults: [
    {
      code: 'GLU-TEMP',
      label: 'Glue pot 14 °C below set point',
      partId: 'pot',
      remedy: 'Check the cartridge heater and the RTD in zone 2',
      lockEffect: 'Cold adhesive strings, so the spine edge blurs for the tracker',
    },
    {
      code: 'CLMP-DWELL',
      label: 'Clamp dwell too short',
      partId: 'clamp',
      remedy: 'Extend the building-in dwell to 1.8 s',
      lockEffect: 'The press event is too brief to register as a completed case',
    },
  ],
  plate: [
    ['Max speed', '3,000 cycles/h'],
    ['Block thickness', '3 – 70 mm'],
    ['Adhesive', 'EVA hot-melt, 165 °C'],
    ['Tracked axis', 'Z (applicator roller)'],
  ],
};

const CTP: MachineArchetype = {
  code: 'CTP-TH',
  label: 'Thermal Computer-to-Plate Setter',
  category: 'printing',
  oem: 'Kodak Magnus class',
  kinematic: 'gantry',
  tracked: { partId: 'carriage', axisNote: 'Imaging carriage — one traverse along X per plate' },
  parts: [
    {
      id: 'cabinet',
      label: 'Enclosure',
      shape: 'box',
      args: [2.4, 1.5, 1.7],
      position: [0, 0.75, 0],
      finish: 'housing',
      bolts: { count: 8, radius: 0.9, plane: 'xz' },
    },
    drum('plate-drum', 'External plate drum', 0.46, 1.5, [0, 1.0, 0], 'chrome', {
      axis: 'rotate-y',
      amplitude: Math.PI * 2 * 12,
      profile: 'linear',
      ratio: 12,
    }, 28),
    {
      id: 'carriage',
      label: 'Imaging carriage',
      shape: 'box',
      args: [0.3, 0.26, 0.42],
      position: [0, 1.0, 0.72],
      finish: 'steel',
      motion: { axis: 'translate-x', amplitude: 0.92, profile: 'triangle' },
      bolts: { count: 4, radius: 0.12, plane: 'xy' },
    },
    {
      id: 'laser',
      label: 'Thermal laser head (830 nm)',
      shape: 'cylinder',
      args: [0.05, 0.05, 0.22, 12],
      position: [0, 1.0, 0.56],
      rotation: [Math.PI / 2, 0, 0],
      finish: 'emissive',
      motion: { axis: 'translate-x', amplitude: 0.92, profile: 'triangle' },
    },
    {
      id: 'rail',
      label: 'Linear rail',
      shape: 'box',
      args: [2.1, 0.07, 0.1],
      position: [0, 1.0, 0.84],
      finish: 'chrome',
    },
    {
      id: 'loader',
      label: 'Plate autoloader',
      shape: 'box',
      args: [0.5, 1.1, 1.5],
      position: [-1.42, 0.55, 0],
      finish: 'housing',
    },
  ],
  faults: [
    {
      code: 'FOCUS-DRIFT',
      label: 'Focus drift on the outer 40 mm',
      partId: 'laser',
      remedy: 'Re-zero the autofocus; clean the window',
      lockEffect: 'Plate edge imaging fails, so the traverse completes without a plate event',
    },
    {
      code: 'RAIL-DEBRIS',
      label: 'Debris on the linear rail',
      partId: 'rail',
      remedy: 'Clean and re-grease the rail; check the bellows',
      lockEffect: 'Carriage stutters, breaking the single-traverse-per-plate rule',
    },
  ],
  plate: [
    ['Plate format', '1,160 × 940 mm'],
    ['Resolution', '2,400 dpi'],
    ['Throughput', '30 plates/h'],
    ['Tracked axis', 'X (imaging carriage)'],
  ],
};

const GUILLOTINE: MachineArchetype = {
  code: 'GUI-PRG',
  label: 'Programmatic Guillotine',
  category: 'printing',
  oem: 'Polar class',
  kinematic: 'gantry',
  tracked: { partId: 'blade', axisNote: 'Blade — one descent along Y per cut' },
  parts: [
    {
      id: 'table',
      label: 'Cutting table',
      shape: 'box',
      args: [1.9, 0.9, 1.7],
      position: [0, 0.45, 0],
      finish: 'housing',
      bolts: { count: 10, radius: 0.7, plane: 'xz' },
    },
    {
      id: 'stick',
      label: 'Cutting stick',
      shape: 'box',
      args: [1.7, 0.04, 0.06],
      position: [0, 0.92, 0],
      finish: 'housing',
    },
    {
      id: 'gantry',
      label: 'Blade gantry',
      shape: 'box',
      args: [1.9, 0.24, 0.3],
      position: [0, 1.8, 0],
      finish: 'castIron',
    },
    {
      id: 'clamp',
      label: 'Hydraulic clamp',
      shape: 'box',
      args: [1.7, 0.16, 0.34],
      position: [0, 1.3, 0.22],
      finish: 'steel',
      // The clamp lands before the blade does; a quarter-stroke of lead.
      motion: { axis: 'translate-y', amplitude: -0.32, profile: 'cam', offset: -0.18 },
    },
    {
      id: 'blade',
      label: 'Blade',
      shape: 'box',
      args: [1.68, 0.3, 0.035],
      position: [0, 1.52, -0.06],
      rotation: [0, 0, 0.045],
      finish: 'chrome',
      motion: { axis: 'translate-y', amplitude: -0.56, profile: 'cam' },
      bolts: { count: 6, radius: 0.5, plane: 'xy' },
    },
    drum('ram-left', 'Left ram', 0.09, 0.8, [-0.78, 1.9, 0], 'steel'),
    drum('ram-right', 'Right ram', 0.09, 0.8, [0.78, 1.9, 0], 'steel'),
    {
      id: 'backgauge',
      label: 'Programmed back gauge',
      shape: 'box',
      args: [1.7, 0.1, 0.12],
      position: [0, 0.96, -0.6],
      finish: 'steel',
      motion: { axis: 'translate-z', amplitude: 0.18, profile: 'sine' },
    },
  ],
  faults: [
    {
      code: 'BLD-NICK',
      label: 'Blade nicked 310 mm from the drive end',
      partId: 'blade',
      remedy: 'Rotate to the spare blade; send for regrind',
      lockEffect: 'Partial cuts leave the lift joined, so no separation is seen',
    },
    {
      code: 'CLMP-PRESS',
      label: 'Clamp pressure low',
      partId: 'clamp',
      remedy: 'Bleed the hydraulic circuit; check the accumulator charge',
      lockEffect: 'The lift shifts under the blade and the cut edge moves out of frame',
    },
  ],
  plate: [
    ['Cutting width', '1,370 mm'],
    ['Cutting height', '165 mm'],
    ['Clamp force', '4,000 daN'],
    ['Tracked axis', 'Y (blade descent)'],
  ],
};

/* ========================================================================== */
/* TEXTILE ARCHETYPES                                                         */
/* ========================================================================== */

const SEWING: MachineArchetype = {
  code: 'SEW-LCK',
  label: 'Industrial Lockstitch Station',
  category: 'textile',
  oem: 'Juki DDL class',
  kinematic: 'needle',
  tracked: { partId: 'needle-bar', axisNote: 'Needle bar — one descent along Y per stitch' },
  parts: [
    {
      id: 'table',
      label: 'Table top',
      shape: 'box',
      args: [1.5, 0.05, 0.7],
      position: [0, 0.0, 0],
      finish: 'housing',
    },
    {
      id: 'bed',
      label: 'Machine bed',
      shape: 'box',
      args: [0.56, 0.09, 0.2],
      position: [0, 0.07, 0],
      finish: 'castIron',
      bolts: { count: 4, radius: 0.2, plane: 'xz' },
    },
    {
      id: 'arm',
      label: 'Overhanging arm',
      shape: 'box',
      args: [0.52, 0.17, 0.15],
      position: [-0.06, 0.52, 0],
      finish: 'castIron',
    },
    {
      id: 'pillar',
      label: 'Pillar',
      shape: 'box',
      args: [0.17, 0.42, 0.16],
      position: [-0.26, 0.29, 0],
      finish: 'castIron',
    },
    /* ---- the mechanism: this is what the tracker watches ---- */
    {
      id: 'needle-bar',
      label: 'Needle bar',
      shape: 'cylinder',
      args: [0.016, 0.016, 0.3, 10],
      position: [0.17, 0.4, 0],
      finish: 'chrome',
      motion: { axis: 'translate-y', amplitude: -0.11, profile: 'needle' },
    },
    {
      id: 'needle',
      label: 'Needle (DBx1 #11)',
      shape: 'cylinder',
      args: [0.0045, 0.002, 0.075, 8],
      position: [0.17, 0.215, 0],
      finish: 'chrome',
      motion: { axis: 'translate-y', amplitude: -0.11, profile: 'needle' },
    },
    {
      id: 'presser',
      label: 'Presser foot',
      shape: 'box',
      args: [0.045, 0.014, 0.06],
      position: [0.17, 0.16, 0],
      finish: 'steel',
    },
    {
      id: 'takeup',
      label: 'Thread take-up lever',
      shape: 'box',
      args: [0.11, 0.022, 0.016],
      position: [0.03, 0.60, 0.085],
      finish: 'steel',
      // The take-up runs a half-cycle behind the needle: it pulls the slack
      // out of the stitch as the needle climbs.
      motion: { axis: 'translate-y', amplitude: 0.055, profile: 'sine', offset: 0.5 },
    },
    // The rotary hook below the plate turns twice per stitch — that 2:1 ratio
    // is how a lockstitch actually locks, and it is visible in the X-ray.
    {
      id: 'hook',
      label: 'Rotary hook / bobbin case',
      shape: 'cylinder',
      args: [0.042, 0.042, 0.028, 16],
      position: [0.17, 0.05, 0],
      rotation: [0, 0, Math.PI / 2],
      finish: 'chrome',
      motion: { axis: 'rotate-x', amplitude: Math.PI * 4, profile: 'linear', ratio: 2 },
      bolts: { count: 3, radius: 0.022, plane: 'xy' },
    },
    {
      id: 'feed-dog',
      label: 'Feed dog',
      shape: 'box',
      args: [0.05, 0.01, 0.045],
      position: [0.17, 0.112, 0],
      finish: 'steel',
      motion: { axis: 'translate-x', amplitude: 0.013, profile: 'sine', offset: 0.25 },
    },
    {
      id: 'handwheel',
      label: 'Hand wheel',
      shape: 'cylinder',
      args: [0.075, 0.075, 0.03, 20],
      position: [-0.34, 0.52, 0],
      rotation: [0, 0, Math.PI / 2],
      finish: 'steel',
      motion: { axis: 'rotate-x', amplitude: Math.PI * 2, profile: 'linear' },
    },
    {
      id: 'servo',
      label: 'Direct-drive servo',
      shape: 'cylinder',
      args: [0.07, 0.07, 0.11, 16],
      position: [-0.34, 0.3, -0.1],
      rotation: [0, 0, Math.PI / 2],
      finish: 'steel',
    },
    // Spool pin first, then the cone on top of it — a thread cone hovering
    // unsupported above the arm is the detail that makes the whole machine
    // look like a render instead of a machine.
    {
      id: 'spool-pin',
      label: 'Spool pin',
      shape: 'cylinder',
      args: [0.006, 0.006, 0.26, 6],
      position: [-0.42, 0.72, -0.16],
      finish: 'chrome',
    },
    {
      id: 'spool-base',
      label: 'Spool stand',
      shape: 'box',
      args: [0.09, 0.012, 0.09],
      position: [-0.42, 0.6, -0.16],
      finish: 'steel',
    },
    {
      id: 'thread-cone',
      label: 'Thread cone',
      shape: 'cone',
      args: [0.05, 0.16, 14],
      position: [-0.42, 0.69, -0.16],
      finish: 'housing',
    },
  ],
  faults: [
    {
      code: 'NDL-DEFL',
      label: 'Needle deflection 0.4 mm',
      partId: 'needle',
      remedy: 'Replace the needle; check the presser foot alignment',
      lockEffect: 'Skipped stitches: the needle enters frame but no loop forms',
    },
    {
      code: 'HOOK-TIMING',
      label: 'Hook timing late by 8°',
      partId: 'hook',
      remedy: 'Re-time the hook to meet the needle 2.2 mm above bottom dead centre',
      lockEffect: 'The loop is missed, so the stroke is counted as travel and not as a stitch',
    },
    {
      code: 'TNS-HIGH',
      label: 'Upper thread tension high',
      partId: 'takeup',
      remedy: 'Back the tension disc off a quarter turn',
      lockEffect: 'Puckering changes the fabric edge the tracker keys on',
    },
  ],
  plate: [
    ['Max speed', '5,000 spm'],
    ['Stitch length', '0 – 5 mm'],
    ['Drive', 'Direct-drive AC servo, 550 W'],
    ['Tracked axis', 'Y (needle bar)'],
  ],
};

const BALE_OPENER: MachineArchetype = {
  code: 'BLO-AUT',
  label: 'Automatic Bale Opener',
  category: 'textile',
  oem: 'Trützschler BLENDOMAT class',
  kinematic: 'rotary',
  tracked: { partId: 'plucker', axisNote: 'Plucker roller — one revolution about X per tuft pass' },
  parts: [
    {
      id: 'gantry',
      label: 'Travelling gantry',
      shape: 'box',
      args: [2.6, 0.4, 1.5],
      position: [0, 1.9, 0],
      finish: 'housing',
      bolts: { count: 8, radius: 1.0, plane: 'xz' },
    },
    {
      id: 'tower',
      label: 'Tower column',
      shape: 'box',
      args: [0.34, 1.9, 0.34],
      position: [-1.1, 0.95, 0],
      finish: 'castIron',
    },
    {
      id: 'head',
      label: 'Take-off head',
      shape: 'box',
      args: [1.1, 0.42, 1.25],
      position: [0.2, 0.62, 0],
      finish: 'housing',
      motion: { axis: 'translate-x', amplitude: 0.5, profile: 'triangle' },
    },
    {
      id: 'plucker',
      label: 'Plucker roller',
      shape: 'cylinder',
      args: [0.2, 0.2, 1.2, 20],
      position: [0.2, 0.4, 0],
      rotation: [0, 0, Math.PI / 2],
      finish: 'steel',
      motion: { axis: 'rotate-x', amplitude: Math.PI * 2, profile: 'linear' },
      bolts: { count: 6, radius: 0.12, plane: 'xy' },
    },
    // Tooth rings, so the plucker's rotation is legible on a smooth barrel.
    ...[0, 1, 2, 3, 4].map((i) => ({
      id: `teeth-${i}`,
      label: `Tooth ring ${i + 1}`,
      shape: 'torus' as const,
      args: [0.21, 0.016, 6, 14],
      position: [0.2 - 0.48 + i * 0.24, 0.4, 0] as [number, number, number],
      rotation: [0, Math.PI / 2, 0] as [number, number, number],
      finish: 'chrome' as const,
      motion: { axis: 'rotate-x' as const, amplitude: Math.PI * 2, profile: 'linear' as const },
    })),
    {
      id: 'grid',
      label: 'Grid bar cage',
      shape: 'box',
      args: [1.0, 0.08, 1.2],
      position: [0.2, 0.17, 0],
      finish: 'steel',
    },
    drum('suction', 'Suction duct', 0.24, 1.3, [0.95, 1.2, 0], 'housing'),
  ],
  faults: [
    {
      code: 'TOOTH-WEAR',
      label: 'Tooth ring 3 worn below 4 mm',
      partId: 'teeth-2',
      remedy: 'Replace the tooth ring set; re-set the grid clearance',
      lockEffect: 'Tuft size collapses, so the pass produces no measurable pick',
    },
    {
      code: 'TRAV-STALL',
      label: 'Gantry traverse stalling',
      partId: 'head',
      remedy: 'Check the travel drive brake and the festoon cable',
      lockEffect: 'Without traverse the roller spins over the same spot and the pass never completes',
    },
  ],
  plate: [
    ['Working width', '2,400 mm'],
    ['Output', '1,600 kg/h'],
    ['Take-off depth', '0 – 4 mm per pass'],
    ['Tracked axis', 'X (plucker roller)'],
  ],
};

const CARDING: MachineArchetype = {
  code: 'CRD-HP',
  label: 'High-Production Carding Machine',
  category: 'textile',
  oem: 'Trützschler TC class',
  kinematic: 'rotary',
  tracked: { partId: 'cylinder', axisNote: 'Main cylinder — one revolution about X per sliver segment' },
  parts: [
    {
      id: 'frame',
      label: 'Main frame',
      shape: 'box',
      args: [2.9, 0.3, 1.5],
      position: [0, 0.15, 0],
      finish: 'castIron',
      bolts: { count: 12, radius: 1.0, plane: 'xz' },
    },
    {
      id: 'side-near',
      label: 'Side plate',
      shape: 'box',
      args: [2.6, 1.6, 0.14],
      position: [0, 1.0, 0.68],
      finish: 'housing',
    },
    {
      id: 'side-far',
      label: 'Side plate',
      shape: 'box',
      args: [2.6, 1.6, 0.14],
      position: [0, 1.0, -0.68],
      finish: 'housing',
    },
    // The 1.3 m main cylinder, the single biggest rotating mass in the mill.
    {
      id: 'cylinder',
      label: 'Main cylinder (wire-clothed)',
      shape: 'cylinder',
      args: [0.62, 0.62, 1.2, 32],
      position: [0, 1.0, 0],
      rotation: [0, 0, Math.PI / 2],
      finish: 'steel',
      motion: { axis: 'rotate-x', amplitude: Math.PI * 2, profile: 'linear' },
      bolts: { count: 12, radius: 0.34, plane: 'xy' },
    },
    {
      id: 'cyl-key',
      label: 'Cylinder index mark',
      shape: 'box',
      args: [1.18, 0.02, 0.05],
      position: [0, 1.62, 0],
      finish: 'emissive',
      motion: { axis: 'rotate-x', amplitude: Math.PI * 2, profile: 'linear' },
    },
    {
      id: 'taker-in',
      label: 'Taker-in (licker) roller',
      shape: 'cylinder',
      args: [0.17, 0.17, 1.15, 18],
      position: [-0.92, 0.72, 0],
      rotation: [0, 0, Math.PI / 2],
      finish: 'chrome',
      motion: { axis: 'rotate-x', amplitude: -Math.PI * 2 * 2.4, profile: 'linear', ratio: 2.4 },
    },
    {
      id: 'doffer',
      label: 'Doffer roller',
      shape: 'cylinder',
      args: [0.26, 0.26, 1.15, 20],
      position: [0.94, 0.86, 0],
      rotation: [0, 0, Math.PI / 2],
      finish: 'brass',
      motion: { axis: 'rotate-x', amplitude: -Math.PI * 2 * 1.8, profile: 'linear', ratio: 1.8 },
      bolts: { count: 6, radius: 0.15, plane: 'xy' },
    },
    // Revolving flats across the top of the cylinder: the distinctive arc.
    ...[0, 1, 2, 3, 4, 5, 6].map((i) => {
      const a = -Math.PI * 0.34 + (i / 6) * Math.PI * 0.68;
      return {
        id: `flat-${i}`,
        label: `Revolving flat ${i + 1}`,
        shape: 'box' as const,
        args: [0.1, 0.05, 1.12],
        position: [Math.sin(a) * 0.72, 1.0 + Math.cos(a) * 0.72, 0] as [number, number, number],
        rotation: [0, 0, -a] as [number, number, number],
        finish: 'steel' as const,
      };
    }),
    drum('coiler', 'Sliver coiler can', 0.34, 0.9, [1.42, 0.45, 0], 'housing', {
      axis: 'rotate-y',
      amplitude: Math.PI * 2 * 0.4,
      profile: 'linear',
      ratio: 0.4,
    }),
  ],
  faults: [
    {
      code: 'WIRE-LOAD',
      label: 'Cylinder wire loaded with trash',
      partId: 'cylinder',
      remedy: 'Strip and grind the cylinder wire; check the licker setting',
      lockEffect: 'Web density rises off-scale and the sliver edge is lost',
    },
    {
      code: 'FLAT-SET',
      label: 'Flats setting open at flat 4',
      partId: 'flat-3',
      remedy: 'Re-set the flats to 0.25 mm with the setting gauge',
      lockEffect: 'Neps spike; the quality gate voids the segment count',
    },
  ],
  plate: [
    ['Working width', '1,280 mm'],
    ['Output', '280 kg/h'],
    ['Cylinder speed', '600 rpm'],
    ['Tracked axis', 'X (main cylinder)'],
  ],
};

const RING_SPIN: MachineArchetype = {
  code: 'RSF-LNG',
  label: 'Long-Frame Ring Spinning Machine',
  category: 'textile',
  oem: 'Rieter G 38 class',
  kinematic: 'rotary',
  tracked: { partId: 'spindle-6', axisNote: 'Spindle bank — one revolution about Y per twist insertion' },
  parts: [
    {
      id: 'frame',
      label: 'Machine frame',
      shape: 'box',
      args: [3.4, 0.26, 1.2],
      position: [0, 0.13, 0],
      finish: 'castIron',
      bolts: { count: 12, radius: 1.2, plane: 'xz' },
    },
    {
      id: 'creel',
      label: 'Roving creel',
      shape: 'box',
      args: [3.2, 0.12, 1.0],
      position: [0, 1.62, 0],
      finish: 'housing',
    },
    {
      id: 'drafting',
      label: 'Drafting system',
      shape: 'box',
      args: [3.2, 0.2, 0.34],
      position: [0, 1.12, 0],
      finish: 'housing',
    },
    // The ring rail traverses slowly up and down to build the cop. It is the
    // slowest motion on the machine and the one that shapes the yarn package.
    {
      id: 'ring-rail',
      label: 'Ring rail',
      shape: 'box',
      args: [3.2, 0.07, 0.3],
      position: [0, 0.6, 0],
      finish: 'steel',
      motion: { axis: 'translate-y', amplitude: 0.12, profile: 'sine' },
    },
    // Thirteen spindles. Enough to read as a bank, few enough to stay cheap.
    ...Array.from({ length: 13 }, (_, i) => ({
      id: `spindle-${i}`,
      label: `Spindle ${i + 1}`,
      shape: 'cylinder' as const,
      args: [0.034, 0.028, 0.46, 12],
      position: [-1.44 + i * 0.24, 0.58, 0] as [number, number, number],
      finish: 'chrome' as const,
      motion: {
        axis: 'rotate-y' as const,
        amplitude: Math.PI * 2,
        profile: 'linear' as const,
        // A barber-pole offset so the bank reads as thirteen separate
        // spindles rather than one rigid comb.
        offset: i * 0.035,
      },
    })),
    ...Array.from({ length: 13 }, (_, i) => ({
      id: `cop-${i}`,
      label: `Cop ${i + 1}`,
      shape: 'cone' as const,
      args: [0.048, 0.3, 10],
      position: [-1.44 + i * 0.24, 0.52, 0] as [number, number, number],
      finish: 'housing' as const,
      motion: {
        axis: 'rotate-y' as const,
        amplitude: Math.PI * 2,
        profile: 'linear' as const,
        offset: i * 0.035,
      },
    })),
    drum('tangential-belt', 'Tangential drive belt', 0.06, 0.06, [1.66, 0.58, 0], 'rubber'),
    drum('main-motor', 'Main motor', 0.24, 0.5, [1.74, 0.3, -0.4], 'steel'),
  ],
  faults: [
    {
      code: 'SPDL-VIB',
      label: 'Spindle 7 vibration 4.1 mm/s',
      partId: 'spindle-6',
      remedy: 'Replace the spindle bolster; re-centre the ring',
      lockEffect: 'Twist varies, so revolutions stop mapping to delivered length',
    },
    {
      code: 'RAIL-BIND',
      label: 'Ring rail binding at the top of the lift',
      partId: 'ring-rail',
      remedy: 'Clean and lubricate the lift cams; check the poker bar',
      lockEffect: 'Cop build stalls and the package event never completes',
    },
  ],
  plate: [
    ['Spindles', '1,824'],
    ['Spindle speed', '25,000 rpm'],
    ['Count range', '8 – 80 Ne'],
    ['Tracked axis', 'Y (spindle bank)'],
  ],
};

const LOOM: MachineArchetype = {
  code: 'LOM-RAP',
  label: 'Rapier Weaving Machine',
  category: 'textile',
  oem: 'Picanol OptiMax class',
  kinematic: 'gantry',
  tracked: { partId: 'rapier', axisNote: 'Rapier carrier — one traverse along X per pick inserted' },
  parts: [
    {
      id: 'frame-left',
      label: 'Left side frame',
      shape: 'box',
      args: [0.3, 1.7, 1.5],
      position: [-1.5, 0.85, 0],
      finish: 'castIron',
      bolts: { count: 6, radius: 0.5, plane: 'xy' },
    },
    {
      id: 'frame-right',
      label: 'Right side frame',
      shape: 'box',
      args: [0.3, 1.7, 1.5],
      position: [1.5, 0.85, 0],
      finish: 'castIron',
      bolts: { count: 6, radius: 0.5, plane: 'xy' },
    },
    {
      id: 'warp-beam',
      label: 'Warp beam',
      shape: 'cylinder',
      args: [0.42, 0.42, 2.7, 22],
      position: [0, 0.48, -0.56],
      rotation: [0, 0, Math.PI / 2],
      finish: 'housing',
      motion: { axis: 'rotate-x', amplitude: Math.PI * 0.08, profile: 'linear' },
    },
    {
      id: 'cloth-roll',
      label: 'Cloth take-up roll',
      shape: 'cylinder',
      args: [0.3, 0.3, 2.7, 20],
      position: [0, 0.44, 0.58],
      rotation: [0, 0, Math.PI / 2],
      finish: 'housing',
      motion: { axis: 'rotate-x', amplitude: -Math.PI * 0.11, profile: 'linear' },
    },
    // Beat-up: the reed slams the pick home once per stroke. On a real loom
    // this is the noise you hear from outside the shed.
    {
      id: 'reed',
      label: 'Reed / sley',
      shape: 'box',
      args: [2.6, 0.26, 0.05],
      position: [0, 1.0, 0.1],
      finish: 'steel',
      motion: { axis: 'translate-z', amplitude: 0.17, profile: 'sine' },
      bolts: { count: 8, radius: 0.9, plane: 'xy' },
    },
    // Heald frames open the shed; two frames in opposition is a plain weave.
    {
      id: 'heald-a',
      label: 'Heald frame 1',
      shape: 'box',
      args: [2.5, 0.06, 0.03],
      position: [0, 1.12, -0.18],
      finish: 'steel',
      motion: { axis: 'translate-y', amplitude: 0.14, profile: 'sine' },
    },
    {
      id: 'heald-b',
      label: 'Heald frame 2',
      shape: 'box',
      args: [2.5, 0.06, 0.03],
      position: [0, 0.86, -0.18],
      finish: 'steel',
      motion: { axis: 'translate-y', amplitude: -0.14, profile: 'sine' },
    },
    {
      id: 'rapier',
      label: 'Rapier carrier',
      shape: 'box',
      args: [0.12, 0.05, 0.05],
      position: [0, 1.0, -0.02],
      finish: 'chrome',
      motion: { axis: 'translate-x', amplitude: 1.25, profile: 'triangle' },
    },
    {
      id: 'rapier-tape',
      label: 'Rapier tape',
      shape: 'box',
      args: [1.3, 0.02, 0.02],
      position: [-0.65, 1.0, -0.02],
      finish: 'steel',
      motion: { axis: 'translate-x', amplitude: 1.25, profile: 'triangle' },
    },
    {
      id: 'temple',
      label: 'Temple',
      shape: 'box',
      args: [0.2, 0.08, 0.12],
      position: [1.2, 0.98, 0.26],
      finish: 'brass',
    },
    drum('loom-motor', 'Main motor', 0.22, 0.46, [1.5, 0.3, -0.72], 'steel'),
  ],
  faults: [
    {
      code: 'WEFT-BREAK',
      label: 'Weft break detected at the right selvedge',
      partId: 'rapier',
      remedy: 'Clear the weft; check the cutter and the right gripper spring',
      lockEffect: 'The traverse completes with no yarn, so the pick is correctly NOT counted',
    },
    {
      code: 'SHED-TIMING',
      label: 'Shed closing early',
      partId: 'heald-a',
      remedy: 'Re-time the dobby to close at 320°',
      lockEffect: 'The rapier clips the warp and the insertion is voided',
    },
  ],
  plate: [
    ['Reed width', '1,900 mm'],
    ['Speed', '700 ppm'],
    ['Shedding', 'Electronic dobby, 16 frames'],
    ['Tracked axis', 'X (rapier carrier)'],
  ],
};

const STENTER: MachineArchetype = {
  code: 'STN-RNG',
  label: 'Stenter Drying & Heat-Setting Range',
  category: 'textile',
  oem: 'Brückner POWER-FRAME class',
  kinematic: 'gantry',
  tracked: { partId: 'pin-chain', axisNote: 'Pin chain — one index along X per fabric segment' },
  parts: [
    {
      id: 'chamber',
      label: 'Drying chamber',
      shape: 'box',
      args: [5.0, 1.7, 1.7],
      position: [0, 1.0, 0],
      finish: 'housing',
      bolts: { count: 14, radius: 1.6, plane: 'xz' },
    },
    {
      id: 'pin-chain',
      label: 'Pin chain (near rail)',
      shape: 'box',
      args: [4.8, 0.07, 0.09],
      position: [0, 0.98, 0.72],
      finish: 'steel',
      motion: { axis: 'translate-x', amplitude: 0.36, profile: 'triangle' },
    },
    {
      id: 'pin-chain-far',
      label: 'Pin chain (far rail)',
      shape: 'box',
      args: [4.8, 0.07, 0.09],
      position: [0, 0.98, -0.72],
      finish: 'steel',
      motion: { axis: 'translate-x', amplitude: 0.36, profile: 'triangle' },
    },
    ...[0, 1, 2, 3, 4].map((i) => ({
      id: `fan-${i}`,
      label: `Circulation fan ${i + 1}`,
      shape: 'cylinder' as const,
      args: [0.24, 0.24, 0.1, 14],
      position: [-1.9 + i * 0.95, 1.86, 0] as [number, number, number],
      finish: 'steel' as const,
      motion: {
        axis: 'rotate-y' as const,
        amplitude: Math.PI * 2 * 9,
        profile: 'linear' as const,
        ratio: 9,
        offset: i * 0.13,
      },
    })),
    {
      id: 'fabric',
      label: 'Fabric web',
      shape: 'box',
      args: [4.8, 0.012, 1.3],
      position: [0, 0.96, 0],
      finish: 'rubber',
    },
    {
      id: 'burner',
      label: 'Gas burner bank',
      shape: 'box',
      args: [4.6, 0.2, 0.3],
      position: [0, 0.3, -0.62],
      finish: 'emissive',
    },
    drum('exhaust', 'Exhaust stack', 0.26, 1.2, [1.9, 2.4, 0], 'housing'),
  ],
  faults: [
    {
      code: 'PIN-MISS',
      label: 'Pins not holding the selvedge',
      partId: 'pin-chain',
      remedy: 'Re-set the brush-in wheel; replace the damaged pin plates',
      lockEffect: 'The web wanders, so the segment boundary cannot be fixed',
    },
    {
      code: 'TEMP-ZONE',
      label: 'Zone 3 running 11 °C cold',
      partId: 'burner',
      remedy: 'Check the gas valve and the zone 3 thermocouple',
      lockEffect: 'Set is incomplete and the segment is held back from the count',
    },
  ],
  plate: [
    ['Working width', '2,200 mm'],
    ['Chambers', '6'],
    ['Max temperature', '220 °C'],
    ['Tracked axis', 'X (pin chain)'],
  ],
};

/* ========================================================================== */
/* GENERIC FALLBACK                                                           */
/* ========================================================================== */

/**
 * Machines without a bespoke archetype still need a mechanism in the X-ray
 * view — a clearly generic one, so nobody mistakes it for a real model of a
 * machine we have not drawn.
 */
function generic(kinematic: KinematicKind, label: string, category: 'printing' | 'textile'): MachineArchetype {
  const driven: MechanismPart =
    kinematic === 'needle'
      ? {
          id: 'ram',
          label: 'Reciprocating ram',
          shape: 'box',
          args: [0.18, 0.6, 0.18],
          position: [0, 1.1, 0],
          finish: 'chrome',
          motion: { axis: 'translate-y', amplitude: -0.34, profile: 'needle' },
        }
      : kinematic === 'gantry'
        ? {
            id: 'carriage',
            label: 'Traversing carriage',
            shape: 'box',
            args: [0.4, 0.26, 0.5],
            position: [0, 1.0, 0],
            finish: 'steel',
            motion: { axis: 'translate-x', amplitude: 0.8, profile: 'triangle' },
          }
        : kinematic === 'rotary'
          ? drum('rotor', 'Process rotor', 0.44, 0.9, [0, 1.0, 0], 'steel', {
              axis: 'rotate-y',
              amplitude: Math.PI * 2,
              profile: 'linear',
            })
          : roller('cylinder', 'Process cylinder', 0.36, 1.4, [0, 1.0, 0], 'castIron', {
              axis: 'rotate-z',
              amplitude: Math.PI * 2,
              profile: 'linear',
            });

  return {
    code: 'GEN-' + kinematic.slice(0, 3).toUpperCase(),
    label,
    category,
    oem: 'Generic industrial frame',
    kinematic,
    tracked: {
      partId: driven.id,
      axisNote:
        driven.motion!.axis.startsWith('rotate')
          ? `${driven.label} — rotation about ${driven.motion!.axis.slice(-1).toUpperCase()}`
          : `${driven.label} — translation along ${driven.motion!.axis.slice(-1).toUpperCase()}`,
    },
    parts: [
      {
        id: 'base',
        label: 'Base frame',
        shape: 'box',
        args: [2.0, 0.24, 1.4],
        position: [0, 0.12, 0],
        finish: 'castIron',
        bolts: { count: 8, radius: 0.7, plane: 'xz' },
      },
      {
        id: 'column',
        label: 'Column',
        shape: 'box',
        args: [0.3, 1.5, 0.3],
        position: [-0.74, 0.9, 0],
        finish: 'housing',
      },
      {
        id: 'head',
        label: 'Head casting',
        shape: 'box',
        args: [1.5, 0.28, 0.8],
        position: [0, 1.62, 0],
        finish: 'housing',
      },
      driven,
      drum('motor', 'Drive motor', 0.2, 0.44, [0.78, 0.4, -0.5], 'steel'),
    ],
    faults: [
      {
        code: 'BRG-TEMP',
        label: 'Drive-end bearing running hot',
        partId: 'motor',
        remedy: 'Re-grease and re-check alignment within 24 h',
        lockEffect: 'Speed drops below the tracker’s minimum confidence',
      },
    ],
    plate: [
      ['Class', 'Industrial, continuous duty'],
      ['Tracked axis', driven.motion!.axis.slice(-1).toUpperCase()],
    ],
  };
}

/* ========================================================================== */
/* THE CATALOGUE                                                              */
/* ========================================================================== */

export const ARCHETYPES = {
  'OFS-6C': offsetPress(6),
  'OFS-4C': offsetPress(4),
  'FLX-CI': FLEXO,
  'DCT-RTY': DIECUT,
  'PST-CIN': PASTING,
  'CTP-TH': CTP,
  'GUI-PRG': GUILLOTINE,
  'SEW-LCK': SEWING,
  'BLO-AUT': BALE_OPENER,
  'CRD-HP': CARDING,
  'RSF-LNG': RING_SPIN,
  'LOM-RAP': LOOM,
  'STN-RNG': STENTER,
} as const satisfies Record<string, MachineArchetype>;

export type ArchetypeCode = keyof typeof ARCHETYPES;

/**
 * Machine id prefix to archetype. Checked BEFORE the kind fallback, because
 * `PRS-01` and `PRS-02` are both `kind: 'press'` but one is a six-colour and
 * the other a four — the whole point of the inventory is that they are not
 * the same machine.
 */
const BY_ID: Record<string, ArchetypeCode> = {
  'PRS-01': 'OFS-6C',
  'PRS-02': 'OFS-4C',
  'DGP-01': 'FLX-CI',
  'FLX-01': 'FLX-CI',
  'DCT-01': 'DCT-RTY',
  'PST-01': 'PST-CIN',
  'CTP-01': 'CTP-TH',
  'CTP-02': 'CTP-TH',
  'GUI-01': 'GUI-PRG',
  'STH-01': 'SEW-LCK',
  'STH-02': 'SEW-LCK',
  'STH-03': 'SEW-LCK',
  'BND-02': 'SEW-LCK',
  'BLO-01': 'BLO-AUT',
  'CRD-01': 'CRD-HP',
  'CRD-02': 'CRD-HP',
  'SPN-01': 'RSF-LNG',
  'SPN-02': 'RSF-LNG',
  'LOM-01': 'LOM-RAP',
  'LOM-02': 'LOM-RAP',
  'STN-01': 'STN-RNG',
};

/** Last resort, by machine kind. Keeps every machine divable. */
const BY_KIND: Partial<Record<MachineKind, ArchetypeCode>> = {
  press: 'OFS-4C',
  flexo: 'FLX-CI',
  diecut: 'DCT-RTY',
  pasting: 'PST-CIN',
  prepress: 'CTP-TH',
  guillotine: 'GUI-PRG',
  stitching: 'SEW-LCK',
  baleopener: 'BLO-AUT',
  carding: 'CRD-HP',
  spinning: 'RSF-LNG',
  loom: 'LOM-RAP',
  stenter: 'STN-RNG',
};

const GENERIC_CACHE = new Map<string, MachineArchetype>();

/**
 * The resolver. Every machine in the building gets an archetype, so the deep
 * dive never has to refuse a click.
 */
export function archetypeFor(def: MachineDef, kinematic: KinematicKind): MachineArchetype {
  const byId = BY_ID[def.id];
  if (byId) return ARCHETYPES[byId];

  const byKind = BY_KIND[def.kind];
  if (byKind) return ARCHETYPES[byKind];

  const category: 'printing' | 'textile' =
    def.kind === 'knitting' || def.kind === 'dyeing' ? 'textile' : 'printing';
  const key = `${kinematic}:${category}`;
  let g = GENERIC_CACHE.get(key);
  if (!g) {
    g = generic(kinematic, def.name, category);
    GENERIC_CACHE.set(key, g);
  }
  return g;
}

/* -------------------------------------------------------------------------- */
/* Phase evaluation                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Phase to displacement. Pure, allocation-free, called once per driven part
 * per frame — around 60 times during a deep dive on the six-colour press, so
 * it stays a switch over Math calls and nothing else.
 *
 * `kin` arrives in 0..1 and is the SAME value that drives `unitsBuilt`.
 */
export function evaluateMotion(motion: PartMotion, kin: number): number {
  const ratio = motion.ratio ?? 1;
  // Wrap after the ratio so a 12:1 drum really does turn twelve times.
  let p = (kin + (motion.offset ?? 0)) * ratio;
  p -= Math.floor(p);

  switch (motion.profile) {
    case 'linear':
      // Rotations consume the un-eased phase directly: a cylinder at constant
      // speed is a cylinder at constant speed.
      return p * motion.amplitude;
    case 'needle':
      // 42% of the stroke going down, 58% coming back. Measured off a Juki.
      return (p < 0.42 ? Math.pow(p / 0.42, 0.7) : 1 - Math.pow((p - 0.42) / 0.58, 1.6)) * motion.amplitude;
    case 'triangle':
      return (p < 0.5 ? p * 2 : 2 - p * 2) * motion.amplitude;
    case 'cam': {
      // Dwell 30%, move 25%, dwell 20%, return 25%. Platens and grippers.
      if (p < 0.3) return 0;
      if (p < 0.55) return smootherstep((p - 0.3) / 0.25) * motion.amplitude;
      if (p < 0.75) return motion.amplitude;
      return (1 - smootherstep((p - 0.75) / 0.25)) * motion.amplitude;
    }
    case 'sine':
      return Math.sin(p * Math.PI * 2) * motion.amplitude;
  }
}

/** Quintic ease. Zero velocity AND zero acceleration at both ends. */
function smootherstep(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * c * (c * (c * 6 - 15) + 10);
}

/** Rotations are applied to `rotation`, translations to `position`. */
export function isRotation(axis: MotionAxis): boolean {
  return axis.charCodeAt(0) === 114; /* 'r' */
}

/** 0 = x, 1 = y, 2 = z. */
export function axisIndex(axis: MotionAxis): 0 | 1 | 2 {
  const c = axis.charCodeAt(axis.length - 1);
  return c === 120 ? 0 : c === 121 ? 1 : 2;
}

/* -------------------------------------------------------------------------- */
/* Fitting — shared by the renderer and the camera                            */
/* -------------------------------------------------------------------------- */

/**
 * How far the archetype has to shrink to sit inside the footprint the floor
 * plan reserved for it.
 *
 * Archetypes are authored at REAL scale — a lockstitch bed is 0.56m across
 * because that is how big one is — while `MachineDef.size` is a floor-plan
 * envelope that may be much larger (a "stitching line" is 4.6m of bench with
 * a dozen heads on it). Fitting rather than assuming lets one `SEW-LCK`
 * archetype serve three differently-sized stitching lines.
 *
 * This lives here, next to the geometry it measures, because BOTH the
 * renderer and the camera need the answer and they must not disagree: if the
 * camera computes a different scale from the mechanism, it frames empty air.
 * That is exactly what happened when this was a local `useMemo`.
 */
export function mechanismScale(
  archetype: MachineArchetype,
  size: readonly [number, number, number],
): number {
  let maxX = 0.1;
  let maxY = 0.1;
  let maxZ = 0.1;
  for (const p of archetype.parts) {
    maxX = Math.max(maxX, Math.abs(p.position[0]) + 0.5);
    maxY = Math.max(maxY, p.position[1] + 0.4);
    maxZ = Math.max(maxZ, Math.abs(p.position[2]) + 0.5);
  }
  // Never scale UP past 1.6: a lockstitch head blown up to fill a 4.6m
  // stitching line would be a three-metre sewing machine.
  return Math.min(1.6, (size[0] * 0.5) / maxX, (size[2] * 0.5) / maxZ, size[1] / maxY);
}

/**
 * Where to point the camera, and how tight to frame it.
 *
 * Returns the tracked part's height above the machine's base and a radius
 * describing how big the interesting region around it is — for a needle bar
 * that is a few centimetres, for a central-impression drum it is a metre.
 * Framing off the machine's bounding box instead puts the subject out of
 * shot on anything whose mechanism is small relative to its envelope.
 */
/**
 * The largest real-world dimension of a part, in metres.
 *
 * three.js geometry constructors mix dimensions and tessellation in one
 * argument list — `CylinderGeometry(rTop, rBottom, height, radialSegments)` —
 * so which args are lengths depends on the shape. Getting this wrong is not
 * a subtle error: a 10-segment cylinder reads as ten metres across.
 */
function partExtent(part: MechanismPart): number {
  const a = part.args;
  switch (part.shape) {
    case 'box':
      return Math.max(a[0], a[1], a[2]);
    case 'cylinder':
      // radiusTop, radiusBottom, height — segments are a[3].
      return Math.max(a[0] * 2, a[1] * 2, a[2]);
    case 'sphere':
      return a[0] * 2;
    case 'cone':
      // radius, height — segments are a[2].
      return Math.max(a[0] * 2, a[1]);
    case 'torus':
      // radius, tube — the rest is tessellation.
      return (a[0] + a[1]) * 2;
  }
}

export function trackedFocus(
  archetype: MachineArchetype,
  scale: number,
): { offset: [number, number, number]; radius: number } {
  const part =
    archetype.parts.find((p) => p.id === archetype.tracked.partId) ??
    archetype.parts.find((p) => p.motion) ??
    archetype.parts[0];

  if (!part) return { offset: [0, 0.6, 0], radius: 0.6 };

  /* Largest geometry dimension, as a proxy for how much room the part needs.
   *
   * Only the args that are actually LENGTHS — `partExtent` exists because
   * taking the max over the raw args reads a cylinder's segment count as a
   * dimension. A needle bar declared as [0.016, 0.016, 0.3, 10] came out
   * with an "extent" of 10 metres, which pulled the macro lens back to the
   * clamp and framed the entire machine instead of the needle. */
  let extent = partExtent(part);

  /* A rotating cylinder is framed by its DIAMETER, not its length.
   *
   * An impression cylinder is 0.33m in radius and 1.9m along the barrel.
   * Framing on 1.9m backs the camera off until the whole press is in shot,
   * which is a machine view, not the macro lens the brief asks for — and
   * the barrel length is the one dimension in which nothing visibly happens,
   * because the motion is entirely around the axis. The length still counts
   * for something (you want to see the cylinder is a cylinder), so it is
   * folded in at under half weight rather than dropped. */
  if (part.motion && isRotation(part.motion.axis) && part.shape === 'cylinder') {
    extent = Math.max(part.args[0] * 2, part.args[1] * 2, part.args[2] * 0.45);
  }

  // Travel counts too: a rapier that sweeps 1.25m needs 1.25m of frame, not
  // the 0.12m of the carrier itself.
  const travel = part.motion && !isRotation(part.motion.axis) ? Math.abs(part.motion.amplitude) : 0;

  /* The part's FULL offset, not just its height.
   *
   * A six-colour press declares its tracked impression cylinder on unit 1,
   * 2.6m to the left of the machine's own origin. Returning only the height
   * and letting the camera use the machine's centre for x and z framed the
   * middle of the side frame — correct elevation, wrong end of the press.
   * Scaled here, because the mechanism is drawn scaled. */
  /* Aim halfway between the tracked part and the centre of the mechanism.
   *
   * Dead-centring the tracked part alone is right for a sewing machine,
   * where the needle bar sits in the middle of everything, and wrong for a
   * press, where the tracked impression cylinder is the LOWEST part of unit
   * 1 and six units' worth of mechanism extends up and to the right of it —
   * framing on it put two thirds of the viewport under the machine.
   *
   * Splitting the difference keeps the subject clearly in shot on both, and
   * on a press it brings three of the six printing units into frame, which
   * is the shot you want anyway.
   */
  let cx = 0;
  let cy = 0;
  let cz = 0;
  let n = 0;
  for (const p of archetype.parts) {
    if (!p.motion) continue;
    cx += p.position[0];
    cy += p.position[1];
    cz += p.position[2];
    n++;
  }
  if (n > 0) {
    cx /= n;
    cy /= n;
    cz /= n;
  } else {
    cx = part.position[0];
    cy = part.position[1];
    cz = part.position[2];
  }

  const mid = (a: number, b: number) => (a + b) * 0.5 * scale;

  return {
    offset: [
      mid(part.position[0], cx),
      mid(part.position[1], cy),
      mid(part.position[2], cz),
    ],
    radius: Math.max(0.22, (Math.max(extent, travel) * 1.9 + 0.3) * scale),
  };
}

/* -------------------------------------------------------------------------- */
/* Inventory views, for the HUD                                               */
/* -------------------------------------------------------------------------- */

export interface InventoryRow {
  readonly machineId: string;
  readonly archetype: MachineArchetype;
}

/** Groups a site's machines by archetype, for the inventory panel. */
export function inventoryByArchetype(
  machines: readonly MachineDef[],
  kinematicOf: (def: MachineDef) => KinematicKind,
): { archetype: MachineArchetype; ids: string[] }[] {
  const map = new Map<string, { archetype: MachineArchetype; ids: string[] }>();
  for (const def of machines) {
    const a = archetypeFor(def, kinematicOf(def));
    let row = map.get(a.code);
    if (!row) {
      row = { archetype: a, ids: [] };
      map.set(a.code, row);
    }
    row.ids.push(def.id);
  }
  return [...map.values()];
}
