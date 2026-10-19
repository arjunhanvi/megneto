/**
 * One palette, two renderers.
 *
 * The HUD gets these values through Tailwind (`tailwind.config.ts`), the Cesium
 * globe and the three.js floor get them from here. Keeping the hex in a single
 * module is what stops the canvas and the panels drifting apart as the theme
 * is tuned.
 *
 * Light blue and white: white surfaces, pale-blue washes, deep blue-slate type,
 * and accents chosen to stay legible ON white rather than to glow on black.
 *
 * ============================================================================
 * V7: WHY THE 3D SURFACES ARE NOW DARK AND THE HUD IS NOT
 * ============================================================================
 * The HUD stays light blue and white — it is a document, read at a glance,
 * over a projector. The FLOOR does not.
 *
 * A screen-space ambient occlusion pass has nothing to darken on a #dcea
 * slab, and bloom on a near-white background blooms the background. Both
 * effects need somewhere dark to work against, which is why the hall is now
 * deep slate with bright machines standing in it. The machine bodies, the
 * operators and the accents did NOT change: they are the same light blue and
 * white, now reading as lit metal in a dark building instead of white-on-
 * white. Every value below marked `3D` lives on the canvas side only; the
 * panel chrome comes from `tailwind.config.ts` and is untouched.
 * ============================================================================
 */

export const THEME = {
  /** 3D — canvas clear colour. The hall, seen from across the floor. */
  background: '#0b1a26',
  backgroundDeep: '#06111a',

  surface: '#ffffff',
  surfaceSoft: '#f3f9fe',

  ink: '#0d2b3f',
  inkSoft: '#5b8aa6',

  /** Primary accent. Every line, edge and halo that is not semantic. */
  accent: '#1a8fd1',
  accentSoft: '#8ec3e6',
  accentWash: '#cfe6f7',

  /** 3D surfaces. Dark structure, bright plant — see the note at the top. */
  slab: '#16303f',
  /** Floor grid. Unlit and above the slab's luminance, so bloom catches it. */
  grid: '#3fa7dd',
  gridMinor: '#1d4a63',
  wall: '#102532',
  wallEdge: '#1a8fd1',
  /** Plant stays pale: this is painted sheet steel under high-bay lighting. */
  machineBody: '#e6f0f8',
  machineTrim: '#7fa6c0',
  operator: '#38b6f0',
  helmet: '#ffffff',
  pallet: '#9bb8cc',
} as const;

/**
 * 3D — the industrial envelope. Structure, glazing and the surrounding city,
 * all of which sit BEHIND the plant and must never compete with it.
 */
export const SCENE = {
  /** Fog base. Matches `background`, or the horizon tears. */
  fogBase: '#0b1a26',
  /** Structural concrete and steel. */
  concrete: '#1b3344',
  column: '#24465c',
  beam: '#1a3546',
  /** Perimeter walls and the window bands punched through them. */
  cladding: '#132a38',
  glazing: '#2b6f99',
  /** Ghosted surrounding city: cold, translucent, clearly not the subject. */
  cityNear: '#1e4258',
  cityFar: '#16303f',
  cityEdge: '#4d8fb5',
  /** High-bay luminaires. These are what bloom picks up. */
  highBay: '#cfeaff',
  /** The X-ray blueprint palette. */
  blueprint: '#45c8ff',
  blueprintWarn: '#ff6b57',
  xrayClear: '#04101a',
} as const;

/** Numeric forms for three.js, which prefers hex ints. */
export const THEME_HEX = {
  background: 0x0b1a26,
  accent: 0x1a8fd1,
  pallets: [0x9bb8cc, 0x86a8bd, 0xaec8da] as const,
} as const;
