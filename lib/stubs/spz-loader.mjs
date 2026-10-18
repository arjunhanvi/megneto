/**
 * Stub for `@spz-loader/core`.
 *
 * Cesium 1.14x pulls this in through `GltfSpzLoader` to decode
 * KHR_spz_gaussian_splats_compression. The package inlines a WebAssembly blob
 * as a JavaScript string, and Next's SWC minifier re-emits that string as a
 * TEMPLATE literal. The blob starts with the WASM magic header `\0asm`, and an
 * octal escape inside a template literal is a hard SyntaxError - so the chunk
 * fails to parse, webpack reports it as a missing chunk, and the PRODUCTION
 * build dies on load with "Application error: a client-side exception has
 * occurred". The dev server, which does not minify, is perfectly happy. That is
 * a spectacularly bad thing to discover during a pitch.
 *
 * Megneto never loads a Gaussian-splat tileset, so the decoder is aliased to
 * this file in next.config.mjs. If a splat asset is ever added, remove the
 * alias and find another way around the minifier.
 */

export function loadSpz() {
  throw new Error(
    '[megneto] @spz-loader/core is stubbed out (see lib/stubs/spz-loader.mjs). ' +
      'Gaussian-splat glTF assets are not supported in this build.',
  );
}

export default { loadSpz };
