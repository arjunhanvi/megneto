/**
 * Megneto asset bootstrap.
 *
 * Cesium needs its Workers / Assets / Widgets / ThirdParty folders served from a
 * static path (window.CESIUM_BASE_URL). Draco needs its wasm decoder served the
 * same way so house.glb can be DRACO-compressed. Neither can be bundled by
 * webpack, so we mirror them into /public on install.
 */
import { cp, mkdir, access, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const exists = async (p) => {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

const jobs = [
  {
    label: 'Cesium engine',
    from: path.join(root, 'node_modules', 'cesium', 'Build', 'Cesium'),
    to: path.join(root, 'public', 'cesium'),
  },
  {
    label: 'Draco decoder',
    from: path.join(root, 'node_modules', 'three', 'examples', 'jsm', 'libs', 'draco', 'gltf'),
    to: path.join(root, 'public', 'draco'),
  },
];

await mkdir(path.join(root, 'public'), { recursive: true });

for (const job of jobs) {
  if (!(await exists(job.from))) {
    console.warn(`[megneto] skip ${job.label}: ${path.relative(root, job.from)} not found`);
    continue;
  }
  await rm(job.to, { recursive: true, force: true });
  await cp(job.from, job.to, { recursive: true });
  console.log(`[megneto] ${job.label} -> ${path.relative(root, job.to)}`);
}
