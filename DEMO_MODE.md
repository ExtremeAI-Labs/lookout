# Demo mode — and how this tree became the kit

**2026-09-21.** This repository started (18 Sep) as a curated, theater-only subset of a larger
private project, with everything else amputated. On 21 Sep it became the public **kit**: the
theater with all of its own subsystems — annotations, ships & ports, TRACE 24 H, staged cameras,
3D aircraft, the watchlist and registry, cases and reconstruction, the recorder, Scout — synced
from the private tree by manifest (`src/lib/data-dir.ts`, `src/lib/access-guard.ts`,
`src/middleware.ts`, `src/instrumentation.ts`, `src/app/page.tsx`, `src/app/layout.tsx` and
`src/app/globals.css` are kit-owned and never overwritten). What is still not here, and will not
be: the private 2D console, person/username lookups, the port scanner, the tracking-link
generator, client-owned camera credentials, and the owner's on-device YOLO tracker.

**Demo mode is now a switch, not a different tree.** `LOOKOUT_DEMO=1` at run time and
`NEXT_PUBLIC_LOOKOUT_DEMO=1` at build time give the hosted showcase. As of 2026-09-23 that switch
is **per layer**, not a blanket one:

- **Live** — earthquakes (USGS), satellites (CelesTrak TLEs, propagated server-side) and the
  camera catalogue (public DOT/traffic feeds, Windy, owner-published cameras, including YouTube
  live streams) call their real routes even in the hosted showcase. These three have no
  non-commercial clause in their terms — but they are not free of per-viewer cost either, and an
  earlier draft of this file overstated that ("no meaningful per-viewer cost... never a metered
  call"). Measured 2026-09-23: the unscoped `/api/cctv?region=all` catalogue is 17.5 MB raw /
  ~2.0 MB gzip and `/api/satellites` is 2.7 MB raw / ~375 KB gzip, and the theater's client fetch
  for every layer (`useTheaterFeeds.ts`) uses `cache: 'no-store'`, so each layer toggle is a fresh
  network round trip for every viewer, every time — the CDN `s-maxage` below keeps that off the
  origin function, but it is still a real edge-request/egress hit per toggle, not amortized to one
  hit globally. The camera catalogue has an existing lever the other two don't: `/api/cctv` already
  accepts `?lat=&lng=&radius=` and narrows to the named region(s) around that point
  (`getRegionsForBounds` in `src/app/api/cctv/route.ts`), backed by the same per-region 30-minute
  cache (`src/lib/sourceCache.ts`) the worldwide path uses. As of 2026-09-23 the showcase's client
  (`loadCameraCatalog` in `src/lib/camera-catalog.ts`, driven from `useTheaterFeeds.ts`) passes the
  current view centre on its first request whenever `NEXT_PUBLIC_LOOKOUT_DEMO=1`, instead of
  `region=all` — a viewer's first Cameras toggle now costs one region (low hundreds of KB to a
  couple MB, not 17.5 MB). Panning far away and re-toggling repeats the same bounded request at the
  new centre; there is no background re-fetch as the view moves (matches the existing `refreshMs: 0`
  "load once per toggle" design). Satellites has no equivalent viewport lever — CelesTrak TLEs are
  global and propagated for the whole catalogue in one pass — so its payload stays what it is, real
  bytes on every toggle, bounded only by the CDN's 2-hour cache below. **Action item, not done from
  this tree:** set a bandwidth budget/alert on the Vercel project this repo deploys to, so a traffic
  spike on satellites (or any live layer) pages someone before it becomes a bill; that's a Vercel
  dashboard setting, outside what a worktree commit can do. `WINDY_WEBCAMS_KEY` is optional even
  here: without it the Windy layer of the catalogue is simply empty, silently.
- **Still sample** — aircraft and military read `public/sample-data/*.json`. adsb.fi/OpenSky are
  non-commercial, 1-request-per-second community feeds; a public multi-viewer site can't honor
  that limit without its own polling+fan-out layer and, if the channel ever monetizes, a paid feed
  (ADS-B Exchange or an owned receiver) — so aircraft stay replay until that's built. Ships/AIS
  (`/api/maritime`), TRACE, the watchlist, Scout, cases and every route that writes or needs a key
  stay refused with 404, same as before.

The HISTORY panel scrubs the sealed sample recording under `data/tracks/` (the data root becomes
`./data`) regardless; every non-GET request and every route that writes or needs a key is refused
with 404 by the guard's denylist (`src/lib/access-guard.ts`, `DEMO_BLOCKED_PREFIXES` — earthquakes,
satellites and cctv were removed from that list, nothing else changed); the recorder and the
registry download never start; Scout is off. `NEXT_PUBLIC_CESIUM_CDN=1` loads the pinned Cesium
build from Cesium's CDN. A self-hosted install sets none of these and gets every feed live with its
own keys.

**Feed etiquette, because this runs on serverless.** The live showcase routes set `Cache-Control`
so a hosting CDN answers repeat viewers without a fresh call upstream: earthquakes `s-maxage=60`,
the camera catalogue `s-maxage=600`, satellites `s-maxage=7200` — CelesTrak blocks IPs that re-fetch
the same GP file more than once every 2 hours, so the satellites route also throttles its own
in-memory refresh to that interval (not just the CDN header) and keeps its on-disk TLE cache under
the OS temp dir rather than the read-only deploy directory a serverless function ships from. None
of the three run a background timer that assumes a long-lived process — every refresh happens
inside a request.

The sections below are the original 18 Sep record of what was removed and why; they remain true
for the parts that are still absent, and are kept for the audit trail.

---

## Amputated entirely (not copied)

- [x] `src/app/console` — the 2D OSINT/intelligence console (the original root route).
- [x] `src/app/fisherman`, `src/app/api/fisherman/*` — tracking-link generator.
- [x] `services/console`, `services/cctv-tracker`, `services/fisherman`, `services/watch` — all
      backing services for the above.
- [x] `src/app/api/osint/*` — username/breach/crypto/domain/IP/phone OSINT lookups.
- [x] `/api/scanner` — browser-driven nmap port scanning.
- [x] `/api/person` — person search.
- [x] `/api/client-cameras`, `src/lib/client-cameras.ts`, `src/lib/camera-secrets.ts` — a
      client's own camera credentials and proxying.
- [x] `/api/cases`, `src/lib/cases.ts` — case management (evidence filing). Every place that
      referenced a case (HistoryPanel's per-track "CASE" export, ScenesPanel's "file into case")
      is still present but inert: the fetch fails closed to an honest "not available" state
      rather than being deleted from the UI. See "Rewritten, not ported" below for
      `/api/tracks/export`, whose case dependency was replaced outright.
- [x] `/api/canvass` — the OSM/DeFlock device survey ring around the camera. The theater's
      CANVASS layer toggle is still registered (parity with upstream) but has no backing route,
      so it shows an honest "feed error" if switched on; it defaults off.
- [x] `/api/tracks` **write paths** — only the recorder's read/replay routes shipped
      (`GET /api/tracks`, `GET /api/tracks/status`, `GET /api/tracks/verify`); nothing writes to
      the track store at request time. `/api/tracks/export` was kept but rewritten (below).
- [x] `intel/`, `scratch/`, `runs/`, `engine/` (and all `.pyc`) — operational data, one-off
      scripts, model weights, run artifacts.
- [x] `deploy.sh` — this demo's Phase 1 scope is local build + run only; nothing was deployed.
- [x] `.claude/` — agent config for the private project.
- [x] `yolo11s.pt` — a bundled ML model weight file.
- [x] `public/data/submarine-cables.json`, `public/data/submarine-cables-filtered.json` —
      licensed CC BY-NC-SA (non-commercial); simply not copied, rather than copied and deleted.

## Additionally not carried over (judgment calls, beyond the original list)

- [x] `src/app/reconstruction`, `src/app/docs` — reconstruction views and the API doc browser;
      neither is reachable without the console they were built for.
- [x] `/api/watchlist`, `src/lib/watchlist.ts`, `src/lib/aircraft-db.ts` — the notable-airframe
      watchlist and the public aircraft registry it downloads in the background at server start
      (~8 MB from a public GitHub-hosted dataset, weekly). This demo makes **zero** outbound
      network calls at boot; `src/instrumentation.ts` was rewritten to drop that download
      entirely rather than gate it behind an env var. WatchPanel itself is still in the UI (per
      the brief, "read-only") — with no `/api/watchlist` route to answer it, it shows a clear
      "status unavailable" instead of data. See "Known limitations" below.
- [x] Almost all of `src/app/api/*` (ai, air-quality, aircraft, analyze, arcgis, astra, chain,
      cloudflare-radar, conflicts, country-risk, crypto, cyber-attacks, cyber-threats,
      directions, entity, flight-route, frontlines, gdelt(-events), geo, geosearch,
      github-webhook, health, infrastructure, live-news, malware, maritime, markets, news,
      proxy-tiles, radar, region-dossier, satellites/orbit, scm-suppliers, sdk, sentinel,
      space-weather, stats, weather) — all back the 2D console, which this demo does not ship.
- [x] Cesium-heavy dependencies the theater doesn't use: `framer-motion`, `lucide-react`,
      `satellite.js`, `react-force-graph-2d`, `lightweight-charts`, `hls.js`,
      `google-libphonenumber`, `rss-parser`, `ws`, `sharp`, `@google/generative-ai`,
      `@vercel/analytics`. Confirmed by grepping every import in the copied tree — none of them
      appear. `package.json` here only lists `next`, `react`, `react-dom`, `cesium`.
- [x] The original test suite (`*.test.ts`) and `vitest` — left out to keep this a lean, curated
      demo rather than a maintained fork; a real fork would want these back.
- [x] `postcss.config.mjs` / Tailwind — the theater and Scout dock use their own hand-written
      CSS (`theater.css`, `assistant.css`) and never reference a Tailwind utility class (also
      confirmed by grep); `src/app/globals.css` was rewritten as a ~40-line reset instead of
      carrying over the console's ~2,500-line OSIRIS design system.
- [x] Docker/deploy scaffolding (`Dockerfile`, `docker-compose.yml`, `DOCKER.md`, `nginx/`,
      `.github/`, `SECURITY.md`, `AGENTS.md`, `PRODUCT.md`) — out of scope for a Phase 1 local
      build; would return for a Phase 2 deploy.
- [x] The 2D MapLibre map (`src/components/OsirisMap.tsx` and its console-only supporting
      components) — the brief said "keep it if it works keyless," but it is entangled with the
      console's search bar, directions, layer panel and a dozen of the amputated API routes
      above. Pulling it in would have meant pulling most of the console back in with it.
      **Deferred to Phase 2**, not shipped. `public/vendor/maplibre/` and
      `tools/prepare-map-worker.mjs` were removed to match (they had no consumer left); re-add
      both plus the `maplibre-gl` dependency if Phase 2 takes this on.

## Branding replaced

- [x] `README.md` — rewritten from scratch (was verbatim OSIRIS, with a third party's
      Patreon/Discord links).
- [x] `public/osiris-icon.png`, `casaos-icon.png`, `eye-of-horus.svg`, `og-image.png` — not
      copied.
- [x] **Also not copied**, beyond the brief's list, after actually auditing the icon set:
      `favicon.svg` and `favicon-32.svg` turned out to be Eye-of-Horus glyphs too — the former
      has the literal text "OSIRIS" baked into the SVG — and `icon-192.png` was byte-identical
      (same MD5) to `osiris-icon.png`. `android-chrome-*.png` and `apple-touch-icon.png` were
      not individually inspected pixel-by-pixel but share the same design system, so none of
      the original icon set was carried over. This demo ships one fresh, simple SVG mark
      (`public/favicon.svg`) instead of a full icon set (no PNG rasterization pipeline in this
      minimal build) — see "Known limitations."
- [x] `deploy.sh` — not copied (see above).
- [x] The `https://osirisai.live` UA string / domain reference in `intel/` — moot, `intel/` was
      not copied at all.
- [x] `public/manifest.json` (OSIRIS-branded, referencing `osirisai.live`), `public/sitemap.xml`,
      `public/robots.txt` — rewritten (`site.webmanifest` kept as the one manifest; the
      OSIRIS-branded `manifest.json` was dropped rather than rewritten twice).
- [x] `src/app/layout.tsx` — rewritten: fresh metadata, no OSINT SEO keyword list, no
      console/globe/fisherman nav links (those routes don't exist here).
- [x] `src/components/ErrorBoundary.tsx` — rewritten: it logged `[OSIRIS] ...` to the console
      and its fallback UI depended on Tailwind arbitrary-value classes and OSIRIS's CSS
      variables, neither of which this build ships. Same public API, plain inline styles now.
- [x] Grepped the final tree for `osiris`/`OSIRIS` (case-insensitive): zero hits outside
      `LICENSE`/`THIRD_PARTY_NOTICES.md`/`README.md`/`DEMO_MODE.md`, where the name is the
      correct, required attribution.

## Security — rewritten, not half-edited

- [x] `src/middleware.ts` and `src/lib/access-guard.ts` — both **replaced**, not edited.
      Upstream's guard decides who may reach a private console (loopback, or a
      Cloudflare-Access-verified request to one operator hostname); none of that applies to a
      public demo. The new guard is ~2 rules: every GET/HEAD is allowed; every other method is
      refused everywhere; a short denylist of amputated path prefixes 404s regardless of method,
      as defense-in-depth (those route files were never copied, so they already 404 — the list
      just makes that a contract rather than an accident). See the file headers for the full
      reasoning.
- [x] `src/lib/ssrf-guard.ts` — kept, unmodified, per the brief.
- [x] `/api/tracks/export` — **rewritten**, not ported verbatim. Upstream files a track export
      into a case (`src/lib/cases.ts`, amputated above). This demo's guard also refuses every
      non-GET request, so a POST-with-JSON-body endpoint couldn't work here anyway. Rewritten as
      `GET /api/tracks/export?hex=&from=&to=` — a standalone, read-only, hash-sealed extract of
      one aircraft's recorded fixes, with no case dependency. HistoryPanel's per-track "CASE"
      button is still in the UI (unmodified) but is now inert — its target doesn't exist — see
      "Known limitations."
- [x] `src/lib/tracks/store.ts`, `src/lib/scenes.ts` — one deliberate, narrow change each: the
      default `TRACKS_DIR`/`SCENES_DIR` moved from the private console's data root
      (a path on the machine this was forked from) to a repo-relative `./data/{tracks,scenes}`,
      so the bundled sample recording and seeded scene are found with zero `.env` setup. Both
      stay overridable via `LOOKOUT_TRACKS_DIR` / `LOOKOUT_SCENES_DIR`.
- [x] `src/instrumentation.ts` — rewritten: kept the recorder no-op start, dropped the
      background aircraft-registry download (see watchlist note above).

## Personal-data grep — all clear

The final tree was grepped for the owner's personal domain, GitHub handle, machine hostname,
private-LAN and Tailscale-style CGNAT address prefixes, local service hostnames, a
notification-relay product name, a home-automation product name, the macOS credential-store
name, and any absolute per-user home-directory path — zero matches (this file deliberately does
not spell any of them out again, so it can't itself be the thing that trips a repo-wide search
for them). The private project's own access-guard test file, which referenced the owner's
machine hostname in a fixture, was simply not copied — this demo ships no test suite at all,
see above. One reachable false positive was reviewed, not fixed: the SSRF guard legitimately
enumerates the standard private-IPv4 ranges (RFC1918) it refuses to fetch, one of which reads
the same as a common home-router default range — that's the guard doing its job on a generic
CIDR block, not a leaked address, and the brief says to keep that file unmodified.

## Known limitations / Phase 2 candidates

- **The theater's "Console · Fisherman" overflow menu (top nav, "…") still lists both** — they
  404 cleanly if clicked (handled by the demo guard, not a crash) since neither route is copied
  into this tree. Left as-is rather than edited out of `CesiumTheater.tsx`, consistent with
  leaving that file untouched everywhere else. Its third item, "Working map," is harmless: it
  links to `/` with `lat`/`lon`/`zoom` query params meant for the 2D map, but `/` is the theater
  here, which ignores those params and just reloads itself.
- **Static sample flights/satellites/earthquakes never move.** They're plain JSON files under
  `public/sample-data/`, re-served identically on every poll. Cosmetic consequence: the flights
  layer's motion model only records a fix the first time a position is seen (dedup on an
  unchanged report), so after ~20 minutes in one browser tab the aircraft age out of the motion
  model's window and disappear (reload the page to bring them back). Earthquakes/satellites
  don't have this issue (no aging logic). A Phase 2 fix: replace the static files with a tiny
  local GET route that computes the same arcs from `Date.now()` (like
  `tools/fake-receiver.mjs` does), so positions stay fresh indefinitely — still zero outbound
  calls, just computed instead of static.
- **HistoryPanel's "LAST 15 MIN / 1 H / 6 H" quick buttons use real wall-clock time**, so they
  won't find the sample recording (which is pinned to 2026-09-18T12:00–15:00Z). Type that
  window into the FROM/TO fields instead — see README.md.
- **HistoryPanel's "CASE" button and ScenesPanel's "file into case" are inert** (their target,
  case management, is amputated). Both fail closed to a visible "not available" state, never a
  crash — not rewired to anything else in Phase 1.
- **WatchPanel shows "status unavailable"** by design — no `/api/watchlist` backend ships (see
  above). The panel itself stays in the UI, per the brief's "keep WatchPanel, read-only."
- **The 2D MapLibre map was deferred to Phase 2** entirely (see above) — this demo is the 3D
  theater only.
- **No deployment config in Phase 1** — this was built and verified locally only, per
  instructions. `output: 'standalone'` in `next.config.ts` is carried over from upstream and
  produces a self-hosted deploy artifact on `npm run build`, but nothing here provisions or
  points at a live URL.
