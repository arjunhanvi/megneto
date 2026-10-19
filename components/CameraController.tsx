'use client';

/**
 * THE CAMERA RIG
 *
 * One component owns every camera movement in the micro layer: the settle-in
 * when the facility first builds, and the interpolation between floors when
 * the user picks a level.
 *
 * ============================================================================
 * WHY THIS IS A LERP AND NOT AN ANIMATION LIBRARY
 * ============================================================================
 * The whole transition is three `MathUtils.lerp` calls per frame against a
 * smoothstep-eased progress value, written directly onto the camera and the
 * OrbitControls target. No tween objects are allocated, nothing subscribes,
 * and the component does not re-render while it runs — it reads `activeFloor`
 * with `getState()` inside `useFrame` and compares it to a ref.
 *
 * Controls are disabled for the duration so the user cannot fight the
 * transition, and handed straight back when it lands.
 * ============================================================================
 */

import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { archetypeFor, mechanismScale, trackedFocus } from '@/lib/machineInventory';
import { KINEMATICS, SITES, floorElevation, type FloorSelection, type SiteId } from '@/lib/sites';
import { getSite, useMegnetoStore } from '@/store/useMegnetoStore';

/** Seconds a floor change takes. Long enough to read, short enough to not wait. */
const TRANSITION_SECONDS = 1.15;

/** Classic smoothstep. Eases both ends without overshoot. */
const smoothstep = (t: number) => t * t * (3 - 2 * t);

interface Framing {
  /** Where the orbit target sits. */
  target: THREE.Vector3;
  /** Camera offset from the target, in world units. */
  offset: THREE.Vector3;
  zoom: number;
}

export default function CameraController({ siteId }: { siteId: SiteId }) {
  const camera = useThree((s) => s.camera) as THREE.OrthographicCamera;
  const domElement = useThree((s) => s.gl.domElement);
  const site = SITES[siteId];
  const span = Math.max(site.shell.width, site.shell.depth);

  /**
   * Framing per selection. Isolating a level drops the target onto that slab
   * and pushes in; 'all' pulls back and raises the target to the middle of the
   * stack so the whole building sits in frame.
   */
  const framings = useMemo(() => {
    const dir = new THREE.Vector3(0.85, 0.78, 0.85).normalize();
    const build = (selection: FloorSelection): Framing => {
      if (selection === 'all') {
        const midY = floorElevation(site, 1) + site.shell.floorHeight * 0.5;
        return {
          target: new THREE.Vector3(0, midY, 0),
          offset: dir.clone().multiplyScalar(span * 1.5),
          zoom: 640 / span,
        };
      }
      const y = floorElevation(site, selection) + site.shell.floorHeight * 0.45;
      return {
        target: new THREE.Vector3(0, y, 0),
        offset: dir.clone().multiplyScalar(span * 1.25),
        zoom: 980 / span,
      };
    };
    return {
      all: build('all'),
      0: build(0),
      1: build(1),
      2: build(2),
    } as Record<string, Framing>;
  }, [site, span]);

  /**
   * Tight framing on one machine, for the exploded view. The camera drops to
   * the machine's own elevation and pushes in hard — close enough that the
   * casing lifting clear and the core sensor pulsing are the whole frame.
   */
  const machineFraming = useMemo(() => {
    const dir = new THREE.Vector3(0.8, 0.62, 0.8).normalize();
    return (machineId: string): Framing | null => {
      const def = site.machines.find((m) => m.id === machineId);
      if (!def) return null;
      const y = floorElevation(site, def.floor) + def.position[1] + def.size[1] * 0.62;
      const reach = Math.max(def.size[0], def.size[2]);
      return {
        target: new THREE.Vector3(def.position[0], y, def.position[2]),
        offset: dir.clone().multiplyScalar(reach * 5.5 + 6),
        // Frame the machine to roughly a third of the viewport height.
        zoom: 150 / Math.max(1.4, reach),
      };
    };
  }, [site]);

  /**
   * Framing for one person. Tighter than a machine and lower, because a
   * worker is 1.2 m of subject and the interesting context is the two metres
   * of floor around them.
   */
  const workerFraming = useMemo(() => {
    const dir = new THREE.Vector3(0.75, 0.55, 0.75).normalize();
    return (index: number): Framing | null => {
      const s = getSite(siteId);
      if (index < 0 || index >= s.mob.count) return null;
      const tracked = index < s.operators.length;
      const src = tracked ? s.positions : s.mob.positions;
      const o = index * 3;
      return {
        target: new THREE.Vector3(src[o], src[o + 1] + 0.9, src[o + 2]),
        offset: dir.clone().multiplyScalar(11),
        zoom: 118,
      };
    };
  }, [siteId]);

  /**
   * The macro lens.
   *
   * Framed on the TRACKED PART, not on the machine. The first version
   * targeted `def.size[1] * 0.78` — 78% of the way up the floor-plan
   * envelope — which for a 4.6m "stitching line" put the camera 0.94m above
   * the bench while the needle it is supposed to be watching sits at 0.38m.
   * The dive arrived perfectly composed on a patch of empty air above the
   * machine, and the mechanism was below the bottom of the frame.
   *
   * `trackedFocus` returns the part's real height and how much room it needs,
   * derived from the same archetype the renderer builds the mechanism from,
   * so the two cannot disagree about where the subject is.
   */
  const kinematicFraming = useMemo(() => {
    const dir = new THREE.Vector3(0.7, 0.42, 0.9).normalize();
    return (machineId: string): Framing | null => {
      const def = site.machines.find((m) => m.id === machineId);
      if (!def) return null;

      const archetype = archetypeFor(def, KINEMATICS[def.kind].kind);
      const scale = mechanismScale(archetype, def.size);
      const focus = trackedFocus(archetype, scale);

      /* The mechanism is drawn inside a group rotated by `def.rotation`, so
       * the part's local offset has to be rotated the same way before it is
       * added to the machine's world position — otherwise the lens lands on
       * the correct part of a machine that has been turned 90°, which is the
       * wrong place in the room. */
      const c = Math.cos(def.rotation);
      const sn = Math.sin(def.rotation);
      const [ox, oy, oz] = focus.offset;
      const target = new THREE.Vector3(
        def.position[0] + ox * c + oz * sn,
        floorElevation(site, def.floor) + def.position[1] + oy,
        def.position[2] - ox * sn + oz * c,
      );

      return {
        target,
        offset: dir.clone().multiplyScalar(5.5),
        // Fill roughly two thirds of the viewport height with the subject.
        // Clamped to the controls' own ceiling, which is what silently ate
        // the V6 macro lens when it asked for more than maxZoom.
        zoom: THREE.MathUtils.clamp(300 / focus.radius, 60, 410),
      };
    };
  }, [site]);

  const controls = useMemo(() => {
    const c = new OrbitControls(camera, domElement);
    c.enableDamping = true;
    c.dampingFactor = 0.08;
    c.rotateSpeed = 0.55;
    c.zoomSpeed = 0.85;
    c.panSpeed = 0.7;
    c.screenSpacePanning = false;
    c.minZoom = 8;
    // The macro lens needs to reach ~330 to frame a needle bar; a lower
    // ceiling here silently clamps the deep dive and it just looks like the
    // camera did not arrive.
    c.maxZoom = 420;
    // Locked to a tactical arc: no flipping under the slab, no vertigo.
    c.minPolarAngle = Math.PI * 0.14;
    c.maxPolarAngle = Math.PI * 0.44;
    return c;
  }, [camera, domElement]);

  useEffect(() => () => controls.dispose(), [controls]);

  /* ---- transition state, all in refs ---- */
  const tween = useRef({
    active: false,
    t: 0,
    fromTarget: new THREE.Vector3(),
    toTarget: new THREE.Vector3(),
    fromPos: new THREE.Vector3(),
    toPos: new THREE.Vector3(),
    fromZoom: 1,
    toZoom: 1,
  });
  const lastSelection = useRef<FloorSelection | null>(null);
  const lastExploded = useRef<string | null>(null);
  const lastKinematic = useRef<string | null>(null);
  const lastFocusedWorker = useRef<number | null>(null);
  /** Scratch, so following a walking worker allocates nothing per frame. */
  const followTarget = useRef(new THREE.Vector3());
  const introDone = useRef(false);

  /** Point the camera at a framing, either instantly or over the transition. */
  const flyToFraming = (f: Framing | null | undefined, instant: boolean) => {
    if (!f) return;
    const tw = tween.current;

    tw.toTarget.copy(f.target);
    tw.toPos.copy(f.target).add(f.offset);
    tw.toZoom = f.zoom;

    if (instant) {
      controls.target.copy(tw.toTarget);
      camera.position.copy(tw.toPos);
      camera.zoom = tw.toZoom;
      camera.updateProjectionMatrix();
      controls.update();
      tw.active = false;
      return;
    }

    tw.fromTarget.copy(controls.target);
    tw.fromPos.copy(camera.position);
    tw.fromZoom = camera.zoom;
    tw.t = 0;
    tw.active = true;
    controls.enabled = false;
  };

  const flyTo = (selection: FloorSelection, instant: boolean) =>
    flyToFraming(framings[String(selection)], instant);

  /* ---- first frame: sit at the deep-linked framing immediately ---- */
  useEffect(() => {
    const selection = useMegnetoStore.getState().activeFloor;
    lastSelection.current = selection;
    flyTo(selection, true);
    // A short pull-in so the facility does not simply appear at rest.
    camera.zoom = framings[String(selection)].zoom * 0.55;
    camera.updateProjectionMatrix();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId]);

  useFrame((_, dt) => {
    const tw = tween.current;

    /* ======================================================================
     * THE CAMERA LOCK
     * ======================================================================
     * While the X-ray dive is open the user does not get the camera back.
     *
     * The dive is a demonstration with a script: watch this part move, watch
     * the counter follow it. An investor who orbits away mid-sentence — or
     * who nudges the wheel and zooms into the inside of a cylinder — has lost
     * the only thing the view exists to show. So controls stay disabled for
     * the whole dive and the DISENGAGE button is the single way out.
     *
     * This sits ABOVE the tween logic because the tween hands controls back
     * when it lands (`controls.enabled = true`), and that must not happen
     * while a dive is open. Re-asserting it here every frame is what makes
     * the lock hold rather than flicker off the moment the fly-in completes.
     * ==================================================================== */
    const locked = useMegnetoStore.getState().kinematicMachineId !== null;
    if (locked && controls.enabled) controls.enabled = false;

    /* --- intro: ease the zoom in on mount --- */
    if (!introDone.current && !tw.active) {
      const selection = lastSelection.current ?? 'all';
      const goal = framings[String(selection)].zoom;
      camera.zoom = THREE.MathUtils.lerp(camera.zoom, goal, 1 - Math.exp(-dt * 2.6));
      camera.updateProjectionMatrix();
      if (Math.abs(camera.zoom - goal) < goal * 0.01) {
        camera.zoom = goal;
        camera.updateProjectionMatrix();
        introDone.current = true;
      }
    }

    /* --- following a worker beats everything: they are moving --- */
    const focusedWorker = useMegnetoStore.getState().focusedWorkerIndex;
    if (focusedWorker !== lastFocusedWorker.current) {
      lastFocusedWorker.current = focusedWorker;
      introDone.current = true;
      if (focusedWorker !== null) {
        flyToFraming(workerFraming(focusedWorker), false);
      } else {
        flyTo(useMegnetoStore.getState().activeFloor, false);
      }
    }

    if (focusedWorker !== null && !tw.active) {
      // Once the fly-in has landed, keep the camera glued to them. The target
      // and the position move together, so the framing holds while they walk.
      const f = workerFraming(focusedWorker);
      if (f) {
        followTarget.current.copy(f.target);
        const ease = 1 - Math.exp(-dt * 3.5);
        controls.target.lerp(followTarget.current, ease);
        camera.position.lerp(followTarget.current.clone().add(f.offset), ease);
      }
      controls.update();
      return;
    }

    /* --- the kinematic deep dive outranks the floor and exploded views --- */
    const kinematic = useMegnetoStore.getState().kinematicMachineId;
    if (kinematic !== lastKinematic.current) {
      const previous = lastKinematic.current;
      lastKinematic.current = kinematic;
      introDone.current = true;
      if (kinematic) {
        flyToFraming(kinematicFraming(kinematic), false);
        return;
      }
      if (previous) {
        flyTo(useMegnetoStore.getState().activeFloor, false);
        lastSelection.current = useMegnetoStore.getState().activeFloor;
        return;
      }
    }

    /* --- exploded view takes priority over the floor framing --- */
    const exploded = useMegnetoStore.getState().explodedMachineId;
    const selection = useMegnetoStore.getState().activeFloor;

    if (exploded !== lastExploded.current) {
      const previous = lastExploded.current;
      lastExploded.current = exploded;
      introDone.current = true;

      if (exploded) {
        // Opening a machine: push in on it.
        flyToFraming(machineFraming(exploded), false);
        lastSelection.current = selection;
        return;
      }
      if (previous) {
        // "Back to Floor": return to whichever level we are isolating.
        flyTo(selection, false);
        lastSelection.current = selection;
        return;
      }
    }

    /* --- did the floor selection change? --- */
    if (selection !== lastSelection.current) {
      lastSelection.current = selection;
      introDone.current = true;
      // Changing floors while a machine is open reassembles it first; the
      // store clears explodedMachineId, and the next tick flies us out.
      if (!exploded) flyTo(selection, false);
    }

    /* --- run the transition --- */
    if (tw.active) {
      tw.t = Math.min(1, tw.t + dt / TRANSITION_SECONDS);
      const e = smoothstep(tw.t);

      controls.target.lerpVectors(tw.fromTarget, tw.toTarget, e);
      camera.position.lerpVectors(tw.fromPos, tw.toPos, e);
      camera.zoom = THREE.MathUtils.lerp(tw.fromZoom, tw.toZoom, e);
      camera.updateProjectionMatrix();

      if (tw.t >= 1) {
        tw.active = false;
        // Hand the camera back — unless the dive still has it locked.
        controls.enabled = !locked;
      }
    }

    controls.update();
  });

  return null;
}
