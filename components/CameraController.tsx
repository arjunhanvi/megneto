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

import { SITES, floorElevation, type FloorSelection, type SiteId } from '@/lib/sites';
import { useMegnetoStore } from '@/store/useMegnetoStore';

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

  const controls = useMemo(() => {
    const c = new OrbitControls(camera, domElement);
    c.enableDamping = true;
    c.dampingFactor = 0.08;
    c.rotateSpeed = 0.55;
    c.zoomSpeed = 0.85;
    c.panSpeed = 0.7;
    c.screenSpacePanning = false;
    c.minZoom = 8;
    c.maxZoom = 120;
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
  const introDone = useRef(false);

  /** Point the camera at a framing, either instantly or over the transition. */
  const flyTo = (selection: FloorSelection, instant: boolean) => {
    const f = framings[String(selection)];
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

    /* --- did the floor selection change? --- */
    const selection = useMegnetoStore.getState().activeFloor;
    if (selection !== lastSelection.current) {
      lastSelection.current = selection;
      introDone.current = true;
      flyTo(selection, false);
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
        controls.enabled = true; // hand the camera back
      }
    }

    controls.update();
  });

  return null;
}
