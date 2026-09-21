import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTrackRecorder, redactUrl, DEFAULTS } from './recorder';
import { TrackStore } from './store';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lookout-rec-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const T0 = Date.UTC(2026, 8, 17, 12, 0, 0);
const receiver = (nowS: number, aircraft: Record<string, unknown>[]) => new Response(JSON.stringify({ now: nowS, aircraft }), { status: 200, headers: { 'content-type': 'application/json' } });

function make(responses: (() => Response)[], cfgOverrides = {}) {
  let clock = T0;
  let i = 0;
  const store = new TrackStore(dir);
  const logs: string[] = [];
  const rec = createTrackRecorder(
    { url: 'http://user:pw@receiver.local/data/aircraft.json', intervalMs: 5000, minGapMs: DEFAULTS.minGapMs, heartbeatMs: DEFAULTS.heartbeatMs, minMoveM: DEFAULTS.minMoveM, radiusKm: 100, origin: { lat: 34, lng: -118 }, retentionDays: 30, ...cfgOverrides },
    { store, fetchImpl: (async () => (responses[Math.min(i++, responses.length - 1)])()) as unknown as typeof fetch, now: () => clock, log: (m) => logs.push(m) },
  );
  return { rec, store, logs, advance: (ms: number) => { clock += ms; } };
}

describe('track recorder', () => {
  it('records moved aircraft, skips out-of-range and unchanged positions, heartbeats a holder', async () => {
    const s = T0 / 1000;
    const { rec, store, advance } = make([
      () => receiver(s, [{ hex: 'abc123', lat: 34.1, lon: -118.1, alt_baro: 5000, seen_pos: 0 }, { hex: 'fa0001', lat: 40, lon: -110, seen_pos: 0 }]),
      () => receiver(s + 5, [{ hex: 'abc123', lat: 34.1, lon: -118.1, alt_baro: 5000, seen_pos: 0 }]),       // unchanged → skipped
      () => receiver(s + 10, [{ hex: 'abc123', lat: 34.12, lon: -118.1, alt_baro: 5000, seen_pos: 0 }]),     // moved → kept
      () => receiver(s + 70, [{ hex: 'abc123', lat: 34.12, lon: -118.1, alt_baro: 5000, seen_pos: 0 }]),     // still, but 60 s → heartbeat
    ]);
    await rec.tick();
    let st = rec.status();
    expect(st.url).toBe('http://receiver.local/data/aircraft.json');
    expect(st.aircraftSeen).toBe(2);
    expect(st.aircraftInRange).toBe(1);
    expect(st.fixesLastTick).toBe(1);
    advance(5000); await rec.tick();
    expect(rec.status().fixesLastTick).toBe(0);
    advance(5000); await rec.tick();
    expect(rec.status().fixesLastTick).toBe(1);
    advance(60_000); await rec.tick();
    st = rec.status();
    expect(st.fixesLastTick).toBe(1);
    expect(st.fixesRecorded).toBe(3);
    expect(st.lastError).toBeNull();
    expect(st.clockSkewMs).toBe(0);
    const w = await store.readWindow(T0 - 1000, T0 + 120_000);
    expect(w.fixes.map((f) => f[1])).toEqual(['abc123', 'abc123', 'abc123']);
  });

  it('keeps going through receiver failures and reports them', async () => {
    const { rec, logs } = make([() => new Response('down', { status: 503 }), () => receiver(T0 / 1000, [])]);
    await rec.tick();
    expect(rec.status().lastError).toMatch(/HTTP 503/);
    expect(logs.some((l) => /poll failed/.test(l))).toBe(true);
    await rec.tick();
    expect(rec.status().lastError).toBeNull();
    expect(rec.status().ticks).toBe(2);
  });

  it('never leaks receiver credentials', () => {
    expect(redactUrl('http://admin:secret@host/aircraft.json')).toBe('http://host/aircraft.json');
    expect(redactUrl('not a url')).toBe('invalid url');
  });
});
