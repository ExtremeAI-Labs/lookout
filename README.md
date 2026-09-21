# Lookout

A self-hosted 3D situational-awareness console you run on your own machine: a CesiumJS globe with
live aircraft, ships and ports, satellites, earthquakes and public cameras; an assistant that
operates it and is told, in code, what it may never send to a model; cases with hash-sealed
findings; and a recorder that keeps your **own** receiver's history in a chain you can verify.

It is the 3D theater of a larger private project (Lookout), published as source for you to read,
clone and run yourself — on your machine, with your own keys. There is nothing to install beyond
`npm i`, no package, no account, no service of ours in the loop. The private console it came
from is not in this tree — see [What is here, what is not](#what-is-here-what-is-not).

## What it does

| | |
|---|---|
| **Live globe** | aircraft (OpenSky · adsb.fi), military traffic, ships & ports (AIS with your free aisstream key; the major ports and chokepoints without one), satellites (CelesTrak TLEs propagated locally), earthquakes (USGS), ~54,000 public cameras (DOT feeds, Windy, owner-published) staged in the scene when you fly low |
| **Follow · cockpit · contacts** | click anything; ride along; step through everything within 250 km; the followed airframe wears a real 3D model |
| **TRACE 24 H** | an aircraft's flown path from adsb.lol's readsb traces, drawn at true altitude and coloured by height, with a replay scrubber; gaps are coverage gaps and the panel says so |
| **Sensor looks** | seven GLSL post-process looks (normal, CRT, NVG, FLIR, noir, snow, anime) after God's Eye View's shaders |
| **Scenes** | scripted camera tours you can capture, reorder, play, and file into a case |
| **Annotations** | pins, labels, outlines with area, measured lines — drawn by clicking or by the assistant — filed into a case as *asserted by the operator, not observed* |
| **Watchlist** | named airframes (the US executive fleet, the C-40 CODEL fleet, your own tail numbers) resolved against a local copy of the public registry; "not heard" is never reported as "on the ground" |
| **Recorder + HISTORY** | records **your own** ADS-B receiver (readsb / dump1090 / tar1090) into NDJSON with an hourly SHA-256 chain; scrub any window; verify the chain; export a track into a case. It never records a third-party feed — their terms forbid it. |
| **Cases + reconstruction** | findings are hash-sealed; the reconstruction page shows two clocks (when it happened, when you learned it) and a basis on every item |
| **Scout** | an assistant (Assistant Standard v2.2) with tools for all of the above. Sensitivity tiers stub person- and case-level data before any cloud model sees it; writes ask first. Bring your own OpenAI-compatible endpoint and key. |
| **Two skins** | Lookout's own gold identity (default) and the God's Eye shell as a named preset; **R** draws a 16:9 recording frame and blurs your private entries |

Keyboard: **L** layers · **S** scenes · **H** history · **W** watchlist · **A** annotate · **K** contacts · **F** follow · **C** cockpit · **T** trace · **R** rec frame · **1–7** looks · arrows look, ⇧arrows move, +/− zoom · **Esc**.

## Run it

Node 20+.

```bash
npm i
npm run build      # its prebuild step stages CesiumJS's prebuilt bundle into public/vendor/cesium/
npm start          # http://127.0.0.1:3000 → the theater
```

That is the whole install: keyless Esri imagery, live public feeds, the assistant off until you
give it a key. Everything it writes goes under `~/.lookout` (`LOOKOUT_DATA_DIR` to move it).

The server binds to loopback and refuses other hosts by design. To reach it from your phone on
the same network set `LOOKOUT_ALLOW_LAN=1`; to publish it, put it behind Cloudflare Access and
set the `LOOKOUT_PUBLIC_HOST` / `LOOKOUT_CF_*` variables (see `.env.example`) — the token is
verified on every request, not trusted for being present.

## Keys — all optional, each unlocks one thing

| Variable | Unlocks | Where |
|---|---|---|
| `CESIUM_ION_TOKEN` | Google Photorealistic 3D cities through Cesium ion (free tier, personal use) | [ion.cesium.com](https://ion.cesium.com) |
| `GOOGLE_MAP_TILES_KEY` | the same tiles straight from Google (metered; restrict the key to the Map Tiles API and your origin, set a quota) | Google Cloud console |
| `AIS_API_KEY` | live vessels on the Ships & ports layer | [aisstream.io](https://aisstream.io) (free) |
| `LOOKOUT_GATEWAY_URL` + `LOOKOUT_GATEWAY_KEY` + `LOOKOUT_ASSISTANT_MODEL` | Scout, against any OpenAI-compatible chat endpoint (OpenAI, OpenRouter, LiteLLM, Ollama, a local gateway) | yours |
| `OPENAI_API_KEY` | Scout's voice (Realtime); text works without it | OpenAI |
| `LOOKOUT_RECEIVER_URL` | the recorder, pointed at your own receiver's `aircraft.json` | your RTL-SDR |
| `LOOKOUT_NTFY_URL` | a push when a watched airframe appears | ntfy |

Without a photoreal key the globe is Esri World Imagery on a smooth ellipsoid, and the indicator
says `SAT`. With one it says `PHOTOREAL`. Google's terms for those tiles: display only — the kit
never sends them to a model, runs detection on them, or caches them.

## What is here, what is not

**Here:** the theater and everything it needs — the layers, Scout, cases, scenes, the recorder,
the watchlist and registry, the public-camera catalogue and snapshot proxy, the reconstruction page.

**Not here, on purpose:** the private console this came from (a 2D OSINT map, person and
username lookups, a port scanner, a tracking-link generator, client-owned camera credentials) and
the owner's on-device YOLO tracker. The theater's `DETECT` button appears only when a tracker
answers at `LOOKOUT_TRACKER_URL`, so in this kit it does not appear at all. Nothing in this tree
falls back to a cloud vision or search service you did not configure.

## Demo mode

Not something you need. `LOOKOUT_DEMO=1 NEXT_PUBLIC_LOOKOUT_DEMO=1 npm run build` produces a
read-only showcase build: the
aircraft, satellite and earthquake layers read the synthetic samples under `public/sample-data/`,
the HISTORY panel scrubs the sealed sample recording under `data/tracks/`, every non-GET request
and every route that writes, calls a live feed or needs a key returns 404, and the assistant is
off. `NEXT_PUBLIC_CESIUM_CDN=1` additionally loads the pinned Cesium build from Cesium's CDN so the
host serves none of it. See [`DEMO_MODE.md`](./DEMO_MODE.md).

## Data sources and their terms

OpenSky Network and adsb.fi are non-commercial community feeds; use them on a personal instance.
adsb.lol traces and adsbdb identities carry their own attribution. CelesTrak, USGS and the DOT
camera feeds are public data. aisstream.io is free for personal use. The theater's attribution
line is part of the UI; keep it visible.

## Credits and lineage

- **God's Eye View** by Bilawal Sidhu (MIT) — the theater's visual language and its six sensor
  shaders are ported from it, its aircraft classifier is ported to TypeScript, and the 3D aircraft
  and ship models are the set it curated. Its READMEs taught this project a great deal.
- **OSIRIS** by simplifaisoul (MIT) — the private console Lookout forked from; none of its UI is in
  this tree.
- **3D models** — CC BY 4.0 works by their Sketchfab creators, as optimised by God's Eye View; the
  full table is in [`public/models/ATTRIBUTION.md`](./public/models/ATTRIBUTION.md) and must travel
  with the models. They are **not** under this repository's MIT licence.
- **Fonts** — JetBrains Mono and Inter (SIL OFL), self-hosted.
- **Aircraft registry** — tar1090-db (Mictronics), downloaded on first start.

Full notices: [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md). Licence for the code:
[MIT](./LICENSE).

## Development

```bash
npm run dev        # next dev (stages Cesium first)
npm test           # vitest — the geometry, motion, recorder chain, registry, classifier, guard
npm run lint
```

The theater's engineering contract (two engines, one set of `/api` routes, the sensitivity-tier
rule for the assistant, the recorder's chain format) is documented in the private project's
`docs/PARITY_ARCHITECTURE.md`; the parts that matter to the kit are repeated in code comments.
