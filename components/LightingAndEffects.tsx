'use client';

/**
 * LIGHTING AND EFFECTS — the pipeline that stops the hall looking like a
 * diagram.
 *
 * ============================================================================
 * WHAT WAS ACTUALLY WRONG BEFORE
 * ============================================================================
 * Not the light count. The scene had a key, a fill and a hemisphere, which is
 * a reasonable rig. Three things were missing:
 *
 *  1. NOTHING TO REFLECT. Every surface was `MeshStandardMaterial` with
 *     metalness up to 0.95 and no environment map. A metal with nothing to
 *     reflect reflects black, so every polished shaft, every chromed cylinder
 *     and every stainless vessel rendered as flat grey. That is most of the
 *     "lifeless" complaint, and it is fixed by one 256px cubemap.
 *
 *  2. NO CONTACT. Direct lighting alone cannot darken the inside corner where
 *     a machine meets the slab, so everything appeared to hover. That is what
 *     the AO pass is for.
 *
 *  3. NOWHERE FOR LIGHT TO GO. On a near-white background a bloom pass makes
 *     the whole frame milky instead of making the LEDs glow. The hall had to
 *     get dark before any of this could read — see the note in `lib/theme.ts`.
 *
 * ============================================================================
 * AMBIENT OCCLUSION: WHY N8AO AND NOT SSAO
 * ============================================================================
 * The camera is ORTHOGRAPHIC with `near: -800`. Classic SSAO reconstructs
 * view-space position from a perspective depth buffer; point it at an ortho
 * camera and the sample kernel is the wrong shape at every pixel, which shows
 * up as a uniform grey wash rather than contact shadow. N8AO handles the
 * ortho projection explicitly, which is why it is the AO implementation here.
 * `SSAO` is still exported by the same package if you want to compare.
 *
 * Linearised ortho depth over a 2000-unit slab is uniform, not hyperbolic, so
 * a 24-bit buffer gives ~0.1mm steps across the whole range. AO at a 0.4m
 * radius has plenty of precision to work with.
 *
 * ============================================================================
 * THE 4GB BUDGET
 * ============================================================================
 * A composer is not free: it allocates full-size colour and depth targets and
 * runs the AO at half resolution on top.
 *
 * Measured, production build, 503x484, on the integrated GPU this machine's
 * browser actually uses (NOT the GTX 1650 — see the note at the bottom):
 *
 *     fx=off   (no composer)          28.5ms   35.1fps
 *     fx=full  (bloom + AgX + vig)    32.1ms   31.2fps
 *     X-ray dive                      20.8ms   48.1fps
 *
 * So the composer costs about 3.6ms, or 11%. That is a far smaller number
 * than the development build suggests: under `next dev` the same scene runs
 * at 13fps and the composer appears to cost 17ms, because React's dev-mode
 * instrumentation dominates everything. Do not tune this pipeline against
 * dev-server numbers. The first round of V7 optimisation was done that way
 * and chased a cost that does not exist in the shipped build.
 *
 * The dive being FASTER than the floor it launches from is not a mistake:
 * `DiveCulling` in MicroFacility switches off the city, the envelope, the
 * crowd and the plant, which is most of the frame.
 *
 * So the pipeline DEGRADES, once, in one direction. `QualityGovernor` watches
 * frame time and drops the AO pass if the card cannot hold 40fps with it. It
 * never re-enables: an effect that flickers in and out mid-pitch is worse
 * than one that is simply absent. Bloom and tone mapping are cheap enough to
 * keep unconditionally.
 * ============================================================================
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { Bloom, EffectComposer, N8AO, ToneMapping, Vignette } from '@react-three/postprocessing';
import { BlendFunction, ToneMappingMode } from 'postprocessing';

import { SITES, type SiteId } from '@/lib/sites';
import { FX_LEVEL } from '@/lib/quality';
import { SCENE } from '@/lib/theme';
import { useMegnetoStore } from '@/store/useMegnetoStore';

/* ========================================================================== */
/* ENVIRONMENT MAP                                                            */
/* ========================================================================== */

/**
 * A factory, not a photo studio.
 *
 * three ships `RoomEnvironment`, but it is a bright white showroom: run a
 * dark industrial hall through it and every machine picks up a soft white
 * sheen from all directions, which reads as plastic. A real high-bay shed
 * reflects something much more specific — long bright strips overhead, dark
 * everywhere else — and that is what puts the hard linear highlight along a
 * chromed cylinder.
 *
 * So: build that scene by hand, render it once through PMREM, keep the
 * texture, throw the scene away. One 256px cubemap, generated in about 4ms,
 * and the single highest-impact change in this entire file.
 */
function buildFactoryEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const scene = new THREE.Scene();

  const shell = new THREE.Mesh(
    new THREE.BoxGeometry(12, 6, 12),
    new THREE.MeshBasicMaterial({ color: '#0a1620', side: THREE.BackSide }),
  );
  scene.add(shell);

  // A darker floor than the walls: light falls off downward in a real shed.
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(12, 12),
    new THREE.MeshBasicMaterial({ color: '#060f16' }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -3;
  scene.add(floor);

  /* ---- the high-bay strips: five bright bars, running the long way ---- */
  const stripGeo = new THREE.PlaneGeometry(10.5, 0.55);
  const stripMat = new THREE.MeshBasicMaterial({ color: SCENE.highBay });
  for (let i = 0; i < 5; i++) {
    const strip = new THREE.Mesh(stripGeo, stripMat);
    strip.rotation.x = Math.PI / 2;
    strip.position.set(0, 2.98, -4 + i * 2);
    scene.add(strip);
  }

  /* ---- one cool wall wash, so the shadow side is not dead black ---- */
  const wash = new THREE.Mesh(
    new THREE.PlaneGeometry(11, 3),
    new THREE.MeshBasicMaterial({ color: '#17455f' }),
  );
  wash.position.set(0, 0.6, -5.9);
  scene.add(wash);

  /* ---- and one warm bounce off the far end, for colour separation ---- */
  const warm = new THREE.Mesh(
    new THREE.PlaneGeometry(11, 2),
    new THREE.MeshBasicMaterial({ color: '#53341f' }),
  );
  warm.position.set(0, -1.2, 5.9);
  warm.rotation.y = Math.PI;
  scene.add(warm);

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const target = pmrem.fromScene(scene, 0.04, 0.1, 100);

  /* ---- clean up the authoring scene; keep only the cubemap ---- */
  shell.geometry.dispose();
  (shell.material as THREE.Material).dispose();
  floor.geometry.dispose();
  (floor.material as THREE.Material).dispose();
  stripGeo.dispose();
  stripMat.dispose();
  wash.geometry.dispose();
  (wash.material as THREE.Material).dispose();
  warm.geometry.dispose();
  (warm.material as THREE.Material).dispose();
  pmrem.dispose();

  return target.texture;
}

function FactoryEnvironment() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);

  useEffect(() => {
    const texture = buildFactoryEnvironment(gl);
    scene.environment = texture;
    // Deliberately NOT `scene.background`: the clear colour is flat so the
    // fog has something to resolve to, and a visible cubemap behind a
    // top-down ortho view just looks like a smear.
    scene.environmentIntensity = 1.15;
    return () => {
      scene.environment = null;
      texture.dispose();
    };
  }, [gl, scene]);

  return null;
}

/* ========================================================================== */
/* LIGHT RIG                                                                  */
/* ========================================================================== */

/**
 * Three directionals and nothing else. No point lights, no spots, and above
 * all no per-machine lights: V2 shipped 44 of them and spent 113ms a frame
 * on the GTX 1650. Every glow on this floor is either emissive geometry that
 * bloom picks up, or a reflection from the environment map.
 */
function KeyRig({ siteId }: { siteId: SiteId }) {
  const def = SITES[siteId];
  const W = def.shell.width;
  const D = def.shell.depth;
  const top = def.shell.floorHeight * 3;

  return (
    <>
      {/* Key: high, slightly in front, cool white — a roof monitor. */}
      <directionalLight position={[W * 0.55, top * 3.4, D * 0.7]} intensity={2.1} color="#eaf6ff" />
      {/* Fill: opposite side, dimmer and bluer, lifts the shadow side. */}
      <directionalLight position={[-W * 0.7, top * 1.8, -D * 0.5]} intensity={0.55} color="#7fb4d8" />
      {/* Rim: low and warm from behind, separates plant from the dark shell. */}
      <directionalLight position={[-W * 0.3, top * 0.5, D * 1.4]} intensity={0.42} color="#ffb27a" />
    </>
  );
}

/* ========================================================================== */
/* QUALITY GOVERNOR                                                           */
/* ========================================================================== */

/**
 * One-way degrade. Samples frame time outside React, and if the card cannot
 * hold the target with AO on, drops AO — once, permanently, for the session.
 *
 * `useState` here is safe precisely because it fires at most once: this is
 * not a data stream, it is a one-shot capability decision. Everything that
 * actually changes per frame still goes through refs.
 */
function QualityGovernor({ onDegrade }: { onDegrade: () => void }) {
  const gl = useThree((s) => s.gl);

  useEffect(() => {
    let raf = 0;
    let frames = 0;
    let acc = 0;
    let last = performance.now();
    /* Two windows of grace: the first second after a dive is shader compiles
     * and texture uploads, and judging the GPU on that would degrade every
     * session. */
    let grace = 2;
    let strikes = 0;

    const tick = () => {
      const now = performance.now();
      acc += now - last;
      last = now;
      frames += 1;

      if (acc >= 1200) {
        const fps = (frames * 1000) / acc;
        acc = 0;
        frames = 0;

        if (grace > 0) {
          grace -= 1;
        } else if (fps < 40) {
          // Two consecutive bad windows, not one: a single GC pause or a
          // window resize should not cost the pitch its ambient occlusion.
          strikes += 1;
          if (strikes >= 2) {
            console.warn(
              `[megneto] ${fps.toFixed(1)}fps with AO enabled — dropping the AO pass for this session`,
            );
            onDegrade();
            return; // stop sampling; the decision is final
          }
        } else {
          strikes = 0;
        }
      }

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [gl, onDegrade]);

  return null;
}

/* ========================================================================== */
/* THE COMPOSER                                                               */
/* ========================================================================== */

export interface LightingAndEffectsProps {
  siteId: SiteId;
}

export default function LightingAndEffects({ siteId }: LightingAndEffectsProps) {
  const gl = useThree((s) => s.gl);
  const [aoEnabled, setAoEnabled] = useState(FX_LEVEL === 'full');
  const degraded = useRef(false);

  /**
   * The composer applies its own tone mapping pass, so the renderer must not
   * also apply one — tone mapping twice crushes the highlights that bloom is
   * supposed to be picking out, and the LEDs come out grey.
   */
  useEffect(() => {
    if (FX_LEVEL === 'off') return;
    const previous = gl.toneMapping;
    gl.toneMapping = THREE.NoToneMapping;
    return () => {
      gl.toneMapping = previous;
    };
  }, [gl]);

  const onDegrade = useMemo(
    () => () => {
      if (degraded.current) return;
      degraded.current = true;
      setAoEnabled(false);
    },
    [],
  );

  /**
   * Bloom thresholds.
   *
   * `luminanceThreshold` at 0.62 is chosen against the actual palette: the
   * unlit beacons, the tracker box and the high-bay strips sit above it; the
   * pale machine bodies (#e6f0f8 under a 2.1 key) sit just below. Drop it to
   * 0.4 and the entire plant glows, which is the mistake that makes a scene
   * look like a screensaver instead of a factory.
   */
  /* `?fx=off` — the escape hatch. The environment map and the light rig stay,
   * because they are not the expensive part and the scene is unlit without
   * them; only the composer goes. See `lib/quality.ts`. */
  if (FX_LEVEL === 'off') {
    return (
      <>
        <FactoryEnvironment />
        <KeyRig siteId={siteId} />
      </>
    );
  }

  return (
    <>
      <FactoryEnvironment />
      <KeyRig siteId={siteId} />
      {aoEnabled && <QualityGovernor onDegrade={onDegrade} />}

      <EffectComposer
        /* ---- MSAA off, deliberately ----
         *
         * The composer owns its own targets, so the canvas `antialias: true`
         * does nothing once this is mounted. Turning it back on here means
         * multisampling a HALF-FLOAT target and resolving it every frame —
         * for edge quality that is largely invisible once bloom has softened
         * the highlights and the DPR governor is running below 1.0 anyway.
         * Not separately benchmarked; left off because nothing in the frame
         * asked for it.
         */
        multisampling={0}
        /* HDR. Without it bloom has no headroom above 1.0 to bloom FROM. */
        frameBufferType={THREE.HalfFloatType}
        /* N8AO builds the depth/normal buffer it needs internally. Asking
         * the composer for a normal pass as well renders the scene an extra
         * time for a buffer nothing else consumes. */
        enableNormalPass={false}
      >
        {/* `enabled` rather than unmounting: pulling a pass out of a live
          * composer rebuilds the pass chain and recompiles shaders, which is
          * a visible hitch. Toggling the flag skips the pass and keeps the
          * chain stable, at the cost of a couple of MB of half-res targets we
          * no longer read. Worth it to never hitch on stage. */}
        <N8AO
            enabled={aoEnabled}
            /* Metres. The gap between a machine foot and the slab. */
            aoRadius={0.55}
            /* Stops a distant wall occluding a near machine through the gap. */
            distanceFalloff={0.9}
            intensity={2.6}
            /* Cool, not black: dirt in the corners of a blue-lit hall. */
            color="#061420"
            /* Half-res AO, full-res composite. The standard trade, and on a
             * 4GB card it is the difference between shipping AO and not. */
            halfRes
            /* 'performance' is 8 samples against 'medium''s 16. The
             * difference on a scene this geometrically simple is a slightly
             * noisier contact shadow that the denoiser then smooths anyway;
             * the difference in cost is not slight. */
            quality="performance"
            denoiseSamples={4}
            /* Depth-aware upsampling re-reads full-res depth per pixel to
             * rebuild the half-res AO edges. It is the right call on a
             * foliage-heavy scene; here the silhouettes are boxes and
             * cylinders, and it is not worth its bandwidth. */
            depthAwareUpsampling={false}
            screenSpaceRadius={false}
          />

        <Bloom
          luminanceThreshold={0.62}
          luminanceSmoothing={0.22}
          intensity={1.35}
          /* Mipmap blur gives a wide, soft falloff for about the cost of the
           * mip chain, instead of a fixed-width gaussian at full res. */
          mipmapBlur
          /* ---- four levels, not the default eight ----
           *
           * Each MIP level is a downsample AND an upsample pass. At the
           * default 8 that is 16 fullscreen passes, which is why
           * `renderer.render` gets called NINETEEN times a frame with this
           * composer mounted — a surprising number if you go looking, and
           * entirely normal for `postprocessing`.
           *
           * Honest note on this value: halving it to 4 made NO measurable
           * difference to frame time in either build. The passes are over
           * progressively tiny mips, so they are nearly free. It is kept at
           * 4 because the smaller chain gives a tighter, more defined glow
           * around the small bright sources in this scene (LED beacons,
           * high-bay strips, the tracker box) rather than the wide haze the
           * full chain produces — a look decision, not a performance one.
           * `radius` and `intensity` are raised to compensate.
           */
          levels={4}
          radius={0.86}
        />

        {/* Pulls the dark end up so the shell reads as dark grey, not a hole,
         * and rolls the bloom highlights off instead of clipping them. */}
        <ToneMapping mode={ToneMappingMode.AGX} />

        {/* Barely there. Just enough to stop the eye leaving the frame. */}
        <Vignette offset={0.32} darkness={0.42} blendFunction={BlendFunction.NORMAL} />
      </EffectComposer>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* X-ray grading                                                               */
/* -------------------------------------------------------------------------- */

/**
 * During the deep dive the hall goes away and the clear colour drops almost
 * to black, so the glowing blueprint has maximum contrast to sit against.
 *
 * This is a renderer-level change driven straight off the store, with no
 * re-render: the component subscribes to nothing and reads the flag in its
 * own rAF loop.
 */
export function XrayGrading() {
  const gl = useThree((s) => s.gl);

  useEffect(() => {
    const hall = new THREE.Color(SCENE.fogBase);
    const xray = new THREE.Color(SCENE.xrayClear);
    const current = new THREE.Color().copy(hall);
    let raf = 0;

    const tick = () => {
      const diving = useMegnetoStore.getState().kinematicMachineId !== null;
      current.lerp(diving ? xray : hall, 0.08);
      gl.setClearColor(current, 1);
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [gl]);

  return null;
}
