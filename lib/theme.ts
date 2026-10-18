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
 */

export const THEME = {
  /** Page and canvas clear colour. */
  background: '#eaf4fd',
  backgroundDeep: '#dceaf6',

  surface: '#ffffff',
  surfaceSoft: '#f3f9fe',

  ink: '#0d2b3f',
  inkSoft: '#5b8aa6',

  /** Primary accent. Every line, edge and halo that is not semantic. */
  accent: '#1a8fd1',
  accentSoft: '#8ec3e6',
  accentWash: '#cfe6f7',

  /** 3D surfaces. */
  slab: '#dceaf6',
  grid: '#b4d8f1',
  gridMinor: '#d2e8f7',
  wall: '#cfe3f2',
  wallEdge: '#1a8fd1',
  machineBody: '#f1f7fc',
  machineTrim: '#7fa6c0',
  operator: '#2f9ad4',
  helmet: '#ffffff',
  pallet: '#c4dcee',
} as const;

/** Numeric forms for three.js, which prefers hex ints. */
export const THEME_HEX = {
  background: 0xeaf4fd,
  accent: 0x1a8fd1,
  pallets: [0xc9dfef, 0xb8d6ea, 0xd6e9f7] as const,
} as const;
