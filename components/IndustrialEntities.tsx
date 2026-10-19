'use client';

/**
 * THE FLOOR AT FULL SCALE — workforce, logistics, machines, apparatus.
 *
 * ============================================================================
 * THE 3,000-PERSON MESH
 * ============================================================================
 * One `InstancedMesh`, capacity 3,000, one draw call, one merged geometry of
 * ~56 triangles. The expensive part of a crowd this size is not the GPU — a
 * 1650 does 170k triangles in its sleep — it is the CPU loop that has to
 * rewrite 3,000 transform matrices every frame.
 *
 * So the loop does not use `Object3D`. `dummy.position.set(...)` +
 * `updateMatrix()` + `setMatrixAt()` costs a Euler→quaternion conversion, a
 * quaternion→matrix composition and a 16-float array copy, per instance, per
 * frame. At 3,000 instances that is the single most expensive thing in the
 * application.
 *
 * Instead `writeInstanceMatrix` composes translate·rotateY·scale directly into
 * the instance buffer — sixteen float writes, two trig calls, zero allocation,
 * zero intermediate objects. The whole crowd costs one `sin`, one `cos` and
 * sixteen stores per person.
 *
 * Raycasting is also hand-rolled. Three's default `InstancedMesh.raycast`
 * performs a full geometry intersection test for EVERY instance — 3,000 of
 * them on every pointer move, which stalls hard while you drag the camera. The
 * replacement does a cheap ray-sphere test and only against the RF-tagged
 * operators, who are the only people with telemetry worth hovering.
 * ============================================================================
 */

import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import {
  MAX_RENDERED_OPERATORS,
  MOB_CAPACITY,
  SITES,
  STATUS_COLOR,
  STATUS_COLOR_HEX,
  floorElevation,
  type EnvNodeDef,
  type FloorIndex,
  type MachineStatus,
  type SiteId,
} from '@/lib/sites';
import { THEME, THEME_HEX } from '@/lib/theme';
import { getSite, useMegnetoStore } from '@/store/useMegnetoStore';
import DiagnosticMachine from '@/components/DiagnosticMachine';

const dummy = new THREE.Object3D();
const tmpColor = new THREE.Color();

/* ========================================================================== */
/* The hot path                                                               */
/* ========================================================================== */

/**
 * Writes translate · rotateY · uniformScale straight into an InstancedMesh's
 * matrix buffer. three's element order is column-major, hence the transposed
 * look of the sin terms.
 *
 * This exists because it is roughly an order of magnitude cheaper than routing
 * the same transform through an Object3D, and at 3,000 instances per frame
 * that difference is the whole frame budget.
 */
function writeInstanceMatrix(
  arr: Float32Array,
  index: number,
  x: number,
  y: number,
  z: number,
  rotY: number,
  scale: number,
) {
  const o = index << 4; // index * 16
  const c = Math.cos(rotY) * scale;
  const s = Math.sin(rotY) * scale;

  arr[o] = c;
  arr[o + 1] = 0;
  arr[o + 2] = -s;
  arr[o + 3] = 0;

  arr[o + 4] = 0;
  arr[o + 5] = scale;
  arr[o + 6] = 0;
  arr[o + 7] = 0;

  arr[o + 8] = s;
  arr[o + 9] = 0;
  arr[o + 10] = c;
  arr[o + 11] = 0;

  arr[o + 12] = x;
  arr[o + 13] = y;
  arr[o + 14] = z;
  arr[o + 15] = 1;
}

/**
 * Removes an instance from view.
 *
 * Zero scale alone is NOT enough: it collapses the geometry to a point, but
 * the normals collapse with it, and a zero-length normal shades to black. The
 * result is a field of one-pixel black specks scattered over the floor wherever
 * a hidden worker happens to stand — subtle enough to survive code review and
 * very obvious on a projector.
 *
 * So hidden instances are also translated far below the world, where they fall
 * outside the view frustum and rasterise nothing at all.
 */
const HIDDEN_Y = -100000;

function hideInstance(arr: Float32Array, index: number) {
  const o = index << 4;
  arr[o] = 0;
  arr[o + 5] = 0;
  arr[o + 10] = 0;
  arr[o + 12] = 0;
  arr[o + 13] = HIDDEN_Y;
  arr[o + 14] = 0;
  arr[o + 15] = 1;
}

/**
 * Applies a fade without leaving the material transparent when it does not
 * need to be.
 *
 * This matters more than it looks. A transparent material cannot be depth-
 * prepassed or early-z rejected, and three has to sort it back-to-front. On a
 * floor with nineteen machines that is over a hundred meshes shading every
 * pixel they cover whether or not anything is in front of them — measured as
 * the dominant cost in this scene, ahead of the three thousand people.
 *
 * So: opaque at full opacity, transparent only while actually faded.
 */
function applyFade(m: THREE.Material & { opacity: number }, opacity: number) {
  m.opacity = opacity;
  const shouldBeTransparent = opacity < 0.985;
  if (m.transparent !== shouldBeTransparent) {
    m.transparent = shouldBeTransparent;
    m.depthWrite = !shouldBeTransparent;
    m.needsUpdate = true;
  }
}

/* ========================================================================== */
/* THE WORKFORCE                                                              */
/* ========================================================================== */

/** Hover and selection tints, allocated once. */
const HIGHLIGHT_HOVER = new THREE.Color('#ffffff');
const HIGHLIGHT_SELECT = new THREE.Color('#ffb224');

const SECTOR_TINTS = [
  new THREE.Color('#2f9ad4'),
  new THREE.Color('#0c9183'),
  new THREE.Color('#5b55c9'),
  new THREE.Color('#c57600'),
  new THREE.Color('#2b6fb0'),
  new THREE.Color('#0f7f9e'),
  new THREE.Color('#7a52c4'),
  new THREE.Color('#1d9465'),
];

/** State tints for the RF-tagged operators, who override their sector colour. */
const TRACKED_STATE_COLOR = [
  new THREE.Color('#1a8fd1'),
  new THREE.Color('#0c9183'),
  new THREE.Color('#c57600'),
];

export const Workforce = memo(function Workforce({ siteId }: { siteId: SiteId }) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const ringRef = useRef<THREE.InstancedMesh>(null);
  const hoverOperator = useMegnetoStore((s) => s.hoverOperator);
  const selectWorker = useMegnetoStore((s) => s.selectWorker);
  /** Base RGB per instance, so a hover highlight can be reverted exactly. */
  const baseColors = useRef<Float32Array>(new Float32Array(MOB_CAPACITY * 3));
  /** Which instances currently carry a highlight. */
  const litHover = useRef(-1);
  const litSelect = useRef(-1);
  const site = getSite(siteId);
  const trackedCount = site.operators.length;

  /**
   * Body + head merged into ONE geometry so a person is one instance of one
   * mesh. Six-sided cylinder and a detail-0 icosahedron: about 56 triangles,
   * which at 1,850 people is ~104k triangles — a rounding error on a 1650.
   */
  const geometry = useMemo(() => {
    // Both operands must agree on indexing or mergeGeometries returns null.
    // CylinderGeometry is indexed, IcosahedronGeometry is not — so flatten the
    // cylinder first. (Getting this wrong fails SILENTLY and renders a crowd
    // of headless torsos, which is not a thing you want to discover on stage.)
    const body = new THREE.CylinderGeometry(0.17, 0.2, 0.62, 6, 1).toNonIndexed();
    body.translate(0, 0.31, 0);
    const head = new THREE.IcosahedronGeometry(0.135, 0);
    head.translate(0, 0.78, 0);

    const merged = mergeGeometries([body, head], false);
    body.dispose();
    head.dispose();

    if (!merged && process.env.NODE_ENV !== 'production') {
      console.error('[megneto] workforce geometry merge failed — rendering bodies only');
    }
    return merged ?? new THREE.CylinderGeometry(0.17, 0.2, 0.62, 6, 1);
  }, []);

  useEffect(() => () => geometry.dispose(), [geometry]);

  /* ---- colour the crowd once, by sector ---- */
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const { mob } = site;
    for (let i = 0; i < mob.count; i++) {
      tmpColor.copy(SECTOR_TINTS[mob.sectors[i] % SECTOR_TINTS.length]);
      // Per-person brightness jitter, so a thousand identical capsules do not
      // read as a texture.
      const j = 0.86 + ((i * 2654435761) % 1000) / 1000 * 0.28;
      tmpColor.multiplyScalar(j);
      mesh.setColorAt(i, tmpColor);
      const c = i * 3;
      baseColors.current[c] = tmpColor.r;
      baseColors.current[c + 1] = tmpColor.g;
      baseColors.current[c + 2] = tmpColor.b;
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.count = mob.count;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  }, [site]);

  /* ---- custom raycast: cheap, and only the tagged operators ---- */
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const sphere = new THREE.Sphere();
    const inverse = new THREE.Matrix4();
    const localRay = new THREE.Ray();
    const point = new THREE.Vector3();
    const hitPoint = new THREE.Vector3();

    mesh.raycast = (raycaster, intersects) => {
      const s = getSite(siteId);
      const pos = s.positions;
      inverse.copy(mesh.matrixWorld).invert();
      localRay.copy(raycaster.ray).applyMatrix4(inverse);

      const active = useMegnetoStore.getState().activeFloor;
      const mob = s.mob;
      const mobPos = mob.positions;

      /**
       * All three thousand are individually pickable. Three's own
       * InstancedMesh.raycast would run a full geometry intersection per
       * instance — 3,000 triangle meshes tested on every pointer move, which
       * stalls the main thread while you drag. A ray-sphere test is a dot
       * product and a square root, so the whole crowd costs microseconds.
       *
       * Only the nearest hit is pushed: R3F sorts intersections, and handing
       * it hundreds of overlapping hits would waste the sort.
       */
      let bestId = -1;
      let bestDist = Infinity;

      for (let i = 0; i < mob.count; i++) {
        const tracked = i < trackedCount;
        const floor = tracked ? s.operators[i].floor : mob.floors[i];
        if (active !== 'all' && floor !== active) continue;

        const o = i * 3;
        const src = tracked ? pos : mobPos;
        sphere.center.set(src[o], src[o + 1] + 0.5, src[o + 2]);
        sphere.radius = 0.46;
        if (!localRay.intersectSphere(sphere, point)) continue;

        const d = localRay.origin.distanceToSquared(sphere.center);
        if (d < bestDist) {
          bestDist = d;
          bestId = i;
          hitPoint.copy(point);
        }
      }

      if (bestId >= 0) {
        intersects.push({
          distance: raycaster.ray.origin.distanceTo(hitPoint),
          point: hitPoint.clone(),
          object: mesh,
          instanceId: bestId,
        });
      }
    };
  }, [siteId, trackedCount]);

  useFrame(({ clock }) => {
    const mesh = meshRef.current;
    const ring = ringRef.current;
    if (!mesh) return;

    const s = getSite(siteId);
    const { mob } = s;
    const t = clock.elapsedTime;
    const arr = mesh.instanceMatrix.array as Float32Array;
    const active = useMegnetoStore.getState().activeFloor;
    const hoverIdx = useMegnetoStore.getState().hoveredOperatorIndex;
    const showAll = active === 'all';

    /* ---------- the ambient crowd ---------- */
    const home = mob.home;
    const phase = mob.phase;
    const speed = mob.speed;
    const radius = mob.radius;
    const floors = mob.floors;
    const live = mob.positions;

    for (let i = trackedCount; i < mob.count; i++) {
      if (!showAll && floors[i] !== active) {
        hideInstance(arr, i);
        continue;
      }

      const o = i * 3;
      const ph = phase[i];
      const sp = speed[i];
      const r = radius[i];

      // A lazy Lissajous around the home point: two different rates on x and z
      // so the path never degenerates into a visible circle.
      const a = t * sp + ph;
      const x = home[o] + Math.sin(a) * r;
      const z = home[o + 2] + Math.sin(a * 0.73 + 1.7) * r * 0.8;

      live[o] = x;
      live[o + 2] = z;

      // Face the direction of travel. The derivative of the path, cheaply.
      const rot = Math.atan2(Math.cos(a) * sp * r, Math.cos(a * 0.73 + 1.7) * sp * r * 0.584);
      writeInstanceMatrix(arr, i, x, home[o + 1], z, rot, 1);
    }

    /* ---------- the RF-tagged operators, driven by the route sim ---------- */
    const pos = s.positions;
    const headings = s.headings;
    for (let i = 0; i < trackedCount; i++) {
      const op = s.operators[i];
      if (!showAll && op.floor !== active) {
        hideInstance(arr, i);
        if (ring) hideInstance(ring.instanceMatrix.array as Float32Array, i);
        continue;
      }
      const o = i * 3;
      const slabY = floorElevation(s.def, op.floor);
      const bob = pos[o + 1] - slabY;
      const lift = i === hoverIdx ? 1.12 : 1;

      writeInstanceMatrix(arr, i, pos[o], slabY + bob, pos[o + 2], headings[i], lift);

      if (ring) {
        const rarr = ring.instanceMatrix.array as Float32Array;
        const pulse = s.states[i] === 1 ? 1 + Math.sin(t * 3 + i) * 0.14 : 1;
        const scale = pulse * (i === hoverIdx ? 1.5 : 1) * (1 + op.strain * 0.5);
        // Rings lie flat, so they are written as a scaled XZ quad with the
        // ring geometry pre-rotated at construction.
        writeInstanceMatrix(rarr, i, pos[o], slabY + 0.022, pos[o + 2], i === hoverIdx ? t * 1.6 : 0, scale);
      }
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (ring) {
      ring.count = trackedCount;
      ring.instanceMatrix.needsUpdate = true;
    }
  });

  /**
   * Hover and selection highlighting.
   *
   * Only the instances that actually changed are written, and the buffer is
   * only flagged when something changed — repainting 3,000 colours to light
   * one person would be absurd, and `instanceColor.needsUpdate` re-uploads
   * the whole attribute.
   */
  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh || !mesh.instanceColor) return;
    const st = useMegnetoStore.getState();
    const hover = st.hoveredOperatorIndex ?? -1;
    const select = st.selectedWorkerIndex ?? -1;
    if (hover === litHover.current && select === litSelect.current) return;

    const base = baseColors.current;
    const restore = (i: number) => {
      if (i < 0 || i === hover || i === select) return;
      const c = i * 3;
      tmpColor.setRGB(base[c], base[c + 1], base[c + 2]);
      mesh.setColorAt(i, tmpColor);
    };

    restore(litHover.current);
    restore(litSelect.current);

    if (select >= 0) mesh.setColorAt(select, HIGHLIGHT_SELECT);
    if (hover >= 0 && hover !== select) mesh.setColorAt(hover, HIGHLIGHT_HOVER);

    litHover.current = hover;
    litSelect.current = select;
    mesh.instanceColor.needsUpdate = true;
  });

  /* ---- tracked-operator colours, uploaded only on a state change ---- */
  const lastState = useRef<Uint8Array>(new Uint8Array(MAX_RENDERED_OPERATORS).fill(255));
  useFrame(() => {
    const mesh = meshRef.current;
    const ring = ringRef.current;
    if (!mesh) return;
    const s = getSite(siteId);
    const sel = useMegnetoStore.getState();
    for (let i = 0; i < trackedCount; i++) {
      const st = s.states[i];
      if (lastState.current[i] === st) continue;
      lastState.current[i] = st;
      const c = TRACKED_STATE_COLOR[st] ?? TRACKED_STATE_COLOR[0];
      const b = i * 3;
      baseColors.current[b] = c.r;
      baseColors.current[b + 1] = c.g;
      baseColors.current[b + 2] = c.b;
      // A highlighted person keeps their highlight.
      if (i === sel.hoveredOperatorIndex || i === sel.selectedWorkerIndex) continue;
      mesh.setColorAt(i, c);
      ring?.setColorAt(i, c);
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      if (ring?.instanceColor) ring.instanceColor.needsUpdate = true;
    }
  });

  const onMove = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      e.stopPropagation();
      const id = e.instanceId;
      if (id == null) return;
      hoverOperator(id);
    },
    [hoverOperator, trackedCount],
  );

  const onOut = useCallback(() => hoverOperator(null), [hoverOperator]);

  const onClick = useCallback(
    (e: ThreeEvent<MouseEvent>) => {
      e.stopPropagation();
      const id = e.instanceId;
      if (id == null) return;
      const current = useMegnetoStore.getState().selectedWorkerIndex;
      selectWorker(current === id ? null : id);
    },
    [selectWorker],
  );

  /** Flat ring geometry, pre-rotated so the hot loop never touches X rotation. */
  const ringGeometry = useMemo(() => {
    const g = new THREE.RingGeometry(0.26, 0.34, 18);
    g.rotateX(-Math.PI / 2);
    return g;
  }, []);
  useEffect(() => () => ringGeometry.dispose(), [ringGeometry]);

  return (
    <group>
      <instancedMesh
        ref={meshRef}
        args={[geometry, undefined as unknown as THREE.Material, MOB_CAPACITY]}
        frustumCulled={false}
        onPointerMove={onMove}
        onPointerOver={onMove}
        onPointerOut={onOut}
        onClick={onClick}
      >
        <meshStandardMaterial roughness={0.58} metalness={0.05} />
      </instancedMesh>

      {/* Floor beacons for the RF-tagged operators only. */}
      <instancedMesh
        ref={ringRef}
        args={[ringGeometry, undefined as unknown as THREE.Material, MAX_RENDERED_OPERATORS]}
        frustumCulled={false}
        raycast={() => null}
      >
        <meshBasicMaterial color={THEME.accent} transparent opacity={0.72} toneMapped={false} />
      </instancedMesh>
    </group>
  );
});

/* ========================================================================== */
/* LOGISTICS — the exterior dock                                              */
/* ========================================================================== */

const TRUCK_COUNT = 3;
const FORKLIFT_COUNT = 5;

/**
 * The yard. Everything here sits outside the building footprint at ground
 * level, so it only shows when the ground floor (or the whole stack) is in
 * view — a forklift visible while you are isolating the second storey would be
 * a lie about where it is.
 */
export const Logistics = memo(function Logistics({ siteId }: { siteId: SiteId }) {
  const site = SITES[siteId];
  const groupRef = useRef<THREE.Group>(null);
  const truckRef = useRef<THREE.InstancedMesh>(null);
  const forkRef = useRef<THREE.InstancedMesh>(null);

  const W = site.shell.width;
  const D = site.shell.depth;
  /** The apron runs along the south face. */
  const apronZ = D / 2 + 7;
  const dockZ = D / 2 + 1.6;

  /* ---- merged truck: cab + trailer in one instance ---- */
  const truckGeometry = useMemo(() => {
    const trailer = new THREE.BoxGeometry(5.6, 2.4, 2.3);
    trailer.translate(-0.9, 1.5, 0);
    const cab = new THREE.BoxGeometry(1.8, 1.8, 2.1);
    cab.translate(2.8, 1.1, 0);
    const merged = mergeGeometries([trailer, cab], false);
    trailer.dispose();
    cab.dispose();
    return merged ?? trailer;
  }, []);
  useEffect(() => () => truckGeometry.dispose(), [truckGeometry]);

  /* ---- merged forklift: body + mast ---- */
  const forkGeometry = useMemo(() => {
    const body = new THREE.BoxGeometry(1.1, 0.9, 0.85);
    body.translate(0, 0.5, 0);
    const mast = new THREE.BoxGeometry(0.14, 1.5, 0.7);
    mast.translate(0.62, 0.95, 0);
    const merged = mergeGeometries([body, mast], false);
    body.dispose();
    mast.dispose();
    return merged ?? body;
  }, []);
  useEffect(() => () => forkGeometry.dispose(), [forkGeometry]);

  /* ---- per-vehicle constants, fixed at build ---- */
  const trucks = useMemo(
    () =>
      Array.from({ length: TRUCK_COUNT }, (_, i) => ({
        bayX: -W / 2 + 4 + (i * (W - 8)) / Math.max(1, TRUCK_COUNT - 1),
        phase: i * 2.1,
        rate: 0.06 + i * 0.012,
      })),
    [W],
  );

  const forklifts = useMemo(
    () =>
      Array.from({ length: FORKLIFT_COUNT }, (_, i) => ({
        laneX: -W / 2 + 3 + (i * (W - 6)) / Math.max(1, FORKLIFT_COUNT - 1),
        phase: i * 1.37,
        rate: 0.22 + (i % 3) * 0.07,
      })),
    [W],
  );

  useEffect(() => {
    truckRef.current?.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    forkRef.current?.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const t = truckRef.current;
    const f = forkRef.current;
    if (t) {
      for (let i = 0; i < TRUCK_COUNT; i++) {
        tmpColor.setHex(i % 2 === 0 ? 0xdfe9f2 : 0xc9dcec);
        t.setColorAt(i, tmpColor);
      }
      if (t.instanceColor) t.instanceColor.needsUpdate = true;
    }
    if (f) {
      for (let i = 0; i < FORKLIFT_COUNT; i++) {
        tmpColor.setHex(0xffb224);
        f.setColorAt(i, tmpColor);
      }
      if (f.instanceColor) f.instanceColor.needsUpdate = true;
    }
  }, []);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const active = useMegnetoStore.getState().activeFloor;
    const visible = active === 'all' || active === 0;

    const group = groupRef.current;
    if (group && group.visible !== visible) group.visible = visible;
    if (!visible) return;

    /* ---- trucks: pull along the apron, hold at the bay, pull away ---- */
    const truckMesh = truckRef.current;
    if (truckMesh) {
      const arr = truckMesh.instanceMatrix.array as Float32Array;
      for (let i = 0; i < TRUCK_COUNT; i++) {
        const cfg = trucks[i];
        // A slow triangle-ish sweep: sin gives the dwell at each end for free,
        // which reads as loading time without any state machine.
        const s = Math.sin(t * cfg.rate + cfg.phase);
        const x = cfg.bayX + s * (W * 0.42);
        // Heading flips with the direction of travel.
        const dir = Math.cos(t * cfg.rate + cfg.phase);
        writeInstanceMatrix(arr, i, x, 0, apronZ, dir >= 0 ? 0 : Math.PI, 1);
      }
      truckMesh.instanceMatrix.needsUpdate = true;
    }

    /* ---- forklifts: shuttle between the dock face and the apron ---- */
    const forkMesh = forkRef.current;
    if (forkMesh) {
      const arr = forkMesh.instanceMatrix.array as Float32Array;
      for (let i = 0; i < FORKLIFT_COUNT; i++) {
        const cfg = forklifts[i];
        const a = t * cfg.rate + cfg.phase;
        const s = Math.sin(a);
        const z = dockZ + (s * 0.5 + 0.5) * (apronZ - dockZ - 1.2);
        // A little lateral drift so five forklifts do not run as five pistons.
        const x = cfg.laneX + Math.sin(a * 0.41) * 1.6;
        const dir = Math.cos(a);
        writeInstanceMatrix(arr, i, x, 0, z, dir >= 0 ? Math.PI / 2 : -Math.PI / 2, 1);
      }
      forkMesh.instanceMatrix.needsUpdate = true;
    }
  });

  return (
    <group ref={groupRef}>
      {/* Apron */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.04, (apronZ + dockZ) / 2]} raycast={() => null}>
        <planeGeometry args={[W + 6, apronZ - dockZ + 7]} />
        <meshStandardMaterial color="#c3d4e2" roughness={0.98} metalness={0} />
      </mesh>

      {/* Bay markings */}
      {trucks.map((cfg, i) => (
        <mesh
          key={i}
          rotation={[-Math.PI / 2, 0, 0]}
          position={[cfg.bayX, -0.03, apronZ]}
          raycast={() => null}
        >
          <planeGeometry args={[7.2, 3.2]} />
          <meshBasicMaterial color="#ffffff" transparent opacity={0.45} />
        </mesh>
      ))}

      {/* Dock doors along the south face */}
      {trucks.map((cfg, i) => (
        <mesh key={`d${i}`} position={[cfg.bayX, 1.5, D / 2 + 0.2]} raycast={() => null}>
          <boxGeometry args={[4.2, 3, 0.3]} />
          <meshStandardMaterial color="#8fb0c8" roughness={0.8} metalness={0.1} />
        </mesh>
      ))}

      <instancedMesh
        ref={truckRef}
        args={[truckGeometry, undefined as unknown as THREE.Material, TRUCK_COUNT]}
        frustumCulled={false}
        raycast={() => null}
      >
        <meshStandardMaterial roughness={0.52} metalness={0.22} />
      </instancedMesh>

      <instancedMesh
        ref={forkRef}
        args={[forkGeometry, undefined as unknown as THREE.Material, FORKLIFT_COUNT]}
        frustumCulled={false}
        raycast={() => null}
      >
        <meshStandardMaterial roughness={0.56} metalness={0.18} />
      </instancedMesh>
    </group>
  );
});

/* ========================================================================== */
/* WARNING AURA — shared by the apparatus                                     */
/* ========================================================================== */

function Aura({
  radius,
  color,
  active,
  height = 1,
}: {
  radius: number;
  color: string;
  active: () => boolean;
  height?: number;
}) {
  const shellRef = useRef<THREE.Mesh>(null);
  const discRef = useRef<THREE.Mesh>(null);

  useFrame(({ clock }) => {
    const on = active();
    const t = clock.elapsedTime;

    if (shellRef.current) {
      const mat = shellRef.current.material as THREE.MeshBasicMaterial;
      const target = on ? 0.17 + Math.abs(Math.sin(t * 2.1)) * 0.16 : 0;
      mat.opacity = THREE.MathUtils.lerp(mat.opacity, target, 0.12);
      shellRef.current.visible = mat.opacity > 0.01;
      const s = on ? 1 + Math.sin(t * 2.1) * 0.06 : 1;
      shellRef.current.scale.set(s, s, s);
    }

    if (discRef.current) {
      const mat = discRef.current.material as THREE.MeshBasicMaterial;
      const target = on ? 0.3 + Math.abs(Math.sin(t * 3.4)) * 0.3 : 0;
      mat.opacity = THREE.MathUtils.lerp(mat.opacity, target, 0.14);
      discRef.current.visible = mat.opacity > 0.01;
      const ripple = 1 + ((t * 0.55) % 1) * 0.85;
      discRef.current.scale.set(ripple, ripple, ripple);
    }
  });

  return (
    <group raycast={() => null}>
      <mesh ref={shellRef} position={[0, height * 0.55, 0]} raycast={() => null}>
        <sphereGeometry args={[radius, 16, 12]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
          side={THREE.BackSide}
        />
      </mesh>
      <mesh ref={discRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]} raycast={() => null}>
        <ringGeometry args={[radius * 0.62, radius * 0.78, 40]} />
        <meshBasicMaterial color={color} transparent opacity={0} depthWrite={false} toneMapped={false} />
      </mesh>
    </group>
  );
}

/* ========================================================================== */
/* MACHINES                                                                   */
/* ========================================================================== */

export const Machines = memo(function Machines({ siteId }: { siteId: SiteId }) {
  const def = SITES[siteId];
  return (
    <group>
      {def.machines.map((m, i) => (
        <DiagnosticMachine key={m.id} siteId={siteId} def={m} index={i} />
      ))}
    </group>
  );
});

/* ========================================================================== */
/* ENVIRONMENTAL APPARATUS                                                    */
/* ========================================================================== */

function useFloorFade(groupRef: React.RefObject<THREE.Group | null>, floor: FloorIndex) {
  const mats = useRef<THREE.Material[]>([]);

  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    const out: THREE.Material[] = [];
    group.traverse((obj) => {
      const withMat = obj as THREE.Mesh & { material?: THREE.Material | THREE.Material[] };
      if (!withMat.material) return;
      const list = Array.isArray(withMat.material) ? withMat.material : [withMat.material];
      for (const m of list) out.push(m);
    });
    mats.current = out;
  }, [groupRef]);

  useFrame(() => {
    const active = useMegnetoStore.getState().activeFloor;
    const on = active === 'all' || active === floor;
    const target = on ? 1 : 0.07;
    const list = mats.current;
    if (list.length === 0) return;
    for (const m of list) {
      applyFade(m as THREE.Material & { opacity: number }, THREE.MathUtils.lerp(m.opacity, target, 0.09));
    }
    const group = groupRef.current;
    if (group) {
      const visible = list[0].opacity > 0.085;
      if (group.visible !== visible) group.visible = visible;
    }
  });
}

export const EnvNodes = memo(function EnvNodes({ siteId }: { siteId: SiteId }) {
  const def = SITES[siteId];
  return (
    <group>
      {def.envNodes.map((n) => (
        <EnvNode key={n.id} siteId={siteId} def={n} />
      ))}
    </group>
  );
});

/** Each apparatus gets a silhouette you could recognise on a real site visit. */
function EnvGeometry({ def }: { def: EnvNodeDef }) {
  const [sx, sy, sz] = def.size;

  switch (def.kind) {
    case 'zld':
      return def.id.includes('MEE') ? (
        <group>
          <mesh position={[0, sy / 2, 0]}>
            <cylinderGeometry args={[sx * 0.42, sx * 0.42, sy, 18]} />
            <meshStandardMaterial color="#dfe9f2" roughness={0.42} metalness={0.5} />
          </mesh>
          <mesh position={[0, sy + 0.18, 0]} raycast={() => null}>
            <cylinderGeometry args={[sx * 0.2, sx * 0.2, 0.36, 12]} />
            <meshStandardMaterial color={THEME.machineTrim} roughness={0.5} metalness={0.6} />
          </mesh>
        </group>
      ) : (
        <group>
          {[0, 1, 2].map((i) => (
            <mesh key={i} position={[0, 0.5 + i * 0.62, 0]} rotation={[0, 0, Math.PI / 2]}>
              <cylinderGeometry args={[0.26, 0.26, sz * 0.96, 14]} />
              <meshStandardMaterial color="#e6eef6" roughness={0.4} metalness={0.55} />
            </mesh>
          ))}
          <mesh position={[0, 0.2, 0]} raycast={() => null}>
            <boxGeometry args={[sx * 0.9, 0.4, sz * 0.9]} />
            <meshStandardMaterial color={THEME.machineTrim} roughness={0.7} metalness={0.2} />
          </mesh>
        </group>
      );

    case 'dyevat':
      return (
        <group>
          <mesh position={[0, sy / 2, 0]}>
            <boxGeometry args={[sx, sy, sz]} />
            <meshStandardMaterial color="#e9eef4" roughness={0.5} metalness={0.3} />
          </mesh>
          <mesh position={[0, sy + 0.22, 0]} rotation={[0, 0, Math.PI / 2]} raycast={() => null}>
            <cylinderGeometry args={[0.12, 0.12, sx * 1.1, 10]} />
            <meshStandardMaterial color="#b9c9d8" roughness={0.35} metalness={0.75} />
          </mesh>
        </group>
      );

    case 'humidity':
      return (
        <group>
          <mesh position={[0, sy / 2, 0]}>
            <boxGeometry args={[sx, sy, sz]} />
            <meshStandardMaterial color="#eaf2f9" roughness={0.6} metalness={0.15} />
          </mesh>
          {[-0.5, 0, 0.5].map((o, i) => (
            <mesh key={i} position={[o * sx * 0.6, sy + 0.16, 0]} raycast={() => null}>
              <coneGeometry args={[0.1, 0.26, 8]} />
              <meshStandardMaterial color={THEME.accent} roughness={0.4} metalness={0.4} />
            </mesh>
          ))}
        </group>
      );

    case 'voc':
      return (
        <group>
          <mesh position={[0, sy * 0.4, 0]}>
            <cylinderGeometry args={[sx * 0.45, sx * 0.45, sy * 0.8, 16]} />
            <meshStandardMaterial color="#e4ecf4" roughness={0.45} metalness={0.45} />
          </mesh>
          <mesh position={[0, sy * 0.95, 0]} raycast={() => null}>
            <cylinderGeometry args={[0.2, 0.26, sy * 0.5, 12]} />
            <meshStandardMaterial color={THEME.machineTrim} roughness={0.4} metalness={0.65} />
          </mesh>
        </group>
      );

    case 'dust':
      return (
        <group>
          <mesh position={[0, sy * 0.62, 0]}>
            <cylinderGeometry args={[sx * 0.4, sx * 0.4, sy * 0.5, 16]} />
            <meshStandardMaterial color="#e8eef5" roughness={0.5} metalness={0.4} />
          </mesh>
          <mesh position={[0, sy * 0.22, 0]} raycast={() => null}>
            <coneGeometry args={[sx * 0.4, sy * 0.45, 16]} />
            <meshStandardMaterial color="#d9e4ee" roughness={0.55} metalness={0.35} />
          </mesh>
        </group>
      );

    case 'power':
    default:
      return (
        <group>
          <mesh position={[0, sy / 2, 0]}>
            <boxGeometry args={[sx, sy, sz]} />
            <meshStandardMaterial color="#e3ebf3" roughness={0.55} metalness={0.35} />
          </mesh>
          {[-0.35, 0, 0.35].map((o, i) => (
            <mesh key={i} position={[o * sx, sy + 0.24, 0]} raycast={() => null}>
              <cylinderGeometry args={[0.09, 0.13, 0.46, 10]} />
              <meshStandardMaterial color="#b0c2d2" roughness={0.3} metalness={0.8} />
            </mesh>
          ))}
        </group>
      );
  }
}

function EnvNode({ siteId, def }: { siteId: SiteId; def: EnvNodeDef }) {
  const outerRef = useRef<THREE.Group>(null);
  const groupRef = useRef<THREE.Group>(null);
  const haloRef = useRef<THREE.Mesh>(null);
  const beaconRef = useRef<THREE.Mesh>(null);
  const lastStatus = useRef<MachineStatus | null>(null);

  const selected = useMegnetoStore((s) => s.selectedEnvNodeId === def.id);
  const actOnEnvNode = useMegnetoStore((s) => s.actOnEnvNode);

  useFloorFade(outerRef, def.floor);

  const isAlerting = useCallback(() => {
    const n = getSite(siteId).envNodes.find((x) => x.def.id === def.id);
    return Boolean(n?.alert);
  }, [siteId, def.id]);

  useFrame(({ clock }) => {
    const node = getSite(siteId).envNodes.find((n) => n.def.id === def.id);
    if (!node) return;
    const t = clock.elapsedTime;

    if (lastStatus.current !== node.status) {
      lastStatus.current = node.status;
      tmpColor.setHex(STATUS_COLOR_HEX[node.status]);
      const haloMat = haloRef.current?.material as THREE.MeshBasicMaterial | undefined;
      if (haloMat) haloMat.color.copy(tmpColor);
      const beaconMat = beaconRef.current?.material as THREE.MeshBasicMaterial | undefined;
      if (beaconMat) beaconMat.color.copy(tmpColor);
    }

    const faulted = node.status === 'warning' || node.status === 'critical';
    const strobe = faulted ? 0.35 + Math.abs(Math.sin(t * 6)) * 0.9 : 0.42 + Math.sin(t * 1.4) * 0.16;
    if (beaconRef.current) beaconRef.current.scale.setScalar(0.9 + strobe * 0.55);

    if (haloRef.current) {
      const mat = haloRef.current.material as THREE.MeshBasicMaterial;
      mat.opacity = (selected ? 0.6 : 0.34) + (faulted ? Math.abs(Math.sin(t * 6)) * 0.34 : 0);
    }

    if (groupRef.current) {
      const duty = THREE.MathUtils.clamp(node.primary / Math.max(1, node.primary + node.secondary), 0, 1);
      groupRef.current.position.y = Math.sin(t * 6) * 0.004 * (faulted ? 3 : 1) * (0.4 + duty);
    }
  });

  const onClick = useCallback(
    (e: ThreeEvent<MouseEvent>) => {
      e.stopPropagation();
      actOnEnvNode(def.id);
    },
    [def.id, actOnEnvNode],
  );

  const [sx, sy, sz] = def.size;
  const elevation = floorElevation(SITES[siteId], def.floor);

  return (
    <group ref={outerRef} position={[def.position[0], elevation + def.position[1], def.position[2]]}>
      <group ref={groupRef} onClick={onClick}>
        <EnvGeometry def={def} />
      </group>

      <mesh ref={beaconRef} position={[sx / 2 - 0.1, sy + 0.5, sz / 2 - 0.1]} raycast={() => null}>
        <sphereGeometry args={[0.1, 10, 8]} />
        <meshBasicMaterial color={STATUS_COLOR.nominal} toneMapped={false} />
      </mesh>

      <mesh ref={haloRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]} raycast={() => null}>
        <ringGeometry args={[Math.max(sx, sz) * 0.7, Math.max(sx, sz) * 0.88, 40]} />
        <meshBasicMaterial color={STATUS_COLOR.nominal} transparent opacity={0.34} toneMapped={false} />
      </mesh>

      <Aura
        radius={Math.max(sx, sz) * 1.25}
        height={sy}
        color={def.kind === 'voc' ? '#8a5fd0' : def.kind === 'dust' ? '#b08640' : '#d13a57'}
        active={isAlerting}
      />
    </group>
  );
}

/* ========================================================================== */
/* STATIC DRESSING                                                            */
/* ========================================================================== */

export const Pallets = memo(function Pallets({ siteId }: { siteId: SiteId }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const def = SITES[siteId];

  const slots = useMemo(() => {
    const out: { pos: [number, number, number]; floor: FloorIndex }[] = [];
    def.zones.forEach((zone, zi) => {
      const [minX, minZ, maxX, maxZ] = zone.bounds;
      const count = 2 + (zi % 3);
      const y = floorElevation(def, zone.floor);
      for (let i = 0; i < count; i++) {
        const x = minX + 1.1 + ((i * 1.3 + zi * 0.5) % Math.max(1, maxX - minX - 2.4));
        const z = zi % 2 === 0 ? minZ + 1.0 : maxZ - 1.0;
        out.push({ pos: [x, y, z], floor: zone.floor });
      }
    });
    return out;
  }, [def]);

  useEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    slots.forEach((slot, i) => {
      const p = slot.pos;
      const h = 0.36 + ((i * 37) % 5) * 0.13;
      dummy.position.set(p[0], p[1] + h / 2, p[2]);
      dummy.rotation.set(0, ((i * 53) % 8) * 0.22, 0);
      dummy.scale.set(1, h / 0.5, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      tmpColor.setHex(THEME_HEX.pallets[i % 3]);
      mesh.setColorAt(i, tmpColor);
    });
    mesh.count = slots.length;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [slots]);

  const lastFloor = useRef<string>('');
  useFrame(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const active = String(useMegnetoStore.getState().activeFloor);
    if (active === lastFloor.current) return;
    lastFloor.current = active;
    const arr = mesh.instanceMatrix.array as Float32Array;
    slots.forEach((slot, i) => {
      const on = active === 'all' || Number(active) === slot.floor;
      if (!on) {
        hideInstance(arr, i);
        return;
      }
      const h = 0.36 + ((i * 37) % 5) * 0.13;
      const p = slot.pos;
      dummy.position.set(p[0], p[1] + h / 2, p[2]);
      dummy.rotation.set(0, ((i * 53) % 8) * 0.22, 0);
      dummy.scale.set(1, h / 0.5, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh
      ref={ref}
      args={[
        undefined as unknown as THREE.BufferGeometry,
        undefined as unknown as THREE.Material,
        Math.max(1, slots.length),
      ]}
      frustumCulled={false}
      raycast={() => null}
    >
      <boxGeometry args={[0.82, 0.5, 0.82]} />
      <meshStandardMaterial color="#ffffff" roughness={0.9} metalness={0.04} />
    </instancedMesh>
  );
});
