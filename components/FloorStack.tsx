'use client';

/**
 * THE VERTICAL FACTORY
 *
 * Three storeys of transparent isometric shell, stacked the way a real mill is
 * stacked: heavy wet process on the ground where the foundations and drains
 * are, labour-dense lines above it, QA and dispatch on top.
 *
 * ============================================================================
 * HOW ISOLATION WORKS, AND WHY IT COSTS NOTHING
 * ============================================================================
 * When the user picks a level, the other two drop to ~10% opacity and lose
 * their solid faces, leaving a wireframe cage so you keep the sense of the
 * whole building while reading one floor.
 *
 * That transition is NOT React. Each level collects its materials ONCE on
 * mount into a flat array, and a single `useFrame` lerps their opacity toward
 * the target every frame. Re-rendering three storeys of geometry to fade them
 * would be exactly the kind of thing that drops frames on a 1650.
 *
 * `activeFloor` is read with `getState()` inside the frame loop, so this
 * component never subscribes to it and never re-renders when it changes.
 * ============================================================================
 */

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

import { FLOOR_INDICES, SITES, floorElevation, type FloorIndex, type SiteId } from '@/lib/sites';
import { THEME } from '@/lib/theme';
import { useMegnetoStore } from '@/store/useMegnetoStore';

/** Opacity targets for the solid surfaces of a level. */
const SOLID_FOCUSED = 0.3;
const SOLID_DIMMED = 0.03;
const SOLID_ALL = 0.2;

/** Opacity targets for the edge lines, which are what carry a dimmed level. */
const LINE_FOCUSED = 0.62;
const LINE_DIMMED = 0.1;
const LINE_ALL = 0.34;

interface LevelMaterials {
  solids: THREE.Material[];
  lines: THREE.LineBasicMaterial[];
  /** Zone floor tiles read better opaque on the focused level. */
  tiles: THREE.MeshStandardMaterial[];
}

function FloorLevel({ siteId, floor }: { siteId: SiteId; floor: FloorIndex }) {
  const site = SITES[siteId];
  const groupRef = useRef<THREE.Group>(null);
  const materials = useRef<LevelMaterials>({ solids: [], lines: [], tiles: [] });

  const elevation = floorElevation(site, floor);
  const slabW = site.shell.width + 3;
  const slabD = site.shell.depth + 3;
  const h = site.shell.floorHeight;
  const t = site.shell.wallThickness;

  const zones = useMemo(() => site.zones.filter((z) => z.floor === floor), [site, floor]);

  /* ---- cached geometry: allocated once, disposed on unmount ---- */
  const bays = useMemo(
    () =>
      zones.map((zone) => {
        const [minX, minZ, maxX, maxZ] = zone.bounds;
        const sx = maxX - minX - 0.2;
        const sz = maxZ - minZ - 0.2;
        return {
          zone,
          cx: (minX + maxX) / 2,
          cz: (minZ + maxZ) / 2,
          sx,
          sz,
          edges: new THREE.EdgesGeometry(new THREE.PlaneGeometry(sx, sz)),
        };
      }),
    [zones],
  );
  useEffect(() => () => bays.forEach((b) => b.edges.dispose()), [bays]);

  const walls = useMemo(() => {
    const w = site.shell.width;
    const d = site.shell.depth;
    const defs: { pos: THREE.Vector3Tuple; size: [number, number, number] }[] = [
      { pos: [0, h / 2, -d / 2], size: [w, h, t] },
      { pos: [0, h / 2, d / 2], size: [w, h, t] },
      { pos: [-w / 2, h / 2, 0], size: [t, h, d] },
      { pos: [w / 2, h / 2, 0], size: [t, h, d] },
    ];
    return defs.map((def) => ({
      ...def,
      edges: new THREE.EdgesGeometry(new THREE.BoxGeometry(...def.size)),
    }));
  }, [site, h, t]);
  useEffect(() => () => walls.forEach((w) => w.edges.dispose()), [walls]);

  const ceilingEdges = useMemo(
    () => new THREE.EdgesGeometry(new THREE.BoxGeometry(site.shell.width, 0.08, site.shell.depth)),
    [site],
  );
  useEffect(() => () => ceilingEdges.dispose(), [ceilingEdges]);

  /** Structural columns, so the stack reads as a building and not as shelves. */
  const columns = useMemo(() => {
    const w = site.shell.width;
    const d = site.shell.depth;
    const out: THREE.Vector3Tuple[] = [];
    for (const x of [-w / 2, -w / 6, w / 6, w / 2]) {
      for (const z of [-d / 2, 0, d / 2]) out.push([x, h / 2, z]);
    }
    return out;
  }, [site, h]);

  /* ---- collect materials once ---- */
  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    const solids: THREE.Material[] = [];
    const lines: THREE.LineBasicMaterial[] = [];
    const tiles: THREE.MeshStandardMaterial[] = [];

    group.traverse((obj) => {
      const line = obj as THREE.LineSegments;
      if (line.isLineSegments) {
        const m = line.material as THREE.LineBasicMaterial;
        if (m) {
          m.transparent = true;
          lines.push(m);
        }
        return;
      }
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const m = mesh.material as THREE.MeshStandardMaterial;
      if (!m) return;
      m.transparent = true;
      m.depthWrite = false;
      if (mesh.userData.isTile) tiles.push(m);
      else solids.push(m);
    });

    materials.current = { solids, lines, tiles };
  }, [bays, walls, columns]);

  /* ---- the isolation transition ---- */
  useFrame(() => {
    const active = useMegnetoStore.getState().activeFloor;
    const focused = active === floor;
    const all = active === 'all';

    const solidTarget = all ? SOLID_ALL : focused ? SOLID_FOCUSED : SOLID_DIMMED;
    const lineTarget = all ? LINE_ALL : focused ? LINE_FOCUSED : LINE_DIMMED;
    const tileTarget = all ? 0.72 : focused ? 0.95 : 0.06;

    const { solids, lines, tiles } = materials.current;
    for (const m of solids) m.opacity = THREE.MathUtils.lerp(m.opacity, solidTarget, 0.08);
    for (const m of lines) m.opacity = THREE.MathUtils.lerp(m.opacity, lineTarget, 0.08);
    for (const m of tiles) m.opacity = THREE.MathUtils.lerp(m.opacity, tileTarget, 0.08);

    // A fully faded level stops drawing entirely — three storeys of invisible
    // transparent geometry is still three storeys of overdraw.
    const group = groupRef.current;
    if (group) group.visible = solids.length === 0 || solids[0].opacity > 0.035 || lines[0]?.opacity > 0.02;
  });

  return (
    <group ref={groupRef} position={[0, elevation, 0]}>
      {/* Slab */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]} raycast={() => null}>
        <planeGeometry args={[slabW, slabD]} />
        <meshStandardMaterial color={THEME.slab} roughness={0.98} metalness={0} transparent opacity={SOLID_ALL} />
      </mesh>

      {/* Zone tiles + outlines */}
      {bays.map((bay) => (
        <group key={bay.zone.id}>
          <mesh
            rotation={[-Math.PI / 2, 0, 0]}
            position={[bay.cx, 0.002, bay.cz]}
            raycast={() => null}
            userData={{ isTile: true }}
          >
            <planeGeometry args={[bay.sx, bay.sz]} />
            <meshStandardMaterial
              color={bay.zone.tone}
              roughness={0.96}
              metalness={0.02}
              transparent
              opacity={0.72}
            />
          </mesh>
          <lineSegments
            geometry={bay.edges}
            position={[bay.cx, 0.014, bay.cz]}
            rotation={[-Math.PI / 2, 0, 0]}
            raycast={() => null}
          >
            <lineBasicMaterial color={THEME.accent} transparent opacity={LINE_ALL} />
          </lineSegments>
        </group>
      ))}

      {/* Perimeter: faces fade out, outlines stay — that is what keeps a dimmed
          level legible as a storey rather than disappearing. */}
      {walls.map((wall, i) => (
        <group key={`w${i}`} position={wall.pos}>
          <mesh raycast={() => null}>
            <boxGeometry args={wall.size} />
            <meshStandardMaterial color={THEME.wall} roughness={0.94} metalness={0.02} transparent opacity={SOLID_ALL} />
          </mesh>
          <lineSegments geometry={wall.edges} raycast={() => null}>
            <lineBasicMaterial color={THEME.wallEdge} transparent opacity={LINE_ALL} />
          </lineSegments>
        </group>
      ))}

      {/* Columns */}
      {columns.map((pos, i) => (
        <mesh key={`c${i}`} position={pos} raycast={() => null}>
          <boxGeometry args={[0.36, h, 0.36]} />
          <meshStandardMaterial color={THEME.machineTrim} roughness={0.82} metalness={0.06} transparent opacity={SOLID_ALL} />
        </mesh>
      ))}

      {/* Ceiling ribs */}
      <lineSegments geometry={ceilingEdges} position={[0, h, 0]} raycast={() => null}>
        <lineBasicMaterial color={THEME.accent} transparent opacity={LINE_ALL} />
      </lineSegments>
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/* Baked ambient occlusion, one plane per level                                */
/* -------------------------------------------------------------------------- */

function FloorAO({ siteId, floor }: { siteId: SiteId; floor: FloorIndex }) {
  const site = SITES[siteId];
  const slabW = site.shell.width + 3;
  const slabD = site.shell.depth + 3;
  const matRef = useRef<THREE.MeshBasicMaterial>(null);

  /**
   * Every machine's contact shadow on this level, painted ONCE into a canvas.
   * A real shadow pass would cost a depth render and a blur every frame, per
   * storey; this costs one texture upload for the life of the layer.
   */
  const texture = useMemo(() => {
    const size = 512;
    const cv = document.createElement('canvas');
    cv.width = size;
    cv.height = size;
    const ctx = cv.getContext('2d');
    if (!ctx) return null;

    const toU = (x: number) => ((x + slabW / 2) / slabW) * size;
    const toV = (z: number) => ((z + slabD / 2) / slabD) * size;
    const scaleU = size / slabW;

    const blob = (x: number, z: number, radius: number, strength: number) => {
      const cx = toU(x);
      const cy = toV(z);
      const r = radius * scaleU;
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      grad.addColorStop(0, `rgba(26, 72, 104, ${strength})`);
      grad.addColorStop(0.55, `rgba(26, 72, 104, ${strength * 0.45})`);
      grad.addColorStop(1, 'rgba(26, 72, 104, 0)');
      ctx.fillStyle = grad;
      ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    };

    for (const m of site.machines) {
      if (m.floor !== floor) continue;
      blob(m.position[0], m.position[2], Math.max(m.size[0], m.size[2]) * 0.9, 0.4);
    }
    for (const n of site.envNodes) {
      if (n.floor !== floor) continue;
      blob(n.position[0], n.position[2], Math.max(n.size[0], n.size[2]) * 0.9, 0.34);
    }

    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 2;
    return tex;
  }, [site, floor, slabW, slabD]);

  useEffect(() => () => texture?.dispose(), [texture]);

  useFrame(() => {
    const mat = matRef.current;
    if (!mat) return;
    const active = useMegnetoStore.getState().activeFloor;
    const target = active === 'all' ? 0.7 : active === floor ? 1 : 0.05;
    mat.opacity = THREE.MathUtils.lerp(mat.opacity, target, 0.08);
  });

  if (!texture) return null;

  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, floorElevation(site, floor) + 0.018, 0]}
      raycast={() => null}
    >
      <planeGeometry args={[slabW, slabD]} />
      <meshBasicMaterial ref={matRef} map={texture} transparent depthWrite={false} toneMapped={false} opacity={0.7} />
    </mesh>
  );
}

/* -------------------------------------------------------------------------- */
/* Public                                                                      */
/* -------------------------------------------------------------------------- */

export default function FloorStack({ siteId }: { siteId: SiteId }) {
  const site = SITES[siteId];

  return (
    <group>
      {FLOOR_INDICES.map((floor) => (
        <FloorLevel key={floor} siteId={siteId} floor={floor} />
      ))}
      {FLOOR_INDICES.map((floor) => (
        <FloorAO key={`ao${floor}`} siteId={siteId} floor={floor} />
      ))}

      {/* Ground shadow under the whole building, so the stack is planted. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.06, 0]} raycast={() => null}>
        <planeGeometry args={[site.shell.width + 10, site.shell.depth + 10]} />
        <meshBasicMaterial color="#cfe0ee" transparent opacity={0.5} depthWrite={false} />
      </mesh>
    </group>
  );
}
