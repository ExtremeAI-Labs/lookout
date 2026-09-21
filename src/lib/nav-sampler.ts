// A slow, polite sampler of aircraft navigation accuracy (NACp) from adsb.fi.
//
// Why it exists: OpenSky gives the map its worldwide picture but carries no NACp,
// so with OpenSky healthy the GPS-degradation layer had only adsb.fi's /mil feed to
// work from (148 of 6,782 aircraft on 2026-09-17). This fills that gap WITHOUT making
// adsb.fi the primary feed.
//
// Why it is slow: adsb.fi is a volunteer-run feed whose terms are personal, non-commercial
// use at no more than one request per second, and Lookout already has a primary source.
// A sampler has no business sweeping it eagerly. It therefore
//   • visits a few regions per burst, ≥1.1 s apart, at most one burst per MIN_INTERVAL;
//   • backs off when several regions in a row come back empty — whatever the cause
//     (an outage, a block, a format change), hammering an endpoint that is answering
//     with nothing helps nobody;
//   • keeps a ROLLING WINDOW of observations (one per aircraft, newest wins), which is
//     also closer to how GPSJAM works (24 h of reports) than a single snapshot is.
// It only advances when /api/flights is actually being requested — no viewer, no traffic.

import type { NavSample } from './nav-degradation';

export type NavObservation = NavSample & { hex: string; ts: number };
export type SamplerRegion = { lat: number; lon: number };

export const NAV_WINDOW_MS = 45 * 60 * 1000;
export const NAV_BURST_REGIONS = 5;
export const NAV_BURST_GAP_MS = 1100;
export const NAV_MIN_INTERVAL_MS = 5 * 60 * 1000;
export const NAV_THROTTLE_BACKOFF_MS = 20 * 60 * 1000;
/** this many empty regions in a row = something is wrong upstream, not quiet airspace */
export const NAV_EMPTY_RUN_LIMIT = 3;

export class NavStore {
  private byHex = new Map<string, NavObservation>();

  /** Raw adsb.fi-shaped aircraft in; airborne ones that report NACp are kept. */
  ingest(aircraft: unknown[], now: number): number {
    let kept = 0;
    for (const a of aircraft as Record<string, unknown>[]) {
      const hex = String(a?.hex || '').toLowerCase().trim();
      if (!hex || a.alt_baro === 'ground') continue;
      const lat = a.lat, lng = a.lon, nac_p = a.nac_p;
      if (typeof lat !== 'number' || typeof lng !== 'number' || typeof nac_p !== 'number') continue;
      this.byHex.set(hex, { hex, lat, lng, nac_p, ts: now });
      kept++;
    }
    return kept;
  }

  /** One sample per aircraft seen inside the window; expired entries are dropped. */
  samples(now: number, windowMs = NAV_WINDOW_MS): NavSample[] {
    const out: NavSample[] = [];
    for (const [hex, o] of this.byHex) {
      if (now - o.ts > windowMs) this.byHex.delete(hex);
      else out.push({ lat: o.lat, lng: o.lng, nac_p: o.nac_p });
    }
    return out;
  }

  nacpFor(hex: string, now: number, maxAgeMs = 10 * 60 * 1000): number | undefined {
    const o = this.byHex.get(hex.toLowerCase());
    return o && now - o.ts <= maxAgeMs ? o.nac_p : undefined;
  }

  get size() {
    return this.byHex.size;
  }
}

export type SamplerState = { cursor: number; lastBurstAt: number; backoffUntil: number; running: boolean; bursts: number; throttled: number };

export function createNavSampler(opts: {
  regions: SamplerRegion[];
  fetchRegion: (lat: number, lon: number) => Promise<unknown[]>;
  store: NavStore;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}) {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const state: SamplerState = { cursor: 0, lastBurstAt: 0, backoffUntil: 0, running: false, bursts: 0, throttled: 0 };

  /** Fire-and-forget from a request handler: returns at once unless a burst is due. */
  async function maybeRun(): Promise<'skipped' | 'ran' | 'throttled'> {
    const t = now();
    if (state.running || t < state.backoffUntil || t - state.lastBurstAt < NAV_MIN_INTERVAL_MS || !opts.regions.length) return 'skipped';
    state.running = true;
    state.lastBurstAt = t;
    let emptyRun = 0;
    try {
      for (let i = 0; i < NAV_BURST_REGIONS; i++) {
        const r = opts.regions[state.cursor % opts.regions.length];
        state.cursor++;
        let aircraft: unknown[] = [];
        try {
          aircraft = await opts.fetchRegion(r.lat, r.lon);
        } catch (e) {
          console.warn('[nav-sampler] region fetch failed:', e instanceof Error ? e.message : e);
        }
        if (aircraft.length === 0) {
          if (++emptyRun >= NAV_EMPTY_RUN_LIMIT) {
            state.backoffUntil = now() + NAV_THROTTLE_BACKOFF_MS;
            state.throttled++;
            console.warn(`[nav-sampler] ${emptyRun} empty regions in a row — adsb.fi is answering with nothing; backing off ${NAV_THROTTLE_BACKOFF_MS / 60000} min`);
            return 'throttled';
          }
        } else {
          emptyRun = 0;
          opts.store.ingest(aircraft, now());
        }
        if (i < NAV_BURST_REGIONS - 1) await sleep(NAV_BURST_GAP_MS);
      }
      state.bursts++;
      return 'ran';
    } finally {
      state.running = false;
    }
  }

  return { maybeRun, state };
}
