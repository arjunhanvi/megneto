'use client';

/**
 * SITE ARCHITECTURE — context, circulation, and the stuff that makes a
 * building look like it is somewhere.
 *
 * A factory floating in a void reads as a diagram. A factory with a yard, a
 * road, a perimeter fence and a city block behind it reads as a place, and the
 * difference costs about fifteen draw calls.
 *
 * This component owns everything that is NOT the production floor:
 *   · the ground plane, access road and yard outside the shell
 *   · surrounding low-poly block massing, so the horizon is not empty
 *   · the vertical circulation core — stairs and a freight elevator that
 *     visibly connect all three storeys
 *   · glass-walled management cabins on the upper levels
 *
 * Everything static is instanced or merged, and the exterior is drawn once
 * with no per-frame work at all.
 */

import { memo, useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

import { FLOOR_INDICES, SITES, floorElevation, type SiteId } from '@/lib/sites';
import { THEME } from '@/lib/theme';
import { useMegnetoStore } from '@/store/useMegnetoStore';

const dummy = new THREE.Object3D();
const tmpColor = new THREE.Color();

/* ========================================================================== */
/* EXTERIOR — ground, road, yard, city massing                                */
/* ========================================================================== */

const Surroundings = memo(function Surroundings({ siteId }: { siteId: SiteId }) {
  const site = SITES[siteId];
  const W = site.shell.width;
  const D = site.shell.depth;
  const blockRef = useRef<THREE.InstancedMesh>(null);

  /**
   * Surrounding block massing. Deterministic from the site id so the skyline
   * is the same at every rehearsal, and pulled back far enough that it never
   * intersects the yard.
   */
  const blocks = useMemo(() => {
    const out: { x: number; z: number; w: number; d: number; h: number; tone: number }[] = [];
    // A cheap LCG keyed off the site, so the two cities differ.
    let seed = siteId === 'tiruppur' ? 20260419 : 77552212;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };

    const ringInner = Math.max(W, D) * 0.95;
    const ringOuter = Math.max(W, D) * 2.3;

    for (let i = 0; i < 46; i++) {
      const angle = (i / 46) * Math.PI * 2 + rnd() * 0.12;
      const radius = ringInner + rnd() * (ringOuter - ringInner);
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;

      // Keep the south apron clear — that is where the trucks live.
      if (z > D / 2 && Math.abs(x) < W * 0.7 && z < D / 2 + 16) continue;

      // Tiruppur is low-rise sheds; Bengaluru has taller commercial stock.
      const h = siteId === 'tiruppur' ? 4 + rnd() * 7 : 6 + rnd() * 22;
      out.push({
        x,
        z,
        w: 6 + rnd() * 12,
        d: 6 + rnd() * 12,
        h,
        tone: rnd() > 0.7 ? 0xd3e2ee : rnd() > 0.4 ? 0xdfeaf4 : 0xc9dae8,
      });
    }
    return out;
  }, [siteId, W, D]);

  useEffect(() => {
    const mesh = blockRef.current;
    if (!mesh) return;
    blocks.forEach((b, i) => {
      dummy.position.set(b.x, b.h / 2, b.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(b.w, b.h, b.d);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      tmpColor.setHex(b.tone);
      mesh.setColorAt(i, tmpColor);
    });
    mesh.count = blocks.length;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [blocks]);

  const groundSize = Math.max(W, D) * 6;

  return (
    <group>
      {/* Ground plane */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.12, 0]} raycast={() => null}>
        <planeGeometry args={[groundSize, groundSize]} />
        <meshStandardMaterial color="#dce7f0" roughness={1} metalness={0} />
      </mesh>

      {/* Access road running east-west past the yard */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.1, D / 2 + 17]} raycast={() => null}>
        <planeGeometry args={[groundSize, 9]} />
        <meshStandardMaterial color="#b9c7d4" roughness={0.95} />
      </mesh>
      {/* Centre line */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.08, D / 2 + 17]} raycast={() => null}>
        <planeGeometry args={[groundSize * 0.9, 0.3]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={0.55} />
      </mesh>

      {/* Spur into the yard */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[-W * 0.3, -0.09, D / 2 + 11]} raycast={() => null}>
        <planeGeometry args={[9, 13]} />
        <meshStandardMaterial color="#bfcdd9" roughness={0.95} />
      </mesh>

      {/* Perimeter fence posts — cheap, and they define the site boundary */}
      {Array.from({ length: 4 }, (_, i) => {
        const span = i % 2 === 0 ? W + 20 : D + 24;
        const horizontal = i % 2 === 0;
        const offset = i < 2 ? -1 : 1;
        return (
          <mesh
            key={i}
            position={[horizontal ? 0 : offset * (W / 2 + 10), 0.6, horizontal ? offset * (D / 2 + 12) : 0]}
            raycast={() => null}
          >
            <boxGeometry args={[horizontal ? span : 0.12, 1.2, horizontal ? 0.12 : span]} />
            <meshStandardMaterial color="#9fb3c4" roughness={0.8} transparent opacity={0.5} />
          </mesh>
        );
      })}

      {/* Surrounding city */}
      <instancedMesh
        ref={blockRef}
        args={[
          undefined as unknown as THREE.BufferGeometry,
          undefined as unknown as THREE.Material,
          Math.max(1, blocks.length),
        ]}
        frustumCulled={false}
        raycast={() => null}
      >
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial roughness={0.9} metalness={0.04} />
      </instancedMesh>
    </group>
  );
});

/* ========================================================================== */
/* VERTICAL CIRCULATION — stairs and freight elevator                         */
/* ========================================================================== */

/**
 * The core. Three storeys with no visible way between them is the detail that
 * makes people ask "how do they get up there", so: a dog-leg stair with real
 * treads, and a freight elevator whose car actually moves between levels.
 */
export const CirculationCore = memo(function CirculationCore({ siteId }: { siteId: SiteId }) {
  const site = SITES[siteId];
  const H = site.shell.floorHeight;
  const W = site.shell.width;
  const D = site.shell.depth;

  const carRef = useRef<THREE.Mesh>(null);
  const treadRef = useRef<THREE.InstancedMesh>(null);

  /** The core sits against the west wall, clear of the production zones. */
  const coreX = -W / 2 + 2.6;
  const stairZ = -D / 2 + 4.2;
  const liftZ = -D / 2 + 9.4;

  /** Treads for all three flights, as one instanced mesh. */
  const treads = useMemo(() => {
    const out: { x: number; y: number; z: number; rot: number }[] = [];
    const perFlight = 14;
    for (const floor of FLOOR_INDICES) {
      if (floor === 2) continue; // no flight above the top landing
      const base = floorElevation(site, floor);
      for (let i = 0; i < perFlight; i++) {
        const t = i / perFlight;
        // Dog-leg: first half runs north, second half runs back south.
        const firstHalf = t < 0.5;
        const localT = firstHalf ? t * 2 : (t - 0.5) * 2;
        out.push({
          x: coreX + (firstHalf ? -0.55 : 0.55),
          y: base + 0.18 + t * (H - 0.3),
          z: stairZ + (firstHalf ? localT * 2.6 : 2.6 - localT * 2.6),
          rot: 0,
        });
      }
    }
    return out;
  }, [site, H, coreX, stairZ]);

  useEffect(() => {
    const mesh = treadRef.current;
    if (!mesh) return;
    treads.forEach((t, i) => {
      dummy.position.set(t.x, t.y, t.z);
      dummy.rotation.set(0, t.rot, 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.count = treads.length;
    mesh.instanceMatrix.needsUpdate = true;
  }, [treads]);

  /**
   * The freight car runs continuously between the ground and the top landing.
   * A triangle wave with a dwell at each end, so it reads as a lift serving
   * floors rather than a bobbing box.
   */
  useFrame(({ clock }) => {
    const car = carRef.current;
    if (!car) return;
    const period = 16;
    const t = (clock.elapsedTime % period) / period;
    // Dwell for the first 12% at each end.
    let p: number;
    if (t < 0.12) p = 0;
    else if (t < 0.5) p = (t - 0.12) / 0.38;
    else if (t < 0.62) p = 1;
    else p = 1 - (t - 0.62) / 0.38;
    car.position.y = 0.6 + p * (H * 2);
  });

  const shaftHeight = H * 3;

  return (
    <group>
      {/* ---- stair enclosure ---- */}
      <instancedMesh
        ref={treadRef}
        args={[
          undefined as unknown as THREE.BufferGeometry,
          undefined as unknown as THREE.Material,
          Math.max(1, treads.length),
        ]}
        frustumCulled={false}
        raycast={() => null}
      >
        <boxGeometry args={[1.0, 0.07, 0.26]} />
        <meshStandardMaterial color={THEME.machineTrim} roughness={0.7} metalness={0.3} />
      </instancedMesh>

      {/* stair stringers, as a tall translucent shaft so the stair reads from outside */}
      <mesh position={[coreX, shaftHeight / 2, stairZ + 1.3]} raycast={() => null}>
        <boxGeometry args={[2.5, shaftHeight, 3.6]} />
        <meshStandardMaterial
          color="#bcd6ea"
          transparent
          opacity={0.12}
          depthWrite={false}
          roughness={0.3}
          metalness={0.1}
        />
      </mesh>

      {/* ---- freight elevator ---- */}
      {/* shaft */}
      <mesh position={[coreX, shaftHeight / 2, liftZ]} raycast={() => null}>
        <boxGeometry args={[2.4, shaftHeight, 2.4]} />
        <meshStandardMaterial
          color="#aec8df"
          transparent
          opacity={0.16}
          depthWrite={false}
          roughness={0.25}
          metalness={0.2}
        />
      </mesh>
      {/* guide rails */}
      {[-1, 1].map((s) => (
        <mesh key={s} position={[coreX + s * 1.1, shaftHeight / 2, liftZ]} raycast={() => null}>
          <boxGeometry args={[0.12, shaftHeight, 0.12]} />
          <meshStandardMaterial color="#8fa8bd" metalness={0.6} roughness={0.4} />
        </mesh>
      ))}
      {/* the car */}
      <mesh ref={carRef} position={[coreX, 0.6, liftZ]} raycast={() => null}>
        <boxGeometry args={[1.9, 1.9, 1.9]} />
        <meshStandardMaterial color="#d7e4ef" metalness={0.45} roughness={0.5} />
      </mesh>

      {/* landing plates at each floor, so the stops are legible */}
      {FLOOR_INDICES.map((f) => (
        <mesh
          key={f}
          position={[coreX, floorElevation(site, f) + 0.03, liftZ + 1.6]}
          rotation={[-Math.PI / 2, 0, 0]}
          raycast={() => null}
        >
          <planeGeometry args={[2.2, 1.0]} />
          <meshBasicMaterial color={THEME.accent} transparent opacity={0.3} />
        </mesh>
      ))}
    </group>
  );
});

/* ========================================================================== */
/* MANAGEMENT CABINS — glass boxes on the upper levels                        */
/* ========================================================================== */

export const ManagementCabins = memo(function ManagementCabins({ siteId }: { siteId: SiteId }) {
  const site = SITES[siteId];
  const W = site.shell.width;
  const D = site.shell.depth;
  const H = site.shell.floorHeight;

  /** One cabin on L2, one on L3, both in a corner clear of production. */
  const cabins = useMemo(
    () => [
      { x: W / 2 - 4.2, z: -D / 2 + 3.6, w: 7.0, d: 5.2, floor: 1 as const },
      { x: W / 2 - 3.6, z: D / 2 - 3.4, w: 6.0, d: 5.0, floor: 2 as const },
    ],
    [W, D],
  );

  const edges = useMemo(
    () => cabins.map((c) => new THREE.EdgesGeometry(new THREE.BoxGeometry(c.w, H * 0.66, c.d))),
    [cabins, H],
  );
  useEffect(() => () => edges.forEach((e) => e.dispose()), [edges]);

  return (
    <group>
      {cabins.map((c, i) => {
        const y = floorElevation(site, c.floor) + (H * 0.66) / 2;
        return (
          <group key={i} position={[c.x, y, c.z]}>
            {/* glazing */}
            <mesh raycast={() => null}>
              <boxGeometry args={[c.w, H * 0.66, c.d]} />
              <meshStandardMaterial
                color="#cfe4f5"
                transparent
                opacity={0.22}
                depthWrite={false}
                roughness={0.12}
                metalness={0.35}
              />
            </mesh>
            {/* mullions */}
            <lineSegments geometry={edges[i]} raycast={() => null}>
              <lineBasicMaterial color={THEME.accent} transparent opacity={0.6} />
            </lineSegments>
            {/* desk inside, so it reads as an office and not an empty box */}
            <mesh position={[0, -H * 0.2, 0]} raycast={() => null}>
              <boxGeometry args={[c.w * 0.5, 0.08, c.d * 0.35]} />
              <meshStandardMaterial color="#e6eef6" roughness={0.6} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
});

/* ========================================================================== */
/* Public                                                                     */
/* ========================================================================== */

export default function SiteArchitecture({ siteId }: { siteId: SiteId }) {
  /**
   * The exterior is hidden during the kinematic deep dive: the camera is
   * inside a machine at that point, and a city block behind the wall is pure
   * overdraw for something nobody can see.
   */
  const groupRef = useRef<THREE.Group>(null);
  useFrame(() => {
    const g = groupRef.current;
    if (!g) return;
    const st = useMegnetoStore.getState();
    const visible = st.kinematicMachineId === null && st.explodedMachineId === null;
    if (g.visible !== visible) g.visible = visible;
  });

  return (
    <group>
      <group ref={groupRef}>
        <Surroundings siteId={siteId} />
      </group>
      <CirculationCore siteId={siteId} />
      <ManagementCabins siteId={siteId} />
    </group>
  );
}
