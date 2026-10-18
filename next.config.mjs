import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false, // StrictMode double-mounts WebGL contexts: fatal on 4GB VRAM.
  productionBrowserSourceMaps: false,
  webpack: (config, { isServer }) => {
    // Cesium pulls in Node built-ins through its optional pipeline; stub them in the browser.
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      path: false,
      http: false,
      https: false,
      zlib: false,
      url: false,
    };
    // Cesium's Gaussian-splat decoder inlines WASM as a string that the SWC
    // minifier turns into invalid JavaScript, which kills the production
    // bundle. We never decode splats, so point it at a stub.
    config.resolve.alias = {
      ...config.resolve.alias,
      '@spz-loader/core': path.join(root, 'lib', 'stubs', 'spz-loader.mjs'),
    };

    if (isServer) {
      // Never let the Cesium engine get traced into the server bundle.
      config.externals = [...(config.externals || []), 'cesium'];
    }
    return config;
  },
};

export default nextConfig;
