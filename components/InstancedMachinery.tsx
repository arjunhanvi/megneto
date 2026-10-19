'use client';

/**
 * SITE-SPECIFIC PRODUCTION FURNITURE
 *
 * The two nodes must not read as the same building with different labels, and
 * the thing that actually distinguishes a garment floor from a press hall is
 * density. A stitching floor is hundreds of small tables packed into rows a
 * person can barely walk between. A press hall is a handful of enormous
 * machines with wide aisles because a forklift has to get round them.
 *
 * ============================================================================
 * ONE DRAW CALL PER CLASS OF OBJECT
 * ============================================================================
 * All of it is instanced. The sewing floor is ~420 tables in a single
 * InstancedMesh of a merged table+head geometry; the press hall is a handful
 * of heavy frames in another. Matrices are written once at mount — this
 * furniture does not move — so the per-frame cost is zero and the only
 * recurring cost is the floor-isolation fade.
 * ============================================================================
 */

import { memo, useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { SITES, floorElevation, type FloorIndex, type SiteId, type ZoneDef } from '@/lib/sites';
import { THEME } from '@/lib/theme';
import { useMegnetoStore } from '@/store/useMegnetoStore';

const dummy = new THREE.Object3D();
const tmpColor = new THREE.Color();

/* -------------------------------------------------------------------------- */
/* Shared: fade a static instanced mesh with its floor                         */
/* -------------------------------------------------------------------------- */

function useStaticFloorFade(
  meshRefs: React.RefObject<THREE.InstancedMesh | null>[],
  floors: FloorIndex[],
) {
  useFrame(() => {
    const active = useMegnetoStore.getState().activeFloor;
    for (let i = 0; i < meshRefs.length; i++) {
      const mesh = meshRefs[i].current;
      if (!mesh) continue;
      const on = active === 'all' || active === floors[i];
      const mat = mesh.material as THREE.MeshStandardMaterial;
      const target = on ? 1 : 0.07;
      mat.opacity = THREE.MathUtils.lerp(mat.opacity, target, 0.09);
      const wantTransparent = mat.opacity < 0.985;
      if (mat.transparent !== wantTransparent) {
        mat.transparent = wantTransparent;
        mat.depthWrite = !wantTransparent;
        mat.needsUpdate = true;
      }
      const visible = mat.opacity > 0.085;
      if (mesh.visible !== visible) mesh.visible = visible;
    }
  });
}

/** Rows of positions inside a zone, respecting an aisle width. */
function layOutRows(
  zone: ZoneDef,
  pitchX: number,
  pitchZ: number,
  margin: number,
): { x: number; z: number; row: number }[] {
  const [minX, minZ, maxX, maxZ] = zone.bounds;
  const out: { x: number; z: number; row: number }[] = [];
  let row = 0;
  for (let z = minZ + margin; z <= maxZ - margin; z += pitchZ) {
    for (let x = minX + margin; x <= maxX - margin; x += pitchX) {
      out.push({ x, z, row });
    }
    row += 1;
  }
  return out;
}

/* ========================================================================== */
/* TIRUPPUR — the sewing floor                                                */
/* ========================================================================== */

const TABLE_ZONES = new Set(['stitch', 'cut', 'knit', 'qc', 'pack']);

/**
 * Ultra-high-density sewing tables. A real Tiruppur unit runs lines of
 * single-needle machines at roughly a 1.3m pitch with a 0.9m gangway, which is
 * tight enough that the floor reads as a wall of work from above — exactly the
 * impression the pitch needs.
 */
const SewingFloor = memo(function SewingFloor({ siteId }: { siteId: SiteId }) {
  const site = SITES[siteId];
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const feedRef = useRef<THREE.InstancedMesh>(null);

  /** table top + leg rail + machine head, merged into one instance. */
  const geometry = useMemo(() => {
    const top = new THREE.BoxGeometry(1.05, 0.06, 0.58).toNonIndexed();
    top.translate(0, 0.74, 0);
    const rail = new THREE.BoxGeometry(0.95, 0.5, 0.08).toNonIndexed();
    rail.translate(0, 0.46, 0);
    const head = new THREE.BoxGeometry(0.38, 0.26, 0.17).toNonIndexed();
    head.translate(-0.16, 0.9, 0);
    const arm = new THREE.BoxGeometry(0.1, 0.22, 0.14).toNonIndexed();
    arm.translate(0.12, 0.88, 0);
    const merged = mergeGeometries([top, rail, head, arm], false);
    [top, rail, head, arm].forEach((g) => g.dispose());
    return merged ?? top;
  }, []);
  useEffect(() => () => geometry.dispose(), [geometry]);

  /** Overhead fabric feed line: a rail per row, also instanced. */
  const feedGeometry = useMemo(() => new THREE.BoxGeometry(1, 0.05, 0.05), []);
  useEffect(() => () => feedGeometry.dispose(), [feedGeometry]);

  const layout = useMemo(() => {
    const tables: { x: number; y: number; z: number; rot: number }[] = [];
    const feeds: { x: number; y: number; z: number; len: number }[] = [];

    for (const zone of site.zones) {
      if (!TABLE_ZONES.has(zone.id)) continue;
      const y = floorElevation(site, zone.floor);
      const [minX, , maxX] = zone.bounds;

      // 1.3m along the line, 1.9m between lines — the gangway.
      const slots = layOutRows(zone, 1.3, 1.9, 1.5);
      for (const s of slots) {
        // Leave the machine footprints clear.
        const clash = site.machines.some(
          (m) =>
            m.floor === zone.floor &&
            Math.abs(m.position[0] - s.x) < m.size[0] / 2 + 1.1 &&
            Math.abs(m.position[2] - s.z) < m.size[2] / 2 + 1.1,
        );
        if (clash) continue;
        tables.push({ x: s.x, y, z: s.z, rot: s.row % 2 === 0 ? 0 : Math.PI });
      }

      // One feed rail per row of tables, slung above the line.
      const rows = new Set(slots.map((s) => s.z));
      for (const z of rows) {
        feeds.push({ x: (minX + maxX) / 2, y: y + 2.5, z, len: maxX - minX - 2.4 });
      }
    }
    return { tables, feeds };
  }, [site]);

  const floorsForFade = useMemo(() => [0 as FloorIndex], []);
  void floorsForFade;

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    layout.tables.forEach((t, i) => {
      dummy.position.set(t.x, t.y, t.z);
      dummy.rotation.set(0, t.rot, 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      tmpColor.setHex(i % 7 === 0 ? 0xdfe9f2 : 0xeaf2f9);
      mesh.setColorAt(i, tmpColor);
    });
    mesh.count = layout.tables.length;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

    const feed = feedRef.current;
    if (!feed) return;
    layout.feeds.forEach((f, i) => {
      dummy.position.set(f.x, f.y, f.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(Math.max(0.5, f.len), 1, 1);
      dummy.updateMatrix();
      feed.setMatrixAt(i, dummy.matrix);
    });
    feed.count = layout.feeds.length;
    feed.instanceMatrix.needsUpdate = true;
  }, [layout]);

  /**
   * These sit on several floors at once, so a single fade value would be
   * wrong. Instead the whole mesh dims unless its floor is shown — the tables
   * are spread across L1-L3, so "all" and any isolated floor both look right
   * because the per-instance floor is baked into the Y of its matrix.
   */
  useFrame(() => {
    const active = useMegnetoStore.getState().activeFloor;
    for (const ref of [meshRef, feedRef]) {
      const mesh = ref.current;
      if (!mesh) continue;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      const target = active === 'all' ? 1 : 0.55;
      mat.opacity = THREE.MathUtils.lerp(mat.opacity, target, 0.08);
      const wantTransparent = mat.opacity < 0.985;
      if (mat.transparent !== wantTransparent) {
        mat.transparent = wantTransparent;
        mat.depthWrite = !wantTransparent;
        mat.needsUpdate = true;
      }
    }
  });

  if (layout.tables.length === 0) return null;

  return (
    <group>
      <instancedMesh
        ref={meshRef}
        args={[geometry, undefined as unknown as THREE.Material, Math.max(1, layout.tables.length)]}
        frustumCulled={false}
        raycast={() => null}
      >
        <meshStandardMaterial roughness={0.62} metalness={0.12} />
      </instancedMesh>

      <instancedMesh
        ref={feedRef}
        args={[feedGeometry, undefined as unknown as THREE.Material, Math.max(1, layout.feeds.length)]}
        frustumCulled={false}
        raycast={() => null}
      >
        <meshStandardMaterial color={THEME.machineTrim} roughness={0.5} metalness={0.45} />
      </instancedMesh>
    </group>
  );
});

/* ========================================================================== */
/* RAJAJINAGAR — the press hall                                               */
/* ========================================================================== */

/**
 * Heavy industry reads as mass and headroom, not density: big frames, long
 * delivery sections, overhead structural steel and ducting, and aisles you
 * could drive through.
 */
const PressHall = memo(function PressHall({ siteId }: { siteId: SiteId }) {
  const site = SITES[siteId];
  const unitRef = useRef<THREE.InstancedMesh>(null);
  const steelRef = useRef<THREE.InstancedMesh>(null);
  const ductRef = useRef<THREE.InstancedMesh>(null);

  /** A press "unit": frame + cylinder housing + ink deck. */
  const unitGeometry = useMemo(() => {
    const frame = new THREE.BoxGeometry(1.5, 2.0, 2.1).toNonIndexed();
    frame.translate(0, 1.0, 0);
    const housing = new THREE.CylinderGeometry(0.42, 0.42, 1.9, 12).toNonIndexed();
    housing.rotateZ(Math.PI / 2);
    housing.translate(0, 1.45, 0);
    const deck = new THREE.BoxGeometry(1.2, 0.3, 1.5).toNonIndexed();
    deck.translate(0, 2.2, 0);
    const merged = mergeGeometries([frame, housing, deck], false);
    [frame, housing, deck].forEach((g) => g.dispose());
    return merged ?? frame;
  }, []);
  useEffect(() => () => unitGeometry.dispose(), [unitGeometry]);

  const beamGeometry = useMemo(() => new THREE.BoxGeometry(1, 0.34, 0.2), []);
  useEffect(() => () => beamGeometry.dispose(), [beamGeometry]);

  const ductGeometry = useMemo(() => new THREE.BoxGeometry(1, 0.62, 0.62), []);
  useEffect(() => () => ductGeometry.dispose(), [ductGeometry]);

  const layout = useMemo(() => {
    const units: { x: number; y: number; z: number }[] = [];
    const beams: { x: number; y: number; z: number; len: number }[] = [];
    const ducts: { x: number; y: number; z: number; len: number }[] = [];

    // Print units line up along each press, which is what makes a six-colour
    // press look like a six-colour press.
    for (const m of site.machines) {
      if (m.kind !== 'press') continue;
      const y = floorElevation(site, m.floor);
      const count = m.id === 'PRS-01' ? 6 : m.id === 'PRS-02' ? 4 : 3;
      const spacing = m.size[0] / (count + 0.4);
      for (let i = 0; i < count; i++) {
        units.push({
          x: m.position[0] - m.size[0] / 2 + spacing * (i + 0.7),
          y,
          z: m.position[2],
        });
      }
    }

    // Overhead structural steel across the full span of every floor.
    const W = site.shell.width;
    const D = site.shell.depth;
    for (const floor of [0, 1, 2] as FloorIndex[]) {
      const y = floorElevation(site, floor) + site.shell.floorHeight - 0.45;
      for (let z = -D / 2 + 3; z <= D / 2 - 3; z += 4.2) {
        beams.push({ x: 0, y, z, len: W - 1.5 });
      }
    }

    // HVAC trunk ducting, ground floor only, running the long axis.
    const y0 = floorElevation(site, 0) + site.shell.floorHeight - 1.3;
    for (const z of [-D * 0.26, D * 0.26]) {
      ducts.push({ x: 0, y: y0, z, len: W - 4 });
    }

    return { units, beams, ducts };
  }, [site]);

  useEffect(() => {
    const apply = (
      mesh: THREE.InstancedMesh | null,
      items: { x: number; y: number; z: number; len?: number }[],
      color: number,
    ) => {
      if (!mesh) return;
      items.forEach((it, i) => {
        dummy.position.set(it.x, it.y, it.z);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(it.len ?? 1, 1, 1);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        tmpColor.setHex(color);
        mesh.setColorAt(i, tmpColor);
      });
      mesh.count = items.length;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    };

    apply(unitRef.current, layout.units, 0xdfe9f2);
    apply(steelRef.current, layout.beams, 0xb6c8d8);
    apply(ductRef.current, layout.ducts, 0xcbd9e6);
  }, [layout]);

  if (layout.units.length === 0 && layout.beams.length === 0) return null;

  return (
    <group>
      <instancedMesh
        ref={unitRef}
        args={[unitGeometry, undefined as unknown as THREE.Material, Math.max(1, layout.units.length)]}
        frustumCulled={false}
        raycast={() => null}
      >
        <meshStandardMaterial roughness={0.46} metalness={0.4} />
      </instancedMesh>

      <instancedMesh
        ref={steelRef}
        args={[beamGeometry, undefined as unknown as THREE.Material, Math.max(1, layout.beams.length)]}
        frustumCulled={false}
        raycast={() => null}
      >
        <meshStandardMaterial roughness={0.55} metalness={0.5} />
      </instancedMesh>

      <instancedMesh
        ref={ductRef}
        args={[ductGeometry, undefined as unknown as THREE.Material, Math.max(1, layout.ducts.length)]}
        frustumCulled={false}
        raycast={() => null}
      >
        <meshStandardMaterial roughness={0.7} metalness={0.25} />
      </instancedMesh>
    </group>
  );
});

/* ========================================================================== */
/* Public                                                                     */
/* ========================================================================== */

export default function InstancedMachinery({ siteId }: { siteId: SiteId }) {
  const site = SITES[siteId];
  return site.kind === 'textile' ? <SewingFloor siteId={siteId} /> : <PressHall siteId={siteId} />;
}
