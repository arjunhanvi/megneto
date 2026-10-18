# Deploying Megneto to Netlify

End-to-end: local repo → public GitHub repo → Netlify site with CI/CD.

Everything here is infrastructure. No application code changes.

---

## 0. Before you start — one correction

`gh` is **not installed on this machine**. I checked both Git Bash and
PowerShell and it is not on either PATH. So either install it:

```bash
winget install --id GitHub.cli
```

then restart your terminal and run `gh auth login`, **or** skip the CLI and use
the browser path in step 1b.

---

## 1. Push to GitHub

The repo is already initialised and committed locally on branch `main`:

- 30 files, ~700 KB
- `.env.local` is gitignored and **verified not staged** — your ion token is not
  in the commit
- `public/cesium` (23 MB) and `public/draco` (1.7 MB) are gitignored; Netlify
  regenerates them at build time from `postinstall`

### 1a. With the GitHub CLI

```bash
cd "C:/Megneto 2.0"
gh repo create megneto --public --source=. --remote=origin --push
```

That creates the repo, wires `origin`, and pushes `main` in one step.

### 1b. Without the CLI

Create an empty **public** repo named `megneto` at
<https://github.com/new> — no README, no .gitignore, no licence — then:

```bash
cd "C:/Megneto 2.0"
git remote add origin https://github.com/<your-username>/megneto.git
git push -u origin main
```

### Verify

```bash
git remote -v
git log --oneline -1
```

---

## 2. `netlify.toml`

Already written at the repo root. The parts that matter:

```toml
[build]
  command = "npm run build"
  publish = ".next"

[build.environment]
  NODE_VERSION = "22"
  NODE_OPTIONS = "--max-old-space-size=4096"
  NEXT_TELEMETRY_DISABLED = "1"

[[plugins]]
  package = "@netlify/plugin-nextjs"
```

**Why the heap flag.** Cesium's prebuilt ESM bundle is ~8 MB of JavaScript in a
single module, and webpack holds the whole module graph in memory while SWC
minifies it. The default heap is enough until it isn't, and the failure mode is
an opaque `JavaScript heap out of memory` partway through the build. 4 GB has
headroom on Netlify's standard builder without being greedy.

**Why `publish = ".next"`.** The Netlify Next.js Runtime v5 takes `.next` and
splits it into static assets plus the server handler itself. Do not point this
at `out/` — that is for `next export`, and this app has a dynamic API route.

**The one thing that will silently break the globe.** `public/cesium` is not in
the repo. It is mirrored out of `node_modules` by `scripts/copy-static-assets.mjs`
running as an npm `postinstall` hook. Netlify's default install (`npm ci`) runs
postinstall, so this works — but if you ever set `NPM_FLAGS` to include
`--ignore-scripts`, the hook stops running, `window.CESIUM_BASE_URL` resolves to
nothing, and the globe dies with 404s on its Workers. Don't set that flag.

Caching headers for `/cesium/*` and `/draco/*` are set to one day with
revalidation rather than `immutable`, because those files are copied verbatim
out of `node_modules` and are **not** content-hashed — a package upgrade changes
a file's contents without changing its name. A browser holding a stale Cesium
Worker against a freshly upgraded engine is a genuinely horrible bug to find.

---

## 3. The Cesium ion token

`NEXT_PUBLIC_*` variables are **inlined into the JavaScript bundle at build
time**, not read at runtime. Two consequences:

1. The variable must exist **before** the build that uses it.
2. Adding it later does nothing until you **redeploy**.

### Where to put it

1. Netlify dashboard → your site → **Site configuration**
2. Left sidebar → **Environment variables**
3. **Add a variable** → **Add a single variable**
4. Key: `NEXT_PUBLIC_CESIUM_ION_TOKEN`
5. Value: paste the token — raw, no quotes, no spaces, all one line
6. **Scopes**: leave **Builds** selected. That is the one that matters; the
   token is baked in during the build, so a runtime-only scope would do nothing.
7. **Create variable**

### Then force a rebuild

**Deploys** → **Trigger deploy** → **Clear cache and deploy site**.

Clear cache matters: a cached build can reuse the previous compilation and keep
the old (empty) inlined value.

### Confirm it took

Open the live site. If the token is working:

- the amber **"NO CESIUM ION TOKEN"** card in the HUD is **gone**
- the globe shows aerial imagery rather than the washed OSM map
- diving shows terrain relief and 3D buildings

If the card is still there, the variable did not reach the build. If the globe
goes blank instead, the token is valid but lacks asset access — it needs scope
`assets:read` plus access to Cesium World Terrain (asset 1) and Cesium OSM
Buildings (asset 96188).

### Security note

The `NEXT_PUBLIC_` prefix means this token **ships to the browser** and is
visible to anyone who opens devtools. That is unavoidable for client-side
Cesium. Keep it scoped to read-only asset access, and never reuse a token that
has write or billing scopes. Free tier is 50k requests / 5 GB a month.

---

## 4. Linking GitHub for CI/CD

From the Netlify dashboard:

1. **Add new site** → **Import an existing project**
2. **Deploy with GitHub** → authorise Netlify if prompted, then pick the
   `megneto` repository
3. Netlify reads `netlify.toml` and pre-fills the build command, publish
   directory and Node version — leave them alone — then **Deploy**

(Realistically that is three clicks *plus* a GitHub authorisation step the first
time you ever connect an account. If you have connected Netlify to GitHub
before, it genuinely is three.)

Once linked, **every push to `main` triggers a rebuild of the live URL**.
Pull requests get their own Deploy Preview URL, which is a good way to show a
V4 to someone without touching the pitch link.

Rename the site to control the URL: **Site configuration** → **Site details** →
**Change site name** → `megneto` gives you `https://megneto.netlify.app`.

---

## 5. Known production caveats

**First build is slow.** ~3–5 minutes: a cold `npm ci` pulls Cesium and three,
then `postinstall` copies 25 MB of assets, then Next compiles it. Later builds
are faster.

**Bandwidth.** The free tier is 100 GB/month. Cesium fetches its Workers and
assets lazily, so a globe session pulls single-digit MB rather than the full
23 MB — but it is not a small site. Fine for a pitch; keep an eye on it if the
link gets passed around widely.

**The model-probe API route.** `app/api/house-model/route.ts` checks the
filesystem for `public/models/factory.glb` and becomes a serverless function on
Netlify. Function bundles do not necessarily include `public/`, so in production
it may report `present: false` even if you later commit a model. The app handles
that correctly — it falls back to the procedural stack, which is what renders
today anyway — but if you do add `factory.glb`, tell me and I will swap that
route for a build-time check so the GLTF envelope actually loads in production.

**Commercial use.** You moved off Vercel Hobby for its commercial restriction.
Check Netlify's current plan terms yourself before the pitch rather than taking
my word for it — plan terms change and I would rather you verify than assume.

---

## Quick reference

```bash
# push an update; Netlify rebuilds automatically
git add -A
git commit -m "V4: ..."
git push

# check what would ship
git status --short
du -sh --exclude=node_modules --exclude=.next .
```
