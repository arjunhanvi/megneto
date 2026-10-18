# Megneto V3

A **multi-site, macro-to-micro spatial digital twin**. A CesiumJS globe carrying
live regional weather dives into either of two industrial nodes, each rendered as
a **three-storey** instanced React Three Fiber stack you can isolate floor by
floor, each running a genuine environmental physics model that drives what you
see — and every view is a shareable URL.

| | Site A | Site B |
|---|---|---|
| | **Swift Merchandise Textile Factory** | **Industrial Printing Hub** |
| Location | Tiruppur, Tamil Nadu | Rajajinagar, Bengaluru |
| Makes | Knitted garments | Printed impressions |
| Ground | Spinning · dye house · ZLD | Offset presses · ink · HT intake |
| First | Knitting · cutting · stitching | Prepress · binding · finishing |
| Second | Checking · packing · export | Paper store · QA · dispatch |
| Headcount | 1,850 | 1,150 |

Built to present on a laptop with an **Intel i5-10300H, 8GB RAM and a GTX 1650
(4GB VRAM)** — every architectural decision below exists because of that.

---

## Run it

```bash
npm install
npm run dev
```

Open <http://localhost:3000>. For the pitch itself, run the production build —
roughly twice the frame rate of the dev server:

```bash
npm run build
npm start
```

`npm install` runs `scripts/copy-static-assets.mjs`, which mirrors Cesium's
engine assets into `public/cesium` and the DRACO decoder into `public/draco`.
Both folders are gitignored and rebuilt on every install.

### Optional: a Cesium ion token

Copy `.env.example` to `.env.local` and add a free token from
<https://ion.cesium.com/tokens>. With one you get world terrain, aerial imagery
and OSM buildings; without one it degrades to OpenStreetMap raster tiles on a
smooth ellipsoid, and the HUD says so. The demo is fully functional either way.

### Optional: a facility model

Drop a `factory.glb` into `public/models/` and it is drawn as a translucent
outer **envelope** around the procedural stack, auto-fitted to the footprint and
full building height. It is deliberately held at 12% opacity: the three storeys
inside it are what the demo is about, so the model must never occlude them.

---

## Shareable links

The URL **is** the state. Send someone a view and they land in it:

```
/?site=tiruppur&floor=2      second floor of the Tiruppur mill
/?site=rajajinagar&floor=0   press hall at Rajajinagar
/?site=tiruppur&floor=all    whole Tiruppur building
/                            the globe
```

A deep link **bypasses the globe entirely** — the phase machine boots straight
to `micro`, which means the Cesium chunk is never even fetched. The fastest path
into the demo is also the cheapest one.

`floor` accepts `0`/`1`/`2` as indices and also tolerates `3` for the top floor,
because people type what they see on the pills. Anything unparseable falls back
to `all` rather than erroring.

The **SHARE THIS VIEW** button copies the current link. Writes go through
`router.replace(..., { scroll: false })` and only when the serialised value
actually changes — calling it on every store update would re-render the route
tree sixty times a second.

---

## Controls

On the globe:

| Key | Action |
|---|---|
| `1` / `2` | Dive into Tiruppur / Rajajinagar |
| `Space` | Freeze / resume the simulation |

On a floor:

| Key | Action |
|---|---|
| `1` / `2` / `3` | Isolate ground / first / second floor |
| `0` | Show the whole building |
| `Esc` | Close the open panel, or return to orbit |
| `Space` | Freeze / resume |

Click either marker on the globe to dive. On a floor: click a machine or an
environmental node for diagnostics — and when one is **alerting**, that click is
the fix.

---

## The four things this codebase is actually about

### 1. One renderer resident at a time

A Cesium globe and a populated R3F scene will not share 4GB of VRAM. So they
never do. `app/page.tsx` is a phase machine, and the mount gates are the
contract:

| phase | Cesium | R3F | veil |
|---|---|---|---|
| `macro` | mounted | — | clear |
| `descending` | flying to the chosen site | — | closes at 2.5s |
| `handoff` | **destroyed** | mounting, compiling | opaque |
| `micro` | — | mounted | clear |
| `ascending` | rebuilt *after* R3F leaves | **destroyed** | shut, then reopens |

On the way back out the facility gets a 260ms grace period and the globe is not
allowed to start building until it has gone — `showGlobe` carries an explicit
`&& !facilityResident` for exactly that.

### 2. The vertical factory

Three thousand people on one slab is visual mush — you cannot point at anything.
The plant is stacked the way a real mill is: heavy wet process on the ground
where the foundations and drains are, labour-dense lines above it, QA and
dispatch on top. Each floor holds three zones across the full footprint.

Picking a level drops the other two to ~10% opacity and strips their solid
faces, leaving a wireframe cage so you keep the sense of the whole building
while reading one floor. **That transition is not React.** Each level collects
its materials once on mount into a flat array, and a single `useFrame` lerps
opacity toward the target. `activeFloor` is read with `getState()` inside the
frame loop, so `FloorStack` never subscribes to it and never re-renders.

Operators on hidden levels are parked at zero scale rather than faded —
per-instance opacity would need a custom shader, and the matrices are being
written that frame anyway, so it is free.

`floorElevation(site, floor)` is the **only** place a floor index becomes a
world Y. Nothing else in the renderer computes elevation.

### 3. The camera is three lerps

`CameraController` owns every camera movement: the settle-in on mount and the
interpolation between floors. The whole transition is three `MathUtils.lerp`
calls per frame against a smoothstep-eased progress value, written straight onto
the camera and the OrbitControls target. No tween objects are allocated and the
component does not re-render while it runs. Controls are disabled for the
duration so the user cannot fight the transition, and handed back when it lands.

Verified: moving from L3 to L1 drops the camera exactly 9.2m — two floor heights
— and `all` pulls the zoom from 30.6 back to 20.

### 4. No React re-render ever touches a coordinate

`store/useMegnetoStore.ts` is split in two halves that never mix:

- **`world`** — a plain, stable, mutable object graph covering both sites.
  Operator positions (`Float32Array`), machine temperatures, absolute humidity,
  VOC concentration, acoustic ring buffers, pillar aggregates. Not in the
  zustand state tree; nothing subscribes to it.
- **The reactive slice** — only discrete facts: phase, active site, active
  floor, selection, hover, alert revision.

The mob is **3,000 people on the HUD and 21 capsules on the GPU.** Headcount per
sector is simulated as an aggregate; the floor renders a representative sample
from one `InstancedMesh`, and each operator is drawn from a sector that actually
lives on their floor, so a tooltip never claims a stitcher is standing in the
dye house.

---

## The HUD got quieter

V2 showed everything at once — the right instinct for an operator on shift, the
wrong one entirely for a pitch. The default state is now almost empty: one
output counter, one line of alert chips, and the floor selector. Everything else
is one click away and stays where you put it.

Collapsing a panel does not stop its data updating — it stops its data
**existing in the DOM**, which is strictly cheaper. Every live number is still
written from one 12Hz `requestAnimationFrame` loop setting `textContent`.

On the globe, a glass panel aggregates both nodes: total grid draw, units in
transit, mean transit time across every live lane, workforce on shift, a weather
impact verdict, and open alerts.

---

## The environment is modelled, not faked

Every relation below is integrated forward at 1Hz.

**Outdoor weather** — diurnal cosine for temperature, inverse cosine for
humidity, and an **Ornstein-Uhlenbeck** cloud index, `dX = θ(μ − X)dt +
σ√dt·N(0,1)`, which mean-reverts so weather drifts and recovers instead of
wandering off. Rain switches on above a cloud threshold and pulls temperature
toward wet-bulb.

**Indoor humidity (Tiruppur)** — a well-mixed moisture balance integrated in
**absolute** humidity, because %RH is not conserved under temperature change:

```
dAH/dt = (S_total − S_dehumid)/V − (ACH/3600)·(AH_in − AH_out)
```

converted to %RH through the Magnus saturation-pressure relation. Sources are
open-vessel evaporation (scaled by the vapour-pressure difference between liquor
surface and room air) plus stenter drying at ~0.55 kg water per kg of fabric.
`V` is now all three storeys of air.

**Dye vat thermal** — lumped capacitance, `m·c·dT/dt = η·P_steam − UA·ΔT`, with
a proportional steam controller on a 4 °C band.

**ZLD train** — honest flow and salt mass balance. With 98.5% rejection every
gram of salt that does not leave in the permeate leaves in the concentrate, so
reject TDS rises exactly as recovery does. Recovery is capped by feed TDS —
osmotic pressure works against you.

**VOC and paper dust (Rajajinagar)** — well-mixed box models, `dC/dt = S/V −
k·C`, where `k` combines ventilation, scrubber duty × bed efficiency and, for
dust, gravitational settling.

**Grid demand** — machine load plus HVAC following outdoor temperature, with
power factor sagging as inductive share rises, and running peak-kVA against the
sanctioned contract.

**And it feeds back.** Out-of-band humidity derates the spinning lines; heat
stress and solvent raise operator strain, which lowers output and raises break
frequency, which lowers on-shift headcount. An environmental excursion becomes a
labour problem and then a throughput problem.

---

## Alerts you have to act on

Two kinds of event do **not** self-clear:

- **A machine jam.** The moving part stops dead, a magenta hazard volume lights
  up, and the tag reads `JAMMED`. Clicking dispatches the floor: the machine
  restarts cold, its queue backfills by the cycles it missed, and the downtime
  is charged against its uptime.
- **An environmental excursion.** The node raises a red aura and the fog in the
  building changes colour and closes in. **APPLY CORRECTION** steps a real
  control input — re-centres the humidity setpoint and commands the
  dehumidifier, or puts the carbon bed on full duty and the hall onto emergency
  purge, or sheds the laminator. The physics then converges at its own rate,
  with a 150s window in which the same alarm will not re-fire. A forced 100 %RH
  excursion recovers 100 → 93 → 82 → 71 → 63 and settles on the 62.5 setpoint
  with a small undershoot: a first-order control response, not a flag flip.

The floor pills carry a dot when a level has an open alert, so you can see which
storey needs you without opening anything.

---

## Layout

```
app/
  page.tsx                  phase machine + VRAM mount gates
  layout.tsx                sets window.CESIUM_BASE_URL before the Cesium chunk
  api/house-model/route.ts  server-side existence check for the facility model
components/
  MacroGlobe.tsx            Cesium: two pins, weather discs, convoys, flights
  MicroFacility.tsx         canvas, renderer budget, AtmosphereDriver, lights
  FloorStack.tsx            three storeys + the isolation transition
  CameraController.tsx      every camera movement, as three lerps
  IndustrialEntities.tsx    instanced mob, machines, apparatus, hazard auras
  FacilityOverlay.tsx       projected DOM: tags, X-ray panels, node panels
  CleanHUD.tsx              progressive-disclosure HUD + floor selector
  UrlStateSync.tsx          URL ⇄ state, read once, write on change
  TransitionVeil.tsx        the dive
store/useMegnetoStore.ts    mutable world + physics engine + reactive slice
lib/sites.ts                both blueprints, three floors each
lib/theme.ts                one palette shared by the HUD and both 3D layers
```

---

## Four defects worth knowing about

All found by running the thing. The workarounds are load-bearing.

**1. Cesium's splat decoder breaks the production bundle.** Cesium 1.14x depends
on `@spz-loader/core`, which inlines a WASM blob as a JavaScript string. Next's
SWC minifier re-emits it as a *template* literal, and the blob starts with
`\0asm` — an octal escape, a hard `SyntaxError` inside a template literal. The
chunk fails to parse and the app dies on load. **The dev server, which does not
minify, is perfectly happy.** `next.config.mjs` aliases the package to
`lib/stubs/spz-loader.mjs`.

**2. drei's `<Html>` throws on teardown under React 19.** It mounts a separate
React DOM root per overlay and unmounts it inside a layout effect, which lands
mid-commit and throws `NotFoundError: removeChild` on every dive. All overlays
live in `FacilityOverlay.tsx` instead, projected to screen space from a single
`useFrame`. `@react-three/drei` is not a dependency.

**3. R3F hooks throw outside the Canvas.** The overlay is a DOM *sibling* of the
canvas, so its tag components cannot use `useFrame` — they use `requestAnimation
Frame` directly. Only `<Projector/>`, which lives inside the Canvas, uses
`useFrame`.

**4. Reading `window.location` during render is a hydration mismatch.** The
share button builds its href in an effect, not in render, or the server emits
one `title` and the client another and React refuses to patch it up.

---

## Performance notes

- **No shadow maps anywhere.** Grounding comes from one ambient-occlusion
  texture per storey, painted into a canvas at startup.
- A fully faded level stops drawing entirely — three storeys of invisible
  transparent geometry is still three storeys of overdraw.
- **No environment HDR**, no post-processing, no webfont fetch. Nothing the demo
  needs is downloaded from a CDN at runtime.
- `reactStrictMode` is **off**: a double-mounted WebGL context on a 4GB card is
  a lost context.
- Both heavy layers are dynamically imported. First load is ~132 kB of JS.
- Both sites simulate continuously; only the active site's operator positions
  are integrated per frame.

### Rehearsal console

In development:

```js
__megneto.store.getState().setActiveFloor(1)            // isolate a level
__megneto.world.sites.tiruppur.physics.ah *= 1.7        // force a humidity alert
__megneto.world.sites.rajajinagar.physics.vocMgM3 = 260 // force a VOC alert
__megneto.world.sites.tiruppur.machines[0].jammed = true
__megneto.resolveEnvNode('tiruppur', 'ENV-RH')          // what the click does
__megnetoR3F.camera.position                            // the micro camera
__megnetoViewer.camera.positionCartographic             // the globe camera
```
