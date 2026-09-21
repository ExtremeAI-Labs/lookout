// One recorder per server process, started from src/instrumentation.ts and looked up by the
// /api/tracks routes. Configuration is env only; without LOOKOUT_RECEIVER_URL nothing runs and
// the status route says so in words.
import { TrackStore, TRACKS_DIR } from './store';
import { createTrackRecorder, DEFAULTS, redactUrl, type TrackRecorder } from './recorder';

type Holder = { recorder: TrackRecorder | null; store: TrackStore; reason: string | null; started: boolean };
const KEY = '__lookoutTracks' as const;
const g = globalThis as unknown as Record<typeof KEY, Holder | undefined>;

const numEnv = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export function tracksHolder(): Holder {
  if (!g[KEY]) g[KEY] = { recorder: null, store: new TrackStore(TRACKS_DIR), reason: null, started: false };
  return g[KEY]!;
}

/** Idempotent: safe to call from instrumentation and from any route. */
export async function startRecorderFromEnv(): Promise<Holder> {
  const h = tracksHolder();
  if (h.started) return h;
  h.started = true;
  const url = (process.env.LOOKOUT_RECEIVER_URL || '').trim();
  if (!url) { h.reason = 'LOOKOUT_RECEIVER_URL is not set — point it at your own receiver\'s aircraft.json (readsb / dump1090 / tar1090) to record.'; return h; }
  let parsed: URL;
  try { parsed = new URL(url); if (!/^https?:$/.test(parsed.protocol)) throw new Error('not http(s)'); } catch { h.reason = `LOOKOUT_RECEIVER_URL is not an http(s) URL (${redactUrl(url)})`; return h; }

  let origin: { lat: number; lng: number } | null = null;
  const lat = Number(process.env.LOOKOUT_RECEIVER_LAT), lng = Number(process.env.LOOKOUT_RECEIVER_LON);
  if (Number.isFinite(lat) && Number.isFinite(lng)) origin = { lat, lng };
  else {
    // readsb publishes the receiver position (optional) beside aircraft.json.
    try {
      const rUrl = new URL(parsed.toString().replace(/aircraft\.json(\?.*)?$/, 'receiver.json'));
      const r = await fetch(rUrl, { signal: AbortSignal.timeout(5_000) });
      const j = (await r.json()) as { lat?: unknown; lon?: unknown };
      if (typeof j.lat === 'number' && typeof j.lon === 'number') origin = { lat: j.lat, lng: j.lon };
    } catch { /* fine — no radius filter without an origin */ }
  }
  const radiusKm = process.env.LOOKOUT_RECORD_RADIUS_KM === '0' ? null : numEnv('LOOKOUT_RECORD_RADIUS_KM', DEFAULTS.radiusKm);
  h.recorder = createTrackRecorder({
    url, origin, radiusKm: origin ? radiusKm : null,
    intervalMs: numEnv('LOOKOUT_RECORD_INTERVAL_S', DEFAULTS.intervalMs / 1000) * 1000,
    minGapMs: DEFAULTS.minGapMs, heartbeatMs: DEFAULTS.heartbeatMs, minMoveM: DEFAULTS.minMoveM,
    retentionDays: numEnv('LOOKOUT_TRACKS_RETENTION_DAYS', DEFAULTS.retentionDays),
  }, { store: h.store });
  h.recorder.start();
  return h;
}
