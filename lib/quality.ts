/**
 * RENDER QUALITY SWITCHES
 *
 * Two jobs, both of which turned out to be necessary once the V7 pipeline
 * went in:
 *
 *  1. A WAY TO MEASURE. "The composer costs N milliseconds" is not something
 *     you can establish by reading the code, and you cannot benchmark a pass
 *     you have no way to turn off. Every number quoted in the comments in
 *     `LightingAndEffects.tsx` was measured by loading the same scene twice
 *     with different values of `fx` and diffing the frame times.
 *
 *  2. A WAY OUT ON THE NIGHT. This runs on one specific laptop in front of
 *     investors. If the machine is thermally throttled, or the browser has
 *     fallen back to integrated graphics — which it does by default on an
 *     Optimus laptop unless Windows is told otherwise — `?fx=off` restores
 *     the V6 renderer instantly, with no rebuild and no code change. That is
 *     worth having in your pocket.
 *
 * Read ONCE, at module load, deliberately. These must not change mid-session:
 * swapping the pipeline on a live canvas means recompiling every shader in
 * the scene, and doing that in front of an audience is exactly the hitch all
 * of this is trying to avoid.
 */

export type FxLevel =
  /** Full pipeline: ambient occlusion, bloom, tone mapping, vignette. */
  | 'full'
  /** Bloom and tone mapping only. Drops the AO pass, which is the expensive one. */
  | 'noao'
  /** No composer at all. The V6 renderer, for when the GPU is not cooperating. */
  | 'off';

function read(): { fx: FxLevel; dpr: number | null } {
  // Server render, or any non-browser context.
  if (typeof window === 'undefined') return { fx: 'full', dpr: null };

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(window.location.search);
  } catch {
    return { fx: 'full', dpr: null };
  }

  const raw = params.get('fx');
  const fx: FxLevel = raw === 'off' ? 'off' : raw === 'noao' ? 'noao' : 'full';

  // `?dpr=1` pins the resolution governor, so two benchmark runs are
  // comparable. Without it the governor is still adapting while you measure
  // and the numbers mean nothing.
  const dprRaw = params.get('dpr');
  const parsed = dprRaw === null ? NaN : Number.parseFloat(dprRaw);
  const dpr = Number.isFinite(parsed) ? Math.min(2, Math.max(0.5, parsed)) : null;

  return { fx, dpr };
}

const SETTINGS = read();

export const FX_LEVEL = SETTINGS.fx;
/** Non-null only when the URL pins it. Null means "let the governor run". */
export const PINNED_DPR = SETTINGS.dpr;
