// The recorder — polls the operator's own receiver and keeps the fixes that carry information:
// a moved aircraft, or a heartbeat every minute for one that is holding. Runs for the life of
// the server process (see ./service.ts); every tick leaves a diagnosable status.
import { haversineKm, parseAircraftJson, type Fix } from './receiver';
import type { TrackStore } from './store';

export type RecorderConfig = {
  url: string;
  intervalMs: number;
  /** minimum spacing between two kept fixes of one aircraft */
  minGapMs: number;
  /** keep a fix even without movement after this long */
  heartbeatMs: number;
  /** movement that counts, in metres */
  minMoveM: number;
  radiusKm: number | null;
  origin: { lat: number; lng: number } | null;
  retentionDays: number;
};

export type RecorderStatus = {
  configured: true;
  url: string;
  origin: { lat: number; lng: number } | null;
  radiusKm: number | null;
  intervalMs: number;
  running: boolean;
  ticks: number;
  lastTickAt: number | null;
  lastOkAt: number | null;
  lastError: string | null;
  /** aircraft with a usable position in the last poll */
  aircraftSeen: number;
  /** aircraft in range in the last poll */
  aircraftInRange: number;
  fixesLastTick: number;
  fixesRecorded: number;
  receiverNowMs: number | null;
  /** how far the receiver's clock is from ours at the last poll, ms (positive = receiver ahead) */
  clockSkewMs: number | null;
  prunedDays: string[];
};

export const DEFAULTS = { intervalMs: 5_000, minGapMs: 4_000, heartbeatMs: 60_000, minMoveM: 20, radiusKm: 300, retentionDays: 30 } as const;

export function redactUrl(url: string): string {
  try { const u = new URL(url); u.username = ''; u.password = ''; return u.toString(); } catch { return 'invalid url'; }
}

export function createTrackRecorder(cfg: RecorderConfig, deps: { store: TrackStore; fetchImpl?: typeof fetch; now?: () => number; log?: (msg: string) => void }) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((m: string) => console.info(`[tracks] ${m}`));
  const last = new Map<string, { t: number; lat: number; lng: number; altFt: number | null }>();
  const status: RecorderStatus = {
    configured: true, url: redactUrl(cfg.url), origin: cfg.origin, radiusKm: cfg.radiusKm, intervalMs: cfg.intervalMs, running: false, ticks: 0,
    lastTickAt: null, lastOkAt: null, lastError: null, aircraftSeen: 0, aircraftInRange: 0, fixesLastTick: 0, fixesRecorded: 0, receiverNowMs: null, clockSkewMs: null, prunedDays: [],
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = false;
  let lastPruneAt = 0;

  /** Which of a poll's fixes are worth keeping. Pure; exported for tests through `select`. */
  const select = (fixes: Fix[]): Fix[] => {
    const kept: Fix[] = [];
    let inRange = 0;
    for (const f of fixes) {
      if (cfg.origin && cfg.radiusKm !== null && haversineKm(cfg.origin.lat, cfg.origin.lng, f.lat, f.lng) > cfg.radiusKm) continue;
      inRange++;
      const prev = last.get(f.hex);
      if (prev) {
        if (f.t <= prev.t) continue;                       // same or older position report
        const dt = f.t - prev.t;
        if (dt < cfg.minGapMs) continue;
        const moved = haversineKm(prev.lat, prev.lng, f.lat, f.lng) * 1000 >= cfg.minMoveM;
        const climbed = prev.altFt !== null && f.altFt !== null && Math.abs(f.altFt - prev.altFt) >= 50;
        if (!moved && !climbed && dt < cfg.heartbeatMs) continue;
      }
      last.set(f.hex, { t: f.t, lat: f.lat, lng: f.lng, altFt: f.altFt });
      kept.push(f);
    }
    status.aircraftInRange = inRange;
    // Forget aircraft not heard for 10 min so the map cannot grow without bound.
    const cutoff = now() - 10 * 60_000;
    for (const [hex, v] of last) if (v.t < cutoff) last.delete(hex);
    return kept;
  };

  const tick = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    status.ticks++;
    const t0 = now();
    status.lastTickAt = t0;
    try {
      const res = await fetchImpl(cfg.url, { signal: AbortSignal.timeout(Math.min(10_000, cfg.intervalMs * 2)), headers: { accept: 'application/json' }, cache: 'no-store' as RequestCache });
      if (!res.ok) throw new Error(`receiver HTTP ${res.status}`);
      const parsed = parseAircraftJson(await res.json(), t0);
      status.receiverNowMs = parsed.nowMs;
      status.clockSkewMs = parsed.nowMs - t0;
      status.aircraftSeen = parsed.fixes.length;
      const kept = select(parsed.fixes);
      const written = await deps.store.append(kept);
      status.fixesLastTick = written;
      status.fixesRecorded += written;
      status.lastOkAt = now();
      status.lastError = null;
      if (Math.abs(status.clockSkewMs) > 30_000 && status.ticks % 60 === 1) log(`receiver clock is ${Math.round(status.clockSkewMs / 1000)} s off ours`);
      if (now() - lastPruneAt > 6 * 3_600_000) {
        lastPruneAt = now();
        await deps.store.sealPastHours(new Date(t0).toISOString().slice(0, 10), t0).catch(() => []);
        const pruned = await deps.store.pruneOlderThan(cfg.retentionDays, t0).catch(() => []);
        if (pruned.length) { status.prunedDays = pruned; log(`pruned ${pruned.join(', ')} (retention ${cfg.retentionDays} d)`); }
      }
    } catch (e) {
      status.lastError = e instanceof Error ? e.message : String(e);
      if (status.ticks === 1 || status.ticks % 60 === 0) log(`poll failed: ${status.lastError}`);
    } finally {
      inFlight = false;
    }
  };

  const schedule = () => { timer = setTimeout(async () => { await tick(); if (status.running) schedule(); }, cfg.intervalMs); };
  return {
    tick,
    select,
    status: (): RecorderStatus => ({ ...status, prunedDays: [...status.prunedDays] }),
    start() { if (status.running) return; status.running = true; log(`recording from ${status.url} every ${cfg.intervalMs / 1000} s → ${deps.store.dir}`); void tick().then(() => { if (status.running) schedule(); }); },
    stop() { status.running = false; clearTimeout(timer); },
  };
}

export type TrackRecorder = ReturnType<typeof createTrackRecorder>;
