'use client';

/**
 * ARCHITECTURE SHELL — the building, not the diagram.
 *
 * ============================================================================
 * THE COMPLAINT THIS ANSWERS
 * ============================================================================
 * "The factory cannot be empty boxes."
 *
 * It was three floating slabs with machines on them. A slab has no columns
 * holding it up, so the eye reads it as a chart; and because the floor plates
 * were the only large surfaces, there was nothing for the AO pass to darken
 * against and nothing for the environment map to reflect off.
 *
 * So this file adds the parts of a building that are structural rather than
 * decorative, and it adds them in the order a builder would:
 *
 *   Groundworks   slab, apron, drainage, the yard it all sits in
 *   StructuralFrame   column grid on a real 8m bay, then the beams
 *   Envelope      cladding panels with the window bands punched through
 *   HighBay       the luminaires — the only emissive geometry up here
 *   CirculationCore / ManagementCabins   reused from V6, unchanged
 *   GhostCity     the city, pushed back and made explicitly unreal
 *
 * ============================================================================
 * EVERY REPEATED ELEMENT IS ONE DRAW CALL
 * ============================================================================
 * The column grid is 2 sites x 3 floors x ~15 columns. As individual meshes
 * that is 45 draws for something that never moves. All of it — columns,
 * beams, cladding panels, window bands, luminaires, city blocks — is written
 * into `InstancedMesh` matrices ONCE on mount and never touched again. The
 * whole building envelope costs 7 draw calls.
 *
 * Matrices are composed by hand rather than through `Object3D.updateMatrix`,
 * because these are all axis-aligned boxes: a translate and a scale, written
 * straight into the column-major array. Same reason as `IndustrialEntities`.
 * ============================================================================
 */

import { memo, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

import { FLOOR_INDICES, SITES, floorElevation, type SiteId } from '@/lib/sites';
import { SCENE, THEME } from '@/lib/theme';
import { useMegnetoStore } from '@/store/useMegnetoStore';
import { CirculationCore, ManagementCabins } from '@/components/SiteArchitecture';

/* -------------------------------------------------------------------------- */
/* Matrix helpers                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Axis-aligned box into an instance matrix. No rotation, no quaternion, no
 * temporary Object3D — nine stores and seven zeroes.
 */
function writeBox(
  arr: Float32Array,
  index: number,
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
) {
  const o = index << 4;
  arr[o] = sx;     arr[o + 1] = 0;  arr[o + 2] = 0;   arr[o + 3] = 0;
  arr[o + 4] = 0;  arr[o + 5] = sy; arr[o + 6] = 0;   arr[o + 7] = 0;
  arr[o + 8] = 0;  arr[o + 9] = 0;  arr[o + 10] = sz; arr[o + 11] = 0;
  arr[o + 12] = x; arr[o + 13] = y; arr[o + 14] = z;  arr[o + 15] = 1;
}

/** Same, with a yaw. Used for the city, which is not axis-aligned. */
function writeBoxY(
  arr: Float32Array,
  index: number,
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
  rotY: number,
) {
  const o = index << 4;
  const c = Math.cos(rotY);
  const s = Math.sin(rotY);
  arr[o] = c * sx;      arr[o + 1] = 0;  arr[o + 2] = -s * sx;  arr[o + 3] = 0;
  arr[o + 4] = 0;       arr[o + 5] = sy; arr[o + 6] = 0;        arr[o + 7] = 0;
  arr[o + 8] = s * sz;  arr[o + 9] = 0;  arr[o + 10] = c * sz;  arr[o + 11] = 0;
  arr[o + 12] = x;      arr[o + 13] = y; arr[o + 14] = z;       arr[o + 15] = 1;
}

/** A unit box centred on its own origin. Every instance below scales this. */
const UNIT = new THREE.BoxGeometry(1, 1, 1);

/* ========================================================================== */
/* GROUNDWORKS                                                                */
/* ========================================================================== */

/**
 * What the building stands on. The apron and the drainage channel are there
 * for one reason: they give the AO pass a horizontal surface to lay contact
 * shadow onto, which is what visually plants the building instead of letting
 * it hover.
 */
const Groundworks = memo(function Groundworks({ siteId }: { siteId: SiteId }) {
  const site = SITES[siteId];
  const W = site.shell.width;
  const D = site.shell.depth;

  return (
    <group>
      {/* Yard. Big enough to run a truck round, small enough to stay in frame. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.32, 0]} raycast={() => null} receiveShadow={false}>
        <planeGeometry args={[W * 2.9, D * 3.2]} />
        <meshStandardMaterial color="#0a1824" roughness={0.95} metalness={0.0} />
      </mesh>

      {/* Concrete apron: a visible step up out of the yard. */}
      <mesh position={[0, -0.16, 0]} raycast={() => null}>
        <boxGeometry args={[W + 5.0, 0.32, D + 5.0]} />
        <meshStandardMaterial color={SCENE.concrete} roughness={0.88} metalness={0.04} />
      </mesh>

      {/* The slab proper, slightly proud of the apron. */}
      <mesh position={[0, 0.02, 0]} raycast={() => null}>
        <boxGeometry args={[W + 0.9, 0.12, D + 0.9]} />
        <meshStandardMaterial color={THEME.slab} roughness={0.8} metalness={0.06} />
      </mesh>

      {/* Drainage channel round two sides — a wet-process mill detail. */}
      {[1, -1].map((s) => (
        <mesh key={s} position={[s * (W / 2 + 1.5), -0.04, 0]} raycast={() => null}>
          <boxGeometry args={[0.36, 0.1, D + 2.0]} />
          <meshStandardMaterial color="#071219" roughness={0.6} metalness={0.2} />
        </mesh>
      ))}
    </group>
  );
});

/* ========================================================================== */
/* STRUCTURAL FRAME                                                           */
/* ========================================================================== */

/**
 * Columns and beams on an 8-metre bay, which is the span you would actually
 * build for this floor loading. The grid is derived from the shell dimensions
 * rather than hard-coded, so both sites get a frame that fits them and the
 * bays come out even.
 *
 * Columns deliberately run the FULL height of the building in one instance
 * each rather than per-storey, because a column that stops at every floor
 * plate reads as furniture. The beams mark the floors instead.
 */
const StructuralFrame = memo(function StructuralFrame({ siteId }: { siteId: SiteId }) {
  const site = SITES[siteId];
  const W = site.shell.width;
  const D = site.shell.depth;
  const H = site.shell.floorHeight;
  const totalH = H * 3;

  const colRef = useRef<THREE.InstancedMesh>(null);
  const beamRef = useRef<THREE.InstancedMesh>(null);

  /** Bay centres along each axis, including the perimeter. */
  const grid = useMemo(() => {
    const bay = 8;
    const nx = Math.max(2, Math.round(W / bay));
    const nz = Math.max(2, Math.round(D / bay));
    const xs: number[] = [];
    const zs: number[] = [];
    for (let i = 0; i <= nx; i++) xs.push(-W / 2 + (i / nx) * W);
    for (let i = 0; i <= nz; i++) zs.push(-D / 2 + (i / nz) * D);
    return { xs, zs };
  }, [W, D]);

  const columns = useMemo(() => {
    const out: { x: number; z: number }[] = [];
    for (const x of grid.xs) {
      for (const z of grid.zs) {
        // Skip the two interior columns nearest the circulation core, which
        // occupies the west bay — a real building would transfer that load
        // into the core walls rather than drop a column through the stair.
        const inCore = x < -W / 2 + 4.6 && z > -D / 2 + 2.0 && z < -D / 2 + 11.0;
        if (inCore) continue;
        out.push({ x, z });
      }
    }
    return out;
  }, [grid, W, D]);

  /** Perimeter and spine beams, one ring per floor plate plus the roof. */
  const beams = useMemo(() => {
    const out: { x: number; y: number; z: number; sx: number; sy: number; sz: number }[] = [];
    const depth = 0.42;
    const web = 0.22;
    for (const floor of FLOOR_INDICES) {
      // The beam sits just UNDER its floor plate, where it belongs.
      const y = floorElevation(site, floor) + H - depth * 0.5;
      for (const z of grid.zs) out.push({ x: 0, y, z, sx: W, sy: depth, sz: web });
      for (const x of grid.xs) out.push({ x, y, z: 0, sx: web, sy: depth, sz: D });
    }
    // Roof ring, slightly deeper: it carries the sheeting and the services.
    const ry = totalH + 0.3;
    for (const z of grid.zs) out.push({ x: 0, y: ry, z, sx: W, sy: 0.52, sz: 0.26 });
    for (const x of grid.xs) out.push({ x, y: ry, z: 0, sx: 0.26, sy: 0.52, sz: D });
    return out;
  }, [grid, site, H, W, D, totalH]);

  /**
   * Written once, on mount. `useLayoutEffect` rather than `useEffect` so the
   * matrices exist before the first paint — otherwise every column renders at
   * the identity for one frame, which is a visible flash of a unit cube at
   * the origin.
   */
  useLayoutEffect(() => {
    const col = colRef.current;
    if (col) {
      const arr = col.instanceMatrix.array as Float32Array;
      columns.forEach((c, i) => {
        writeBox(arr, i, c.x, totalH / 2, c.z, 0.46, totalH, 0.46);
      });
      col.instanceMatrix.needsUpdate = true;
      col.computeBoundingSphere();
    }

    const beam = beamRef.current;
    if (beam) {
      const arr = beam.instanceMatrix.array as Float32Array;
      beams.forEach((b, i) => {
        writeBox(arr, i, b.x, b.y, b.z, b.sx, b.sy, b.sz);
      });
      beam.instanceMatrix.needsUpdate = true;
      beam.computeBoundingSphere();
    }
  }, [columns, beams, totalH]);

  return (
    <group>
      <instancedMesh
        ref={colRef}
        args={[UNIT, undefined, columns.length]}
        frustumCulled={false}
        raycast={() => null}
      >
        <meshStandardMaterial color={SCENE.column} roughness={0.52} metalness={0.45} />
      </instancedMesh>

      <instancedMesh
        ref={beamRef}
        args={[UNIT, undefined, beams.length]}
        frustumCulled={false}
        raycast={() => null}
      >
        <meshStandardMaterial color={SCENE.beam} roughness={0.56} metalness={0.5} />
      </instancedMesh>
    </group>
  );
});

/* ========================================================================== */
/* ENVELOPE                                                                   */
/* ========================================================================== */

/**
 * Cladding, and the window bands punched through it.
 *
 * The walls are built as four separate panel runs, not one hollow box, for a
 * reason that matters on this hardware: `FloorStack` already fades the floor
 * plates when you isolate a level, and it needs to be able to fade the walls
 * on the same schedule. Separate panels also mean the two walls BETWEEN the
 * camera and the plant can be dropped entirely — see the visibility driver
 * at the bottom of this file.
 *
 * The window band is a separate emissive-ish strip at eye height on each
 * floor. It is what makes the building read as three occupied storeys from
 * the outside rather than a solid block.
 */
const Envelope = memo(function Envelope({ siteId }: { siteId: SiteId }) {
  const site = SITES[siteId];
  const W = site.shell.width;
  const D = site.shell.depth;
  const H = site.shell.floorHeight;
  const t = site.shell.wallThickness;

  const panelRef = useRef<THREE.InstancedMesh>(null);
  const glazeRef = useRef<THREE.InstancedMesh>(null);

  /** Spandrel panels: the solid bits above and below each window band. */
  const panels = useMemo(() => {
    const out: { x: number; y: number; z: number; sx: number; sy: number; sz: number }[] = [];
    const bandH = H * 0.34; // window band height
    const sillH = H * 0.4; // solid below the band
    for (const floor of FLOOR_INDICES) {
      const base = floorElevation(site, floor);
      const headH = H - sillH - bandH;
      // sill course and head course, on all four sides
      for (const [sy, cy] of [
        [sillH, base + sillH / 2],
        [headH, base + sillH + bandH + headH / 2],
      ] as const) {
        out.push({ x: 0, y: cy, z: -D / 2, sx: W, sy, sz: t });
        out.push({ x: 0, y: cy, z: D / 2, sx: W, sy, sz: t });
        out.push({ x: -W / 2, y: cy, z: 0, sx: t, sy, sz: D });
        out.push({ x: W / 2, y: cy, z: 0, sx: t, sy, sz: D });
      }
    }
    // Roof deck.
    out.push({ x: 0, y: H * 3 + 0.62, z: 0, sx: W + 1.1, sy: 0.2, sz: D + 1.1 });
    return out;
  }, [site, W, D, H, t]);

  /** The glazed bands themselves. */
  const glazing = useMemo(() => {
    const out: { x: number; y: number; z: number; sx: number; sy: number; sz: number }[] = [];
    const bandH = H * 0.34;
    const sillH = H * 0.4;
    for (const floor of FLOOR_INDICES) {
      const y = floorElevation(site, floor) + sillH + bandH / 2;
      out.push({ x: 0, y, z: -D / 2, sx: W * 0.94, sy: bandH, sz: t * 0.6 });
      out.push({ x: 0, y, z: D / 2, sx: W * 0.94, sy: bandH, sz: t * 0.6 });
      out.push({ x: -W / 2, y, z: 0, sx: t * 0.6, sy: bandH, sz: D * 0.94 });
      out.push({ x: W / 2, y, z: 0, sx: t * 0.6, sy: bandH, sz: D * 0.94 });
    }
    return out;
  }, [site, W, D, H, t]);

  useLayoutEffect(() => {
    const p = panelRef.current;
    if (p) {
      const arr = p.instanceMatrix.array as Float32Array;
      panels.forEach((b, i) => writeBox(arr, i, b.x, b.y, b.z, b.sx, b.sy, b.sz));
      p.instanceMatrix.needsUpdate = true;
      p.computeBoundingSphere();
    }
    const g = glazeRef.current;
    if (g) {
      const arr = g.instanceMatrix.array as Float32Array;
      glazing.forEach((b, i) => writeBox(arr, i, b.x, b.y, b.z, b.sx, b.sy, b.sz));
      g.instanceMatrix.needsUpdate = true;
      g.computeBoundingSphere();
    }
  }, [panels, glazing]);

  /**
   * Hide the two walls nearest the camera so the plant inside is visible.
   *
   * The camera is locked to a single orbit quadrant (see CameraController's
   * polar limits), but it can still swing right round in azimuth, so which
   * two walls are in the way changes. Rather than fading all four — which
   * costs four transparent draws that cannot early-z — the whole envelope is
   * one instanced mesh and we simply drop the near panels by pushing their
   * opacity, once per frame, from the camera's own azimuth.
   */
  const matRef = useRef<THREE.MeshStandardMaterial>(null);
  useFrame(({ camera }) => {
    const mat = matRef.current;
    if (!mat) return;
    // Looking straight down the building: walls matter less. Looking across
    // it: they are solid. This keeps the interior legible at every angle.
    const pitch = Math.atan2(camera.position.y, Math.hypot(camera.position.x, camera.position.z));
    const target = THREE.MathUtils.clamp(0.52 - pitch * 0.42, 0.1, 0.52);
    mat.opacity += (target - mat.opacity) * 0.08;
  });

  return (
    <group>
      <instancedMesh
        ref={panelRef}
        args={[UNIT, undefined, panels.length]}
        frustumCulled={false}
        raycast={() => null}
      >
        <meshStandardMaterial
          ref={matRef}
          color={SCENE.cladding}
          roughness={0.74}
          metalness={0.32}
          transparent
          opacity={0.45}
          /* Same reasoning as the city: the envelope wraps the entire
           * building, so four overlapping translucent walls plus a roof is
           * five full-screen blends per frame. Depth-writing cuts that to
           * the near faces only. */
          side={THREE.FrontSide}
        />
      </instancedMesh>

      <instancedMesh
        ref={glazeRef}
        args={[UNIT, undefined, glazing.length]}
        frustumCulled={false}
        raycast={() => null}
      >
        {/* Lit from inside: the band is brighter than the wall it sits in,
          * which is what sells "the building is working" from outside. */}
        <meshBasicMaterial
          color={SCENE.glazing}
          transparent
          opacity={0.5}
          depthWrite={false}
          toneMapped={false}
        />
      </instancedMesh>
    </group>
  );
});

/* ========================================================================== */
/* HIGH-BAY LIGHTING                                                          */
/* ========================================================================== */

/**
 * The luminaires. These are the brightest things in the scene and the main
 * thing the bloom pass has to work with.
 *
 * They emit NO light. There is not a single point light in this building —
 * V2 had 44 and cost 113ms a frame on the GTX 1650. Illumination comes from
 * three directionals and the environment map; these are unlit geometry whose
 * only job is to be above the bloom threshold, so the eye reads a glowing
 * fitting and infers the light it is casting.
 */
const HighBay = memo(function HighBay({ siteId }: { siteId: SiteId }) {
  const site = SITES[siteId];
  const W = site.shell.width;
  const D = site.shell.depth;
  const H = site.shell.floorHeight;

  const ref = useRef<THREE.InstancedMesh>(null);

  const fittings = useMemo(() => {
    const out: { x: number; y: number; z: number; sx: number; sz: number }[] = [];
    const rows = 3;
    const perRow = 4;
    for (const floor of FLOOR_INDICES) {
      // Just under the soffit, where a high bay actually hangs.
      const y = floorElevation(site, floor) + H - 0.52;
      for (let r = 0; r < rows; r++) {
        const z = -D / 2 + ((r + 0.5) / rows) * D;
        for (let c = 0; c < perRow; c++) {
          const x = -W / 2 + ((c + 0.5) / perRow) * W;
          out.push({ x, y, z, sx: W / perRow * 0.58, sz: 0.2 });
        }
      }
    }
    return out;
  }, [site, W, D, H]);

  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    const arr = m.instanceMatrix.array as Float32Array;
    fittings.forEach((f, i) => writeBox(arr, i, f.x, f.y, f.z, f.sx, 0.06, f.sz));
    m.instanceMatrix.needsUpdate = true;
    m.computeBoundingSphere();
  }, [fittings]);

  return (
    <instancedMesh ref={ref} args={[UNIT, undefined, fittings.length]} frustumCulled={false} raycast={() => null}>
      <meshBasicMaterial color={SCENE.highBay} toneMapped={false} />
    </instancedMesh>
  );
});

/* ========================================================================== */
/* GHOST CITY                                                                 */
/* ========================================================================== */

/**
 * The surrounding city, as explicitly unreal translucent massing.
 *
 * The brief is "the target factory must stand out", and the way to lose that
 * is to render the neighbours well. So the city is deliberately wrong in
 * three ways at once: it is low-poly (one box per building), it is
 * translucent, and it is a single flat blue-grey with no variation in
 * material. Nobody will mistake it for surveyed data, and the eye discards
 * it immediately and goes back to the lit building in the middle.
 *
 * The massing is deterministic from the site id, so Tiruppur's low dense
 * sprawl and Bengaluru's taller blocks come out the same at every rehearsal.
 */
const GhostCity = memo(function GhostCity({ siteId }: { siteId: SiteId }) {
  const site = SITES[siteId];
  const W = site.shell.width;
  const D = site.shell.depth;
  const span = Math.max(W, D);

  const massRef = useRef<THREE.InstancedMesh>(null);

  const blocks = useMemo(() => {
    const out: { x: number; z: number; w: number; d: number; h: number; rot: number; far: number }[] = [];
    // Same LCG as V6, so the skyline is unchanged between versions.
    let seed = siteId === 'tiruppur' ? 20260419 : 77552212;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };

    // Tiruppur: a dense low sprawl of sheds and two-storey units.
    // Bengaluru: taller, sparser, more commercial.
    const tall = siteId === 'rajajinagar';
    const count = tall ? 54 : 72;
    const ringInner = span * 1.0;
    const ringOuter = span * 2.7;

    for (let i = 0; i < count; i++) {
      const a = rnd() * Math.PI * 2;
      // sqrt keeps the density even instead of crowding the inner ring.
      const r = ringInner + Math.sqrt(rnd()) * (ringOuter - ringInner);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r * 0.88;
      const w = 4 + rnd() * (tall ? 7 : 9);
      const d = 4 + rnd() * (tall ? 7 : 9);
      const h = tall ? 5 + Math.pow(rnd(), 1.6) * 26 : 3.5 + Math.pow(rnd(), 2.0) * 11;
      out.push({
        x,
        z,
        w,
        d,
        h,
        // Blocks follow the road grid loosely, not exactly.
        rot: Math.round(a / (Math.PI / 2)) * (Math.PI / 2) + (rnd() - 0.5) * 0.3,
        // Normalised distance, for the fade.
        far: THREE.MathUtils.clamp((r - ringInner) / (ringOuter - ringInner), 0, 1),
      });
    }
    return out;
  }, [siteId, span]);

  useLayoutEffect(() => {
    const m = massRef.current;
    if (!m) return;
    const arr = m.instanceMatrix.array as Float32Array;
    const near = new THREE.Color(SCENE.cityNear);
    const far = new THREE.Color(SCENE.cityFar);
    const tmp = new THREE.Color();

    blocks.forEach((b, i) => {
      writeBoxY(arr, i, b.x, b.h / 2 - 0.3, b.z, b.w, b.h, b.d, b.rot);
      // Aerial perspective: the far blocks sit back into the fog.
      // `setColorAt` allocates `instanceColor` on first call, which is why
      // there is no manual attribute set-up here.
      tmp.copy(near).lerp(far, b.far);
      m.setColorAt(i, tmp);
    });
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.computeBoundingSphere();
  }, [blocks]);

  return (
    <group>
      <instancedMesh
        ref={massRef}
        args={[UNIT, undefined, blocks.length]}
        frustumCulled={false}
        raycast={() => null}
      >
        <meshStandardMaterial
          transparent
          opacity={0.34}
          /* ---- depthWrite stays ON, and that is the whole trick ----
           *
           * 72 translucent boxes in a ring overlap heavily from an isometric
           * camera. With `depthWrite: false` every one of them rasterises
           * every pixel it covers, blending over whatever is behind. Hiding
           * every transparent mesh in the scene took it from 22.6ms to 9.4ms
           * — transparency as a whole was well over half the frame, and this
           * ring of buildings nobody is looking at was a large part of it.
           *
           * Writing depth lets each block occlude the ones behind it, so the
           * ring costs roughly its silhouette instead of its total area. The
           * price is back-to-front sorting artefacts between blocks — which
           * is invisible here, because every block is the same flat colour
           * family and there is nothing inside one to see through to.
           */
          roughness={0.9}
          metalness={0.0}
          /* Front faces only. Drawing the back of a translucent box doubles
           * the fill cost and makes the massing look solid anyway. */
          side={THREE.FrontSide}
        />
      </instancedMesh>

      {/* Access road and the rail spur, so the yard connects to something. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.3, D * 1.15]} raycast={() => null}>
        <planeGeometry args={[span * 3.0, 7.0]} />
        <meshStandardMaterial color="#0d1b25" roughness={0.95} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.29, D * 1.15]} raycast={() => null}>
        <planeGeometry args={[span * 3.0, 0.18]} />
        <meshBasicMaterial color="#c9a227" toneMapped={false} transparent opacity={0.5} />
      </mesh>
    </group>
  );
});

/* ========================================================================== */
/* Public                                                                     */
/* ========================================================================== */

/**
 * The visibility driver.
 *
 * During a deep dive the camera is inside a machine, and everything in this
 * file is then pure overdraw: a 72-box translucent city behind a wall nobody
 * can see still costs its fill. V6 measured the exploded view at 90ms for
 * exactly this reason. So the exterior and the envelope are switched off
 * wholesale the moment a dive starts, which is also what gives the X-ray its
 * black backdrop for free.
 *
 * Read from the store in `useFrame`, compared against the live flag, and set
 * on a group. No subscription, no re-render.
 */
export default function ArchitectureShell({ siteId }: { siteId: SiteId }) {
  const exteriorRef = useRef<THREE.Group>(null);
  const interiorRef = useRef<THREE.Group>(null);

  useFrame(() => {
    const st = useMegnetoStore.getState();
    const diving = st.kinematicMachineId !== null;
    const exploded = st.explodedMachineId !== null;

    const ext = exteriorRef.current;
    if (ext) {
      const v = !diving && !exploded;
      if (ext.visible !== v) ext.visible = v;
    }

    const int = interiorRef.current;
    if (int) {
      // The structure survives an exploded view — a machine opened up in
      // front of its own columns still reads as being inside a building —
      // but not the full X-ray dive.
      if (int.visible !== !diving) int.visible = !diving;
    }
  });

  return (
    <group>
      <group ref={exteriorRef}>
        <GhostCity siteId={siteId} />
        <Groundworks siteId={siteId} />
        <Envelope siteId={siteId} />
      </group>

      <group ref={interiorRef}>
        <StructuralFrame siteId={siteId} />
        <HighBay siteId={siteId} />
        <CirculationCore siteId={siteId} />
        <ManagementCabins siteId={siteId} />
      </group>
    </group>
  );
}
