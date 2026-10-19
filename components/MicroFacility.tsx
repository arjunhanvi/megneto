'use client';

/**
 * LAYER 2/3 — THE FACILITY
 *
 * The React Three Fiber half of the onion. Mounted ONLY while the Cesium globe
 * is torn down (see page.tsx), so the 4GB card never holds two scene graphs.
 *
 * In V3 this file is deliberately thin. It owns the canvas, the renderer
 * budget, the atmosphere and the lights; the building itself belongs to
 * `FloorStack`, the camera to `CameraController`, and every overlay to
 * `FacilityOverlay`. Keeping those apart is what makes the three-storey
 * isolation possible without a single re-render.
 *
 * ============================================================================
 * WHY THERE IS NO @react-three/drei HERE
 * ============================================================================
 * Two reasons, both found the hard way on this project:
 *
 *  1. drei barrel-imports `@spz-loader/core`, which inlines a WebAssembly blob
 *     as a JavaScript string. Next's SWC minifier re-emits that string as a
 *     TEMPLATE literal, and the blob starts with `\0asm` — an octal escape,
 *     which is a hard SyntaxError inside a template literal. The production
 *     bundle dies on load. Dev, which does not minify, is fine — the worst
 *     possible way to find out.
 *
 *  2. drei's <Html> mounts a separate React DOM root per overlay and unmounts
 *     it inside a layout effect, which throws under React 19 every time this
 *     layer is destroyed — i.e. on every dive. See FacilityOverlay.tsx.
 * ============================================================================
 *
 * THE ATMOSPHERE IS THE POINT
 * ---------------------------
 * `AtmosphereDriver` reads the environmental physics every frame and drives
 * scene fog, ambient colour and a ceiling haze plane directly. When the mill
 * loses its humidity band or the press hall fills with solvent, you SEE it
 * before you read it on a panel. No React state is involved in that loop.
 */

import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useLoader, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

import { FX_LEVEL, PINNED_DPR } from '@/lib/quality';
import { SITES, type SiteId } from '@/lib/sites';
import { THEME } from '@/lib/theme';
import {
  frameAdvance,
  getSite,
  useMegnetoStore,
  type PrintingPhysics,
  type TextilePhysics,
} from '@/store/useMegnetoStore';
import { EnvNodes, Logistics, Machines, Pallets, Workforce } from '@/components/IndustrialEntities';
import { Projector } from '@/components/FacilityOverlay';
import FloorStack from '@/components/FloorStack';
import CameraController from '@/components/CameraController';
import ArchitectureShell from '@/components/ArchitectureShell';
import InstancedMachinery from '@/components/InstancedMachinery';
import DeepDiveXRay from '@/components/DeepDiveXRay';
import LightingAndEffects, { XrayGrading } from '@/components/LightingAndEffects';

const DRACO_PATH = '/draco/';

/* -------------------------------------------------------------------------- */
/* Simulation driver — the only useFrame that mutates the world                */
/* -------------------------------------------------------------------------- */

function SimulationDriver() {
  useFrame((_, delta) => {
    frameAdvance(delta);
  });
  return null;
}

/* -------------------------------------------------------------------------- */
/* Resolution governor                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Deliberately NOT `useState` + a `dpr` prop on <Canvas>: that re-renders the
 * whole R3F tree every time the frame rate wobbles, which on a 1650 is
 * constantly. We sample frame times and reach for the renderer by hand.
 */
function DprGovernor({ initial = 1.2 }: { initial?: number }) {
  const gl = useThree((s) => s.gl);
  const start = PINNED_DPR ?? initial;
  const state = useRef({ dpr: start, acc: 0, frames: 0, settle: 2 });

  /* `?dpr=` pins the resolution. Without a pin, two benchmark runs measure
   * two different resolutions, because the governor is still hunting while
   * you time it — which is how the first V7 measurements came out showing
   * the composer with NEGATIVE overhead. See lib/quality.ts. */
  useEffect(() => {
    if (PINNED_DPR !== null) gl.setPixelRatio(PINNED_DPR);
  }, [gl]);

  useFrame((_, dt) => {
    if (PINNED_DPR !== null) return;
    const s = state.current;
    s.acc += dt;
    s.frames += 1;
    if (s.acc < 1.5) return;

    const fps = s.frames / s.acc;
    s.acc = 0;
    s.frames = 0;
    if (s.settle > 0) {
      s.settle -= 1;
      return;
    }

    /* ---- the floor drops to 0.6 once the composer is in the pipeline ----
     *
     * V6 bottomed out at 0.75 because the scene was the only thing paying
     * for pixels. V7 renders into a half-float target and then runs the
     * bloom chain over it, so every pixel is paid for several times and the
     * governor needs more room to give away. Measured on integrated
     * graphics, 0.6 is roughly a third less fill than 0.75.
     *
     * The original note still applies, and more so: a soft image beats a
     * stuttering one, and nobody in the room is counting pixels. */
    const floor = FX_LEVEL === 'off' ? 0.75 : 0.6;
    let next = s.dpr;
    if (fps < 46) next = Math.max(floor, s.dpr - 0.15);
    else if (fps > 58) next = Math.min(1.5, s.dpr + 0.15);

    if (next !== s.dpr) {
      s.dpr = next;
      gl.setPixelRatio(next);
    }
  });

  return null;
}

/* -------------------------------------------------------------------------- */
/* Readiness probe                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Rehearsal handle. `onCreated` proved unreliable across Fast Refresh — the
 * canvas survives a hot reload but the callback does not re-run, so the
 * console handle silently disappears mid-session and every measurement taken
 * after that point fails. An effect re-attaches it on every remount.
 */
function DevHandle() {
  const state = useThree();
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    (window as unknown as Record<string, unknown>).__megnetoR3F = state;
  });
  return null;
}

function FirstFrameSignal({ onReady }: { onReady: () => void }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    // Compile everything up front: one long hitch behind the veil instead of
    // twelve short ones in front of the investors.
    try {
      gl.compile(scene, camera);
    } catch {
      /* non-fatal */
    }
    let raf = 0;
    let left = 3;
    const step = () => {
      if (left-- <= 0) {
        onReady();
        return;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [gl, scene, camera, onReady]);

  return null;
}

/* ========================================================================== */
/* ATMOSPHERE — environmental physics driving the actual render               */
/* ========================================================================== */

const fogClean = new THREE.Color(THEME.background);
const fogHumid = new THREE.Color('#cfdfe8'); // cotton haze: cool, heavy, close
const fogHot = new THREE.Color('#e7d3c2'); // dye-house radiant heat: warm
const fogVoc = new THREE.Color('#ded7f2'); // solvent vapour: violet cast
const fogDust = new THREE.Color('#e3dfd6'); // paper dust: dry grey-beige

const tmpColor = new THREE.Color();

function AtmosphereDriver({ siteId }: { siteId: SiteId }) {
  const scene = useThree((s) => s.scene);
  const hazeRef = useRef<THREE.Mesh>(null);
  const ambientRef = useRef<THREE.HemisphereLight>(null);
  const warmRef = useRef<THREE.PointLight>(null);

  const def = SITES[siteId];
  const buildingHeight = def.shell.floorHeight * 3;

  const fog = useMemo(() => new THREE.Fog(THEME.background, 60, 150), []);

  useLayoutEffect(() => {
    scene.fog = fog;
    return () => {
      scene.fog = null;
    };
  }, [scene, fog]);

  useFrame(({ clock }) => {
    const site = getSite(siteId);
    const p = site.physics;
    const t = clock.elapsedTime;

    let humidSeverity = 0;
    let heatSeverity = 0;
    let vocSeverity = 0;
    let dustSeverity = 0;

    if (p.kind === 'textile') {
      const tp = p as TextilePhysics;
      // Both ends of the band are failures, so measure from the middle.
      humidSeverity = THREE.MathUtils.clamp((Math.abs(tp.rh - 62.5) - 7.5) / 16, 0, 1);
      heatSeverity = THREE.MathUtils.clamp((tp.wbgt - 27) / 8, 0, 1);
    } else {
      const pp = p as PrintingPhysics;
      vocSeverity = THREE.MathUtils.clamp((pp.vocPpm - 28) / 34, 0, 1);
      dustSeverity = THREE.MathUtils.clamp((pp.dustUgM3 - 90) / 110, 0, 1);
    }

    const severity = Math.max(humidSeverity, heatSeverity, vocSeverity, dustSeverity);

    tmpColor.copy(fogClean);
    if (humidSeverity > 0) tmpColor.lerp(fogHumid, humidSeverity * 0.85);
    if (heatSeverity > 0) tmpColor.lerp(fogHot, heatSeverity * 0.8);
    if (vocSeverity > 0) tmpColor.lerp(fogVoc, vocSeverity * 0.85);
    if (dustSeverity > 0) tmpColor.lerp(fogDust, dustSeverity * 0.7);
    fog.color.lerp(tmpColor, 0.05);

    // Out-of-spec air closes the building in: the far plane walks inward.
    fog.near = THREE.MathUtils.lerp(fog.near, 60 - severity * 30, 0.04);
    fog.far = THREE.MathUtils.lerp(fog.far, 160 - severity * 75, 0.04);

    if (ambientRef.current) {
      ambientRef.current.intensity = THREE.MathUtils.lerp(ambientRef.current.intensity, 2.1 - severity * 0.75, 0.05);
      ambientRef.current.color.lerp(tmpColor, 0.04);
    }

    if (warmRef.current) {
      warmRef.current.intensity = THREE.MathUtils.lerp(
        warmRef.current.intensity,
        heatSeverity * 26 + vocSeverity * 10,
        0.05,
      );
    }

    /* --- haze plane: the "volumetric" read, for one draw call --- */
    if (hazeRef.current) {
      const mat = hazeRef.current.material as THREE.MeshBasicMaterial;
      const breath = 0.86 + Math.sin(t * 0.55) * 0.14;
      mat.opacity = THREE.MathUtils.lerp(mat.opacity, severity * 0.4 * breath, 0.05);
      mat.color.lerp(tmpColor, 0.05);
      hazeRef.current.visible = mat.opacity > 0.012;
      hazeRef.current.position.y = buildingHeight * 0.72 + Math.sin(t * 0.4) * 0.14;
    }
  });

  return (
    <>
      <hemisphereLight ref={ambientRef} args={['#ffffff', '#b9d4e8', 2.1]} />
      <pointLight
        ref={warmRef}
        position={[0, buildingHeight * 0.6, 0]}
        distance={buildingHeight * 7}
        intensity={0}
        color="#ff9a4d"
      />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, buildingHeight * 0.72, 0]} raycast={() => null}>
        <planeGeometry args={[def.shell.width + 10, def.shell.depth + 10]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={0} depthWrite={false} toneMapped={false} />
      </mesh>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Optional GLTF envelope                                                      */
/* -------------------------------------------------------------------------- */

let dracoLoader: DRACOLoader | null = null;
function getDraco() {
  if (!dracoLoader) {
    dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath(DRACO_PATH);
  }
  return dracoLoader;
}

/**
 * If a `factory.glb` is present it is drawn as an outer envelope AROUND the
 * procedural stack, auto-fitted to the building's footprint and full height,
 * and always translucent — the three storeys inside it are the thing the demo
 * is about, so the model must never occlude them.
 */
function GLTFEnvelope({ siteId }: { siteId: SiteId }) {
  const def = SITES[siteId];
  const gltf = useLoader(GLTFLoader, def.shell.modelUrl, (loader) => {
    (loader as GLTFLoader).setDRACOLoader(getDraco());
  });

  const model = useMemo(() => gltf.scene.clone(true), [gltf]);

  const fit = useMemo(() => {
    const box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3();
    const centre = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(centre);
    const scale = Math.min(
      (def.shell.width + 2) / (size.x || 1),
      (def.shell.depth + 2) / (size.z || 1),
      (def.shell.floorHeight * 3 + 1) / (size.y || 1),
    );
    return {
      scale,
      position: new THREE.Vector3(-centre.x * scale, -box.min.y * scale, -centre.z * scale),
    };
  }, [model, def]);

  useLayoutEffect(() => {
    model.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.raycast = () => null;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        const mat = m as THREE.MeshStandardMaterial;
        if (!mat) continue;
        mat.transparent = true;
        mat.opacity = 0.12;
        mat.depthWrite = false;
        mat.side = THREE.FrontSide;
        mat.needsUpdate = true;
      }
    });
  }, [model]);

  return <primitive object={model} scale={fit.scale} position={fit.position} />;
}

function OptionalEnvelope({ siteId }: { siteId: SiteId }) {
  const [hasModel, setHasModel] = useState(false);

  useEffect(() => {
    let alive = true;
    // Server-side existence check: see app/api/house-model/route.ts for why
    // this is not a client-side HEAD request.
    fetch('/api/house-model')
      .then((res) => res.json())
      .then((data: { present?: boolean }) => {
        if (alive) setHasModel(Boolean(data?.present));
      })
      .catch(() => {
        if (alive) setHasModel(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!hasModel) return null;
  return (
    <Suspense fallback={null}>
      <GLTFEnvelope siteId={siteId} />
    </Suspense>
  );
}

/* -------------------------------------------------------------------------- */
/* Dive culling                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Everything that is not the machine under inspection, switched off for the
 * duration of the dive.
 *
 * This is where the X-ray gets its performance budget AND its look. The
 * camera is zoomed to 330 inside a machine, so the 3,000-person crowd, the
 * forklifts, the pallets and the three translucent floor plates are all still
 * being rasterised, mostly behind the subject, filling the entire viewport.
 * V6 measured the exploded view at 90ms for precisely this reason.
 *
 * One `useFrame`, one store read, one boolean per group. No re-renders — the
 * children keep their uploaded matrices and their materials throughout, so
 * coming back out of a dive costs nothing.
 */
function DiveCulling({ children }: { children: React.ReactNode }) {
  const ref = useRef<THREE.Group>(null);

  useFrame(() => {
    const g = ref.current;
    if (!g) return;
    const visible = useMegnetoStore.getState().kinematicMachineId === null;
    if (g.visible !== visible) g.visible = visible;
  });

  return <group ref={ref}>{children}</group>;
}

/* -------------------------------------------------------------------------- */
/* Canvas                                                                      */
/* -------------------------------------------------------------------------- */

export interface MicroFacilityProps {
  siteId: SiteId;
  /** Called once the first real frame has been painted. */
  onReady: () => void;
}

export default function MicroFacility({ siteId, onReady }: MicroFacilityProps) {
  const def = SITES[siteId];
  const span = Math.max(def.shell.width, def.shell.depth);

  return (
    <Canvas
      orthographic
      dpr={1.2}
      frameloop="always"
      camera={{ position: [span, span * 0.9, span], zoom: 640 / span, near: -800, far: 1200 }}
      gl={{
        antialias: true,
        alpha: false,
        stencil: false,
        depth: true,
        powerPreference: 'high-performance',
        preserveDrawingBuffer: false,
      }}
      onCreated={(state) => {
        state.gl.setClearColor(THEME.background, 1);
        // Rehearsal handle, mirroring `__megnetoViewer` for Cesium. Lets you
        // inspect the camera and the stack from the console mid-demo.
        if (process.env.NODE_ENV !== 'production') {
          (window as unknown as Record<string, unknown>).__megnetoR3F = state;
        }
      }}
      className="absolute inset-0"
    >
      {/* Drop resolution before frames: a soft image beats a stuttering one. */}
      <DprGovernor />
      <DevHandle />

      <SimulationDriver />
      <AtmosphereDriver siteId={siteId} />
      <CameraController siteId={siteId} />
      <XrayGrading />

      <Suspense fallback={null}>
        {/* Lights, environment map and the composer. Outside DiveCulling:
          * the X-ray needs the environment map more than the floor does — it
          * is what makes the chromed parts read as metal. */}
        <LightingAndEffects siteId={siteId} />

        <ArchitectureShell siteId={siteId} />

        {/* The floor, and everything standing on it. All of it goes away
          * during a dive, including the low-poly machine bodies — those ARE
          * the low level of detail, and the mechanism below replaces the one
          * being inspected. */}
        <DiveCulling>
          <FloorStack siteId={siteId} />
          <InstancedMachinery siteId={siteId} />
          <OptionalEnvelope siteId={siteId} />
          <Pallets siteId={siteId} />
          <Logistics siteId={siteId} />
          <Machines siteId={siteId} />
          <EnvNodes siteId={siteId} />
          <Workforce siteId={siteId} />
        </DiveCulling>

        {/* The high-fidelity mechanism. Mounts only while a dive is open. */}
        <DeepDiveXRay siteId={siteId} />

        <Projector />
        <FirstFrameSignal onReady={onReady} />
      </Suspense>
    </Canvas>
  );
}
