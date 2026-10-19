import type * as THREE from 'three';

/**
 * THE ANCHOR REGISTRY
 *
 * Shared, mutable, module-level state connecting the projected-DOM overlays to
 * the `<Projector/>` that lives inside the canvas. Each overlay registers a DOM
 * node plus a function that reports where in world space it should sit; the
 * projector walks the registry once per frame and writes `transform`.
 *
 * This lives in its own module purely to break an import cycle: the overlay
 * root renders the worker card, and the worker card needs to register an
 * anchor. Importing the registry from the overlay would make those two modules
 * depend on each other. Function declarations are hoisted so such a cycle
 * happens to work in ESM, but "happens to work" is not a dependency graph
 * anyone should have to reason about at 2am before a pitch.
 */

export interface Anchor {
  el: HTMLElement | null;
  /** Fills `out` with this anchor's current world position. */
  read: (out: THREE.Vector3) => void;
}

export const anchors = new Map<string, Anchor>();

export function registerAnchor(key: string, el: HTMLElement | null, read: (out: THREE.Vector3) => void) {
  if (el) anchors.set(key, { el, read });
  else anchors.delete(key);
}

export function clearAnchors() {
  anchors.clear();
}
