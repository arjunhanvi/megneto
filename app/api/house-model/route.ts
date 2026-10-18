import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';

/**
 * Does the DRACO house shell actually exist?
 *
 * The micro layer needs to know before it decides between the GLTF shell and
 * the procedural one. Probing with a client-side HEAD request works, but a
 * missing file then logs a red 404 in the console - and on demo night the
 * console is sometimes on the projector. So we ask the server instead.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  // The blueprint asks for factory.glb; house.glb is kept as a legacy name so
  // an existing model does not silently stop being used.
  const candidates = ['factory.glb', 'house.glb'].map((f) => path.join(process.cwd(), 'public', 'models', f));
  for (const file of candidates) {
    try {
      await access(file, constants.R_OK);
      return NextResponse.json({ present: true, file: path.basename(file) });
    } catch {
      /* try the next candidate */
    }
  }
  return NextResponse.json({ present: false });
}
