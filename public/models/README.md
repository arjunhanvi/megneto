# Drop `house.glb` here

Megneto's micro-factory renders a procedural six-bay shell out of the box, so
the demo works with this folder empty.

To use the real house, export it as **`house.glb`** into this folder:

- **DRACO compression is supported and recommended.** The decoder is served
  from `/public/draco` (mirrored out of `three` by `scripts/copy-static-assets.mjs`).
- Orientation: **+Y up, +Z toward the south wall.** The loader auto-centres the
  model on the slab and scales its footprint to 18m x 14m, so the machine
  blueprint in `lib/facility.ts` lands in the right rooms.
- Keep it under ~25 MB and ~150k triangles. The target GPU is a 4GB GTX 1650
  that also has to hold the instanced crowd.
- Bake your lighting into vertex colours or textures. The scene deliberately
  runs **no shadow maps**.

With X-RAY on (the default), every material in the shell is dropped to 17%
opacity with depth writes off, so the machines and operators read through the
walls. Press `X` to toggle it.
