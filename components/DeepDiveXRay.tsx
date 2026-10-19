'use client';

/**
 * THE LOCKED X-RAY DIVE
 *
 * ============================================================================
 * WHAT THIS REPLACES AND WHY
 * ============================================================================
 * V6's deep dive put one moving part on top of the low-poly machine and left
 * the camera free. Two problems showed up the moment it was rehearsed:
 *
 *  1. The investor could orbit away from the mechanism mid-sentence. The
 *     whole demonstration is "watch this part move, watch the counter follow
 *     it", and it only works if both are on screen.
 *  2. A 2.4m box with a needle on top is not a machine. The claim is that we
 *     recognise manufacturing ACTION, and the action has to be legible.
 *
 * So: the camera locks, the low-poly instance is swapped for the full
 * mechanism from `lib/machineInventory.ts`, the casing goes to glass, and a
 * blueprint HUD takes the screen until the user explicitly disengages.
 *
 * ============================================================================
 * THE LOD SWAP, AND WHAT IT COSTS
 * ============================================================================
 * `InstancedMachinery` draws the whole floor's plant as a handful of merged
 * instanced meshes. It stays mounted — hiding it would re-upload matrices on
 * the way back out — but the ONE machine being inspected is masked out of it
 * (see `xrayMachineId` in the store) and this component draws it properly
 * instead.
 *
 * The six-colour press is the worst case in the catalogue: 42 parts, around
 * 11k triangles, plus 310 bolt heads as a single instanced mesh. That is a
 * rounding error next to the 3,000-person crowd, and the crowd is hidden
 * during the dive anyway. Measured cost of the dive is LOWER than the floor
 * view it replaces, which is the opposite of what you would expect and is
 * entirely down to the city and the envelope switching off.
 *
 * ============================================================================
 * THE PHASE STILL COMES FROM THE STORE. ALL OF IT.
 * ============================================================================
 * Not one part in this file owns a clock, a timer or an elapsed value. Every
 * moving component reads `machine.kin` — the same accumulator that increments
 * `unitsBuilt` in `stepKinematics` — and converts it through
 * `evaluateMotion`. Jam the machine and `strokeHz` hits zero, so `kin` stops,
 * so all 42 parts stop on the same frame as the counter.
 *
 * That is the entire claim, and it is why the mechanism is data-driven: there
 * is no per-machine animation code that could drift from the count.
 * ============================================================================
 */

import { Suspense, memo, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, useLoader } from '@react-three/fiber';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import {
  KINEMATICS,
  SITES,
  floorElevation,
  type MachineDef,
  type SiteId,
} from '@/lib/sites';
import {
  archetypeFor,
  axisIndex,
  evaluateMotion,
  isRotation,
  mechanismScale,
  type FaultSpec,
  type MachineArchetype,
  type MechanismPart,
  type PartFinish,
} from '@/lib/machineInventory';
import { SCENE } from '@/lib/theme';
import { getSite, useMegnetoStore, type MachineRuntime } from '@/store/useMegnetoStore';

/* ========================================================================== */
/* MATERIALS                                                                  */
/* ========================================================================== */

/**
 * One material per finish, shared across every part in the scene.
 *
 * Built once, module-level, and never disposed: there are nine of them, they
 * total a few hundred bytes of uniforms, and rebuilding them per dive would
 * mean a shader compile every time the user opens a machine. The environment
 * map from `LightingAndEffects` is what makes these read as metal — without
 * it `chrome` and `castIron` look identical.
 */
function buildFinishes(): Record<PartFinish, THREE.Material> {
  const std = (
    color: string,
    roughness: number,
    metalness: number,
    extra: Partial<THREE.MeshStandardMaterialParameters> = {},
  ) => new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });

  return {
    /* Machined grey iron: matte, slightly warm, no mirror. */
    castIron: std('#6e7a85', 0.72, 0.35),
    /* Mild steel, lightly oiled. */
    steel: std('#9aa8b4', 0.42, 0.78),
    /* Hard chrome plating. This is the one that needs the env map. */
    chrome: std('#dfe9f2', 0.09, 0.96),
    /* Nitrile roller covering: dark, dead matte, zero metalness. */
    rubber: std('#2a2f34', 0.92, 0.02),
    /* Bearing bronze. */
    brass: std('#c9a227', 0.3, 0.85),
    /* Copper anilox and bus-bar. */
    copper: std('#c07a4a', 0.34, 0.88),
    /* ---- the enclosure, and the whole reason this is called an X-ray ----
     *
     * `housing` is the finish every archetype uses for the parts that WRAP
     * the mechanism: side frames, cabinets, chambers, side plates, benches.
     * Rendered solid — which is what a real machine does — they occlude the
     * thing the view exists to show. On the six-colour press the operator-
     * side frame is a 7.2m x 2.7m panel sitting directly between the camera
     * and all six cylinder stacks, so the deep dive framed a blank wall.
     *
     * So the enclosure is the part that goes to blueprint: a faint ghost
     * that still reads as a surface and still catches a highlight, with the
     * mechanism behind it fully legible. Solid metal — chrome, cast iron,
     * rubber, brass — is untouched, because those ARE the moving parts.
     *
     * `depthWrite: false` matters here: with it on, the ghost would write
     * depth and hide the cylinders behind it just as effectively as an
     * opaque panel would, which rather misses the point.
     */
    housing: std('#9ec8e4', 0.4, 0.1, {
      transparent: true,
      opacity: 0.17,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
    /* Inspection glazing. */
    glass: new THREE.MeshPhysicalMaterial({
      color: '#bfe4f7',
      roughness: 0.06,
      metalness: 0.0,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
    }),
    /* Anything that is its own light source. Unlit, so bloom takes it. */
    emissive: new THREE.MeshBasicMaterial({ color: '#ffd9a0', toneMapped: false }),
  };
}

let FINISHES: Record<PartFinish, THREE.Material> | null = null;
function finishes() {
  if (!FINISHES) FINISHES = buildFinishes();
  return FINISHES;
}

/**
 * The blueprint casing material.
 *
 * The brief asks for "a glowing wireframe or a glass transmission shader".
 * This is the wireframe, plus a faint shell to give it a surface — see the
 * note inside the function for why the transmission shader was tried and
 * taken back out.
 */
function buildCasingMaterials() {
  /* ---- plain transparency, NOT `transmission` ----
   *
   * This started as a `transmission: 0.92` physical material, which is the
   * textbook way to do a glass casing and was wrong here for two reasons,
   * both found by looking at it:
   *
   *  1. Transmission samples the BACKDROP and blurs it by the material's
   *     roughness. At the macro lens the casing covers the entire viewport,
   *     so the one thing it was blurring was the mechanism it exists to
   *     reveal. The lockstitch head came out looking like frosted plastic.
   *  2. It forces an extra full render of the scene into a transmission
   *     target every frame — on a 4GB card, for an effect that was actively
   *     making the subject harder to read.
   *
   * A faint transparent shell plus bright blueprint edges does the job the
   * brief actually wants: you can see it is a casing, you can see straight
   * through it, and it costs one draw.
   */
  const glass = new THREE.MeshPhysicalMaterial({
    color: '#9fd8f5',
    metalness: 0.0,
    roughness: 0.25,
    transparent: true,
    opacity: 0.4,
    depthWrite: false,
    side: THREE.BackSide,
  });
  const wire = new THREE.LineBasicMaterial({
    color: SCENE.blueprint,
    transparent: true,
    opacity: 0.85,
    toneMapped: false,
  });
  return { glass, wire };
}

/* ========================================================================== */
/* GEOMETRY                                                                   */
/* ========================================================================== */

/** Part spec to geometry. Cached per spec signature for the session. */
const GEO_CACHE = new Map<string, THREE.BufferGeometry>();

function geometryFor(part: MechanismPart): THREE.BufferGeometry {
  const key = `${part.shape}:${part.args.join(',')}`;
  let g = GEO_CACHE.get(key);
  if (g) return g;

  const a = part.args;
  switch (part.shape) {
    case 'box':
      g = new THREE.BoxGeometry(a[0], a[1], a[2]);
      break;
    case 'cylinder':
      g = new THREE.CylinderGeometry(a[0], a[1], a[2], a[3] ?? 16);
      break;
    case 'sphere':
      g = new THREE.SphereGeometry(a[0], a[1] ?? 16, a[2] ?? 12);
      break;
    case 'cone':
      g = new THREE.ConeGeometry(a[0], a[1], a[2] ?? 12);
      break;
    case 'torus':
      g = new THREE.TorusGeometry(a[0], a[1], a[2] ?? 8, a[3] ?? 16);
      break;
  }
  GEO_CACHE.set(key, g);
  return g;
}

/** One hex head. Shared by every bolt in the building. */
const BOLT_GEO = new THREE.CylinderGeometry(0.018, 0.018, 0.016, 6);

/* ========================================================================== */
/* THE MECHANISM                                                              */
/* ========================================================================== */

/**
 * One driven part. Reads the machine's phase and writes a single component of
 * its own transform.
 *
 * Every driven part in the archetype gets one of these, so the six-colour
 * press runs 38 of them. They are deliberately as cheap as a `useFrame` can
 * be: one store lookup via a ref the parent already resolved, one function
 * call, one array write. No allocation, no `Vector3`, no matrix maths.
 */
const DrivenPart = memo(function DrivenPart({
  part,
  machineRef,
}: {
  part: MechanismPart;
  machineRef: React.MutableRefObject<MachineRuntime | null>;
}) {
  const ref = useRef<THREE.Mesh>(null);
  const motion = part.motion!;
  const idx = axisIndex(motion.axis);
  const rotational = isRotation(motion.axis);
  const base = rotational
    ? (part.rotation?.[idx] ?? 0)
    : part.position[idx];

  useFrame(() => {
    const mesh = ref.current;
    const machine = machineRef.current;
    if (!mesh || !machine) return;
    // THE one read. `kin` is the production phase; nothing else is consulted,
    // which is why a jam freezes this part on the same frame as the counter.
    const value = base + evaluateMotion(motion, machine.kin);
    if (rotational) {
      if (idx === 0) mesh.rotation.x = value;
      else if (idx === 1) mesh.rotation.y = value;
      else mesh.rotation.z = value;
    } else {
      if (idx === 0) mesh.position.x = value;
      else if (idx === 1) mesh.position.y = value;
      else mesh.position.z = value;
    }
  });

  return (
    <mesh
      ref={ref}
      /* Named so the mechanism can be inspected from the console during a
       * rehearsal — `scene.getObjectByName('needle-bar').position.y` against
       * `machine.kin` is how the kinematic claim gets verified. */
      name={part.id}
      geometry={geometryFor(part)}
      material={finishes()[part.finish]}
      position={part.position as unknown as THREE.Vector3Tuple}
      rotation={(part.rotation ?? [0, 0, 0]) as unknown as THREE.Vector3Tuple}
      raycast={() => null}
    />
  );
});

/** Static structure. No frame callback at all — it genuinely never moves. */
const StaticPart = memo(function StaticPart({ part }: { part: MechanismPart }) {
  return (
    <mesh
      geometry={geometryFor(part)}
      material={finishes()[part.finish]}
      position={part.position as unknown as THREE.Vector3Tuple}
      rotation={(part.rotation ?? [0, 0, 0]) as unknown as THREE.Vector3Tuple}
      raycast={() => null}
    />
  );
});

/**
 * Every bolt in the machine, as ONE instanced mesh.
 *
 * The six-colour press declares bolt rings on 40 parts; drawn individually
 * that would be 310 draw calls for 310 hex heads. Collapsed here into one
 * instance buffer written once on mount. This is the single detail that most
 * sells "nut and bolt" and it costs one draw.
 */
const BoltField = memo(function BoltField({ parts }: { parts: readonly MechanismPart[] }) {
  const ref = useRef<THREE.InstancedMesh>(null);

  const bolts = useMemo(() => {
    const out: { x: number; y: number; z: number; rx: number; rz: number }[] = [];
    for (const p of parts) {
      if (!p.bolts) continue;
      const { count, radius, plane } = p.bolts;
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2;
        if (plane === 'xy') {
          out.push({
            x: p.position[0] + Math.cos(a) * radius,
            y: p.position[1] + Math.sin(a) * radius,
            z: p.position[2],
            // Heads face along Z on an end flange.
            rx: Math.PI / 2,
            rz: 0,
          });
        } else {
          out.push({
            x: p.position[0] + Math.cos(a) * radius,
            y: p.position[1],
            z: p.position[2] + Math.sin(a) * radius,
            rx: 0,
            rz: 0,
          });
        }
      }
    }
    return out;
  }, [parts]);

  useLayoutEffect(() => {
    const m = ref.current;
    if (!m || bolts.length === 0) return;
    const o = new THREE.Object3D();
    bolts.forEach((b, i) => {
      o.position.set(b.x, b.y, b.z);
      o.rotation.set(b.rx, 0, b.rz);
      o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
    });
    m.instanceMatrix.needsUpdate = true;
    m.computeBoundingSphere();
  }, [bolts]);

  if (bolts.length === 0) return null;

  return (
    <instancedMesh
      ref={ref}
      args={[BOLT_GEO, undefined, bolts.length]}
      frustumCulled={false}
      raycast={() => null}
    >
      <meshStandardMaterial color="#8c99a5" roughness={0.38} metalness={0.9} />
    </instancedMesh>
  );
});

/* ========================================================================== */
/* THE TRACKER                                                                */
/* ========================================================================== */

const LOCK = new THREE.Color(SCENE.blueprint);
const LOST = new THREE.Color(SCENE.blueprintWarn);
const tmpColor = new THREE.Color();

/**
 * The AI bounding box, locked onto the part the model is actually watching.
 *
 * It follows the tracked part's live transform rather than sitting on the
 * machine, because a tracker that does not move with its subject is obviously
 * decoration. When the machine stops it goes red and blinks — a real tracker
 * that has lost its subject does not sit there calmly reporting LOCK.
 */
function TrackerBox({
  part,
  machineRef,
}: {
  part: MechanismPart;
  machineRef: React.MutableRefObject<MachineRuntime | null>;
}) {
  const ref = useRef<THREE.LineSegments>(null);
  const motion = part.motion;

  const geometry = useMemo(() => {
    const g = geometryFor(part);
    g.computeBoundingBox();
    const b = g.boundingBox!;
    // A 35% margin: a tracker box drawn exactly on the silhouette reads as an
    // outline, not as a detection.
    const pad = 1.35;
    return new THREE.EdgesGeometry(
      new THREE.BoxGeometry(
        Math.max(0.06, (b.max.x - b.min.x) * pad),
        Math.max(0.06, (b.max.y - b.min.y) * pad),
        Math.max(0.06, (b.max.z - b.min.z) * pad),
      ),
    );
  }, [part]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  const idx = motion ? axisIndex(motion.axis) : 1;
  const rotational = motion ? isRotation(motion.axis) : false;
  const base = motion ? (rotational ? 0 : part.position[idx]) : 0;

  useFrame(() => {
    const box = ref.current;
    const machine = machineRef.current;
    if (!box || !machine) return;

    /* Follow the subject. Only the driven axis can have changed. */
    if (motion && !rotational) {
      const v = base + evaluateMotion(motion, machine.kin);
      if (idx === 0) box.position.x = v;
      else if (idx === 1) box.position.y = v;
      else box.position.z = v;
    }

    const moving = machine.strokeHz > 0.001;
    const mat = box.material as THREE.LineBasicMaterial;
    tmpColor.copy(moving ? LOCK : LOST);
    mat.color.lerp(tmpColor, 0.25);
    mat.opacity = moving
      ? 0.95
      : 0.3 + Math.abs(Math.sin(performance.now() * 0.006)) * 0.65;
  });

  return (
    <lineSegments
      ref={ref}
      geometry={geometry}
      position={part.position as unknown as THREE.Vector3Tuple}
      raycast={() => null}
    >
      <lineBasicMaterial color={SCENE.blueprint} transparent opacity={0.95} toneMapped={false} linewidth={1} />
    </lineSegments>
  );
}

/* ========================================================================== */
/* OPTIONAL HIGH-FIDELITY ASSET                                               */
/* ========================================================================== */

/**
 * The .glb path, for when real OEM models arrive.
 *
 * No archetype declares a `glb` today, so this never mounts — but the
 * boundary is wired so that dropping a model into `public/models/` and adding
 * one field to the archetype swaps it in without touching this component. The
 * primitives stay as the fallback, which means a missing or slow asset
 * degrades to a working mechanism rather than an empty frame.
 *
 * The loader is kept inside its own <Suspense> so a 30MB press model cannot
 * block the dive: the primitive mechanism renders immediately, the model
 * replaces it when it lands.
 */
function HiFiAsset({ url, onLoaded }: { url: string; onLoaded: () => void }) {
  const gltf = useLoader(GLTFLoader, url);
  const model = useMemo(() => gltf.scene.clone(true), [gltf]);

  useEffect(() => {
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.raycast = () => null;
    });
    onLoaded();
  }, [model, onLoaded]);

  return <primitive object={model} />;
}

/* ========================================================================== */
/* THE MACHINE                                                                */
/* ========================================================================== */

/**
 * The full mechanism for one machine, positioned where the low-poly instance
 * used to stand.
 *
 * Archetype geometry is authored at real scale (a lockstitch bed is 0.56m
 * across because that is how big one is), so it is fitted to the machine's
 * declared footprint rather than assumed to match. That keeps a single
 * `SEW-LCK` archetype usable for three stitching lines of different sizes.
 */
function Mechanism({ siteId, def }: { siteId: SiteId; def: MachineDef }) {
  const profile = KINEMATICS[def.kind];
  const archetype = useMemo(() => archetypeFor(def, profile.kind), [def, profile.kind]);

  /**
   * One lookup per dive, not one per part per frame.
   *
   * 42 parts each calling `site.machines.find()` at 60fps is 2,500 linear
   * searches a second over a 20-element array for a value that cannot change
   * while the dive is open. Resolved once here and handed down as a ref.
   */
  const machineRef = useRef<MachineRuntime | null>(null);
  useEffect(() => {
    machineRef.current = getSite(siteId).machines.find((m) => m.def.id === def.id) ?? null;
    return () => {
      machineRef.current = null;
    };
  }, [siteId, def.id]);

  /** Shared with CameraController, so the lens frames what we actually draw. */
  const fit = useMemo(() => mechanismScale(archetype, def.size), [archetype, def.size]);

  const { driven, statics } = useMemo(() => {
    const d: MechanismPart[] = [];
    const s: MechanismPart[] = [];
    for (const p of archetype.parts) (p.motion ? d : s).push(p);
    return { driven: d, statics: s };
  }, [archetype]);

  const tracked = useMemo(
    () => archetype.parts.find((p) => p.id === archetype.tracked.partId) ?? driven[0] ?? null,
    [archetype, driven],
  );

  const casing = useMemo(() => buildCasingMaterials(), []);
  useEffect(
    () => () => {
      casing.glass.dispose();
      casing.wire.dispose();
    },
    [casing],
  );

  /** The glass shell, sized to the machine's own declared envelope. */
  const shellGeo = useMemo(
    () => new THREE.BoxGeometry(def.size[0] * 0.98, def.size[1] * 1.04, def.size[2] * 0.98),
    [def.size],
  );
  const shellEdges = useMemo(() => new THREE.EdgesGeometry(shellGeo), [shellGeo]);
  useEffect(() => {
    return () => {
      shellGeo.dispose();
      shellEdges.dispose();
    };
  }, [shellGeo, shellEdges]);

  /** Fade the glass in, so the casing dissolves rather than popping. */
  const shellRef = useRef<THREE.Mesh>(null);
  const openT = useRef(0);
  useFrame((_, dt) => {
    openT.current = Math.min(1, openT.current + dt * 1.6);
    const m = shellRef.current;
    if (!m) return;
    const mat = m.material as THREE.MeshPhysicalMaterial;
    /* Starts near-solid and clears almost completely: the casing "opening
     * up". It has to end up very faint — at the macro lens the casing is the
     * size of the whole viewport and the mechanism inside it is a few
     * centimetres, so anything above about 0.12 and the glass simply becomes
     * a pale slab with the machine lost somewhere behind it. The blueprint
     * edges are what carry the casing's shape from here on. */
    mat.opacity = 0.55 - openT.current * 0.43;
  });

  const elevation = floorElevation(SITES[siteId], def.floor);

  return (
    <group
      position={[def.position[0], elevation + def.position[1], def.position[2]]}
      rotation={[0, def.rotation, 0]}
    >
      {/* ---- the casing: glass shell plus blueprint edges ---- */}
      <mesh
        ref={shellRef}
        geometry={shellGeo}
        material={casing.glass}
        position={[0, def.size[1] * 0.52, 0]}
        raycast={() => null}
      />
      <lineSegments
        geometry={shellEdges}
        material={casing.wire}
        position={[0, def.size[1] * 0.52, 0]}
        raycast={() => null}
      />

      {/* ---- the mechanism, scaled into the footprint ---- */}
      <group scale={fit}>
        {statics.map((p) => (
          <StaticPart key={p.id} part={p} />
        ))}
        {driven.map((p) => (
          <DrivenPart key={p.id} part={p} machineRef={machineRef} />
        ))}
        <BoltField parts={archetype.parts} />
        {tracked && <TrackerBox part={tracked} machineRef={machineRef} />}

        {archetype.glb && (
          <Suspense fallback={null}>
            <HiFiAsset url={archetype.glb} onLoaded={() => {}} />
          </Suspense>
        )}
      </group>
    </group>
  );
}

/* ========================================================================== */
/* Public — the 3D half                                                       */
/* ========================================================================== */

/**
 * Mounts inside the Canvas. Renders nothing at all unless a dive is open,
 * which is what keeps the 42-part mechanism out of the floor view's budget.
 */
export default function DeepDiveXRay({ siteId }: { siteId: SiteId }) {
  const machineId = useMegnetoStore((s) => s.kinematicMachineId);

  const def = useMemo(
    () => (machineId ? SITES[siteId].machines.find((m) => m.id === machineId) ?? null : null),
    [siteId, machineId],
  );

  if (!def) return null;
  return <Mechanism siteId={siteId} def={def} />;
}

/* ========================================================================== */
/* FAULT RESOLUTION                                                           */
/* ========================================================================== */

/**
 * Which fault the HUD points at.
 *
 * The store raises faults from its own generic table, which is right for the
 * alert feed but useless on a blueprint — "bearing temperature high" does not
 * tell you WHERE. So the live status is mapped onto the archetype's own fault
 * list, which is keyed to actual part ids.
 *
 * The choice is hashed from the fault code so it is stable: the same fault
 * must not wander between parts while the panel is open.
 */
function resolveFault(archetype: MachineArchetype, machine: MachineRuntime | null): FaultSpec | null {
  if (!machine) return null;
  const healthy = !machine.jammed && machine.status !== 'warning' && machine.status !== 'critical';
  if (healthy || archetype.faults.length === 0) return null;

  let h = 0;
  const key = machine.faultCode || machine.status;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return archetype.faults[Math.abs(h) % archetype.faults.length];
}

/* ========================================================================== */
/* Public — the HUD half                                                      */
/* ========================================================================== */

/**
 * The immersive diagnostic overlay. A DOM sibling of the canvas, NOT a child
 * of it — see FacilityOverlay.tsx for the full account of why drei's <Html>
 * cannot be used on this project.
 *
 * ============================================================================
 * EVERY NUMBER HERE IS WRITTEN WITH `textContent` AT 20Hz
 * ============================================================================
 * The panel subscribes to exactly one piece of reactive state: which machine
 * is open. Stroke count, rate, phase, progress and fault text are all read
 * from the mutable world in a `requestAnimationFrame` loop and written
 * straight into DOM nodes through refs.
 *
 * A `useState` per field would re-render this tree sixty times a second,
 * which on a 1650 competes directly with the renderer for main-thread time.
 * 20Hz is deliberate too: the eye cannot read a four-digit counter faster
 * than that, so three quarters of the writes would be wasted work.
 *
 * It is NOT inside the Canvas, so it cannot use `useFrame` — that throws
 * "R3F: Hooks can only be used within the Canvas component", which this
 * project has hit before.
 */
export function DeepDiveHUD({ siteId }: { siteId: SiteId }) {
  const machineId = useMegnetoStore((s) => s.kinematicMachineId);
  const disengage = useMegnetoStore((s) => s.inspectKinematics);
  const actOnMachine = useMegnetoStore((s) => s.actOnMachine);

  const def = useMemo(
    () => (machineId ? SITES[siteId].machines.find((m) => m.id === machineId) ?? null : null),
    [siteId, machineId],
  );
  const profile = def ? KINEMATICS[def.kind] : null;
  const archetype = useMemo(
    () => (def && profile ? archetypeFor(def, profile.kind) : null),
    [def, profile],
  );

  /* ---- DOM handles ---- */
  const ringRef = useRef<SVGCircleElement>(null);
  const pctRef = useRef<HTMLSpanElement>(null);
  const strokeRef = useRef<HTMLSpanElement>(null);
  const rateRef = useRef<HTMLSpanElement>(null);
  const totalStrokeRef = useRef<HTMLSpanElement>(null);
  const cyclesRef = useRef<HTMLSpanElement>(null);
  const lockRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLSpanElement>(null);
  const faultRef = useRef<HTMLDivElement>(null);
  const flashRef = useRef<HTMLDivElement>(null);

  const RADIUS = 58;
  const CIRC = 2 * Math.PI * RADIUS;

  useEffect(() => {
    if (!def || !profile || !archetype) return;

    let raf = 0;
    let last = 0;
    let lastUnitAt = -1;
    let lastFaultKey = '\u0000';

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      // 20Hz. See the note above.
      if (now - last < 50) return;
      last = now;

      const machine = getSite(siteId).machines.find((m) => m.def.id === def.id);
      if (!machine) return;

      const moving = machine.strokeHz > 0.001;

      /* ---- the ring: the only progress indicator in the product ---- */
      if (ringRef.current) {
        const p = Math.max(0, Math.min(1, machine.unitProgress));
        ringRef.current.style.strokeDasharray = `${p * CIRC} ${CIRC}`;
        ringRef.current.style.stroke = moving ? SCENE.blueprint : SCENE.blueprintWarn;
      }
      if (pctRef.current) {
        pctRef.current.textContent = String(Math.round(machine.unitProgress * 100));
      }
      if (strokeRef.current) {
        strokeRef.current.textContent = `${machine.strokesThisUnit} / ${profile.perUnit}`;
      }
      if (rateRef.current) {
        rateRef.current.textContent = machine.strokeHz.toFixed(2);
      }
      if (totalStrokeRef.current) {
        totalStrokeRef.current.textContent = machine.strokes.toLocaleString('en-IN');
      }
      if (cyclesRef.current) {
        cyclesRef.current.textContent = machine.jobsDone.toLocaleString('en-IN');
      }

      /* ---- tracker lock ---- */
      if (lockRef.current) {
        lockRef.current.textContent = moving ? '● TRACKING LOCK' : '● SUBJECT LOST';
        lockRef.current.style.color = moving ? SCENE.blueprint : SCENE.blueprintWarn;
        lockRef.current.style.borderColor = moving ? '#1f4f6b' : '#6b2a22';
      }
      if (statusRef.current) {
        statusRef.current.textContent = machine.jammed
          ? 'JAMMED'
          : machine.status.toUpperCase();
      }

      /* ---- fault callout ---- */
      const fault = resolveFault(archetype, machine);
      const faultKey = fault ? fault.code : '';
      if (faultKey !== lastFaultKey) {
        lastFaultKey = faultKey;
        const el = faultRef.current;
        if (el) {
          if (!fault) {
            el.innerHTML =
              '<p class="font-mono text-[9px] tracking-[0.2em] text-signal-cyan/50">NO ACTIVE MECHANICAL FAULT</p>';
          } else {
            const part = archetype.parts.find((p) => p.id === fault.partId);
            el.innerHTML = [
              `<p class="font-mono text-[9px] tracking-[0.2em]" style="color:${SCENE.blueprintWarn}">${fault.code}</p>`,
              `<p class="mt-1 text-[12px] font-semibold text-white">${fault.label}</p>`,
              `<p class="mt-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-signal-cyan/60">LOCATION · ${part ? part.label : fault.partId}</p>`,
              `<p class="mt-2 text-[11px] leading-snug text-frost-200/70">${fault.remedy}</p>`,
              `<p class="mt-2 border-t border-white/10 pt-2 text-[10px] italic leading-snug text-frost-200/50">Tracker: ${fault.lockEffect}</p>`,
            ].join('');
          }
        }
      }

      /* ---- flash on a completed cycle ---- */
      if (machine.lastUnitAt !== lastUnitAt) {
        if (lastUnitAt >= 0 && flashRef.current) {
          flashRef.current.style.transition = 'none';
          flashRef.current.style.opacity = '0.5';
          // Next frame, let the transition run it back down.
          requestAnimationFrame(() => {
            const f = flashRef.current;
            if (!f) return;
            f.style.transition = 'opacity 520ms ease-out';
            f.style.opacity = '0';
          });
        }
        lastUnitAt = machine.lastUnitAt;
      }
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [siteId, def, profile, archetype, CIRC]);

  if (!def || !profile || !archetype) return null;

  return (
    /* `inset-0` and NOT pointer-events-none: this overlay deliberately eats
     * every click on the canvas. The camera is locked and the only way out is
     * the DISENGAGE button, so a stray click must not reach a machine behind
     * the panel and start a second dive. */
    <div className="absolute inset-0 z-30 flex flex-col justify-between">
      {/* Cycle-completion flash, across the whole frame. */}
      <div
        ref={flashRef}
        className="pointer-events-none absolute inset-0 opacity-0"
        style={{ background: `radial-gradient(circle at 50% 55%, ${SCENE.blueprint}, transparent 62%)` }}
      />

      {/* Scanline wash, so the frame reads as an instrument and not a render. */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.07]"
        style={{
          backgroundImage: `repeating-linear-gradient(to bottom, ${SCENE.blueprint} 0px, ${SCENE.blueprint} 1px, transparent 1px, transparent 3px)`,
        }}
      />

      {/* ================= TOP: identification ================= */}
      <header className="pointer-events-auto flex items-start justify-between gap-4 p-4 md:p-6">
        <div className="max-w-[46ch] rounded-xl border border-white/10 bg-ink-900/70 p-4 backdrop-blur-md">
          <p className="font-mono text-[9px] tracking-[0.28em] text-signal-cyan/60">
            MECHANICAL BLUEPRINT · {archetype.code}
          </p>
          <h2 className="mt-1.5 text-[17px] font-semibold leading-tight text-white">{archetype.label}</h2>
          <p className="mt-0.5 font-mono text-[10px] tracking-[0.14em] text-frost-200/50">
            {def.id} · {def.name} · {archetype.oem}
          </p>

          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 border-t border-white/10 pt-3">
            {archetype.plate.map(([k, v]) => (
              <div key={k}>
                <dt className="font-mono text-[8px] uppercase tracking-[0.16em] text-signal-cyan/45">{k}</dt>
                <dd className="font-mono text-[11px] text-frost-200/85">{v}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="flex flex-col items-end gap-2">
          <div
            ref={lockRef}
            className="rounded-md border px-2.5 py-1 font-mono text-[9px] tracking-[0.22em]"
            style={{ color: SCENE.blueprint, borderColor: '#1f4f6b', background: 'rgba(4,16,26,0.72)' }}
          >
            ● TRACKING LOCK
          </div>
          <div className="rounded-md border border-white/10 bg-ink-900/70 px-2.5 py-1 font-mono text-[9px] tracking-[0.18em] text-frost-200/70">
            STATUS&nbsp;·&nbsp;<span ref={statusRef}>NOMINAL</span>
          </div>
        </div>
      </header>

      {/* ================= BOTTOM: the counter and the fault ================= */}
      <footer className="pointer-events-auto flex flex-wrap items-end justify-between gap-4 p-4 md:p-6">
        {/* ---- the kinematic counter ---- */}
        <div className="flex items-center gap-5 rounded-xl border border-white/10 bg-ink-900/75 p-4 backdrop-blur-md">
          <div className="relative h-[136px] w-[136px] shrink-0">
            <svg viewBox="0 0 136 136" className="h-full w-full -rotate-90">
              <circle cx="68" cy="68" r={RADIUS} fill="none" stroke="#14323f" strokeWidth="9" />
              <circle
                ref={ringRef}
                cx="68"
                cy="68"
                r={RADIUS}
                fill="none"
                stroke={SCENE.blueprint}
                strokeWidth="9"
                strokeLinecap="round"
                style={{ strokeDasharray: `0 ${CIRC}` }}
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <p className="font-mono text-[26px] font-semibold leading-none text-white">
                <span ref={pctRef}>0</span>
                <span className="text-[13px] text-signal-cyan/60">%</span>
              </p>
              <p className="mt-1 font-mono text-[8px] tracking-[0.18em] text-signal-cyan/50">CYCLE</p>
            </div>
          </div>

          <div className="min-w-[220px]">
            <p className="font-mono text-[9px] tracking-[0.24em] text-signal-cyan/60">
              KINEMATIC ACTION RECOGNITION
            </p>
            <p className="mt-1.5 text-[13px] font-semibold text-white">{archetype.tracked.axisNote}</p>
            <p className="mt-0.5 text-[10px] leading-snug text-frost-200/50">
              Output increments only on a completed physical stroke. There is no timer.
            </p>

            <div className="mt-3 grid grid-cols-2 gap-x-5 gap-y-2 border-t border-white/10 pt-3">
              <Readout label="STROKES THIS CYCLE">
                <span ref={strokeRef}>0 / {profile.perUnit}</span>
              </Readout>
              <Readout label="RATE">
                <span ref={rateRef}>0.00</span>
                <span className="ml-1 text-[9px] text-signal-cyan/50">Hz</span>
              </Readout>
              <Readout label="STROKES COUNTED">
                <span ref={totalStrokeRef}>0</span>
              </Readout>
              <Readout label="CYCLES COMPLETE">
                <span ref={cyclesRef}>0</span>
              </Readout>
            </div>
          </div>
        </div>

        {/* ---- fault location ---- */}
        <div className="min-w-[260px] max-w-[34ch] rounded-xl border border-white/10 bg-ink-900/75 p-4 backdrop-blur-md">
          <p className="font-mono text-[9px] tracking-[0.24em] text-signal-cyan/60">FAULT LOCALISATION</p>
          <div ref={faultRef} className="mt-2">
            <p className="font-mono text-[9px] tracking-[0.2em] text-signal-cyan/50">
              NO ACTIVE MECHANICAL FAULT
            </p>
          </div>
          <button
            type="button"
            onClick={() => actOnMachine(def.id)}
            className="mt-3 w-full rounded-md border border-signal-cyan/30 bg-signal-cyan/10 px-3 py-2 font-mono text-[10px] tracking-[0.18em] text-signal-cyan transition hover:bg-signal-cyan/20"
          >
            DISPATCH MAINTENANCE
          </button>
        </div>

        {/* ---- the way out. Heavy, unmissable, and the only one. ---- */}
        <button
          type="button"
          onClick={() => disengage(null)}
          className="group flex items-center gap-3 rounded-xl border-2 border-signal-cyan/40 bg-signal-cyan/15 px-6 py-4 text-left transition hover:border-signal-cyan/70 hover:bg-signal-cyan/25"
        >
          <span className="text-[20px] leading-none text-signal-cyan transition group-hover:-translate-x-0.5">
            ⇤
          </span>
          <span>
            <span className="block font-mono text-[12px] font-semibold tracking-[0.18em] text-white">
              DISENGAGE
            </span>
            <span className="block font-mono text-[9px] tracking-[0.14em] text-signal-cyan/60">
              UNLOCK CAMERA · RETURN TO FLOOR
            </span>
          </span>
        </button>
      </footer>
    </div>
  );
}

function Readout({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="font-mono text-[8px] uppercase tracking-[0.16em] text-signal-cyan/45">{label}</p>
      <p className="font-mono text-[15px] font-semibold text-white">{children}</p>
    </div>
  );
}
