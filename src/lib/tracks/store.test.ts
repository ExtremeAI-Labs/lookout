import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Fix } from './receiver';
import { dayOf, groupTracks, hourOf, TrackStore } from './store';

const fix = (hex: string, t: number, lat = 34, lng = -118, extra: Partial<Fix> = {}): Fix => ({ hex, t, lat, lng, altFt: 1000, ground: false, ...extra });
const H = 3_600_000;
const T0 = Date.UTC(2026, 8, 17, 10, 0, 0); // 2026-09-17T10:00Z

let dir: string;
let store: TrackStore;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lookout-tracks-')); store = new TrackStore(dir); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('TrackStore', () => {
  it('appends compact lines per UTC day and reads a window back grouped into tracks', async () => {
    expect(dayOf(T0)).toBe('2026-09-17');
    expect(hourOf(T0)).toBe('10');
    await store.append([fix('abc123', T0 + 1000, 34.0, -118.0, { callsign: 'UAL1', gsKt: 400.4, trackDeg: 90.6 }), fix('abc123', T0 + 6000, 34.01, -118.01), fix('def456', T0 + 2000, 35, -117, { military: true, ground: true, altFt: 0 })]);
    const w = await store.readWindow(T0, T0 + 10_000);
    expect(w.fixes).toHaveLength(3);
    expect(w.unsealedLines).toBe(3);
    expect(w.sealedLines).toBe(0);
    const tracks = groupTracks(w.fixes);
    expect(tracks.map((t) => t.hex)).toEqual(['abc123', 'def456']);
    expect(tracks[0].callsign).toBe('UAL1');
    expect(tracks[0].fixes[0].slice(4, 8)).toEqual([1000, 91, 400, 'UAL1']);
    expect(tracks[1].military).toBe(true);
    expect(tracks[1].fixes[0][8] & 1).toBe(1); // ground flag
    // outside the window
    expect((await store.readWindow(T0 + 7000, T0 + 8000)).fixes).toHaveLength(0);
    // filters
    expect((await store.readWindow(T0, T0 + 10_000, { hex: 'DEF456' })).fixes).toHaveLength(1);
    expect((await store.readWindow(T0, T0 + 10_000, { bbox: [-118.5, 33.5, -117.5, 34.5] })).fixes).toHaveLength(2);
    expect((await store.readWindow(T0, T0 + 10_000, { limit: 2 })).truncated).toBe(true);
  });

  it('seals each hour that has rolled into a hash chain and verifies it; a tampered byte breaks the chain', async () => {
    await store.append([fix('abc123', T0 + 1000), fix('abc123', T0 + 2000)]);           // hour 10
    await store.append([fix('abc123', T0 + H + 1000)]);                                    // hour 11 → seals hour 10
    let m = await store.readManifest('2026-09-17');
    expect(m.segments.map((s) => s.hour)).toEqual(['10']);
    expect(m.segments[0].lines).toBe(2);
    await store.append([fix('abc123', T0 + 2 * H + 500)]);                                 // hour 12 → seals 11
    m = await store.readManifest('2026-09-17');
    expect(m.segments.map((s) => s.hour)).toEqual(['10', '11']);
    expect(m.segments[1].chain).not.toBe(m.segments[0].chain);
    const w = await store.readWindow(T0, T0 + 3 * H);
    expect(w.sealedLines).toBe(3);
    expect(w.unsealedLines).toBe(1);
    expect((await store.verifyDay('2026-09-17')).ok).toBe(true);

    // Tamper with one byte inside hour 10.
    const file = path.join(dir, '2026-09-17.ndjson');
    const buf = Buffer.from(await fs.readFile(file));
    buf[5] = buf[5] === 0x31 ? 0x32 : 0x31;
    await fs.writeFile(file, buf);
    const v = await store.verifyDay('2026-09-17');
    expect(v.ok).toBe(false);
    expect(v.segments[0].ok).toBe(false);
    expect(v.segments[1].ok).toBe(true); // its own bytes are intact; the chain still stands on the recorded value
  });

  it('seals past hours on demand, spans days, lists and prunes', async () => {
    const lateDay1 = Date.UTC(2026, 8, 17, 23, 1, 0);   // 23:01Z on day 1
    const earlyDay2 = Date.UTC(2026, 8, 18, 0, 0, 30);  // 00:00:30Z on day 2
    await store.append([fix('abc123', lateDay1)]);
    await store.append([fix('abc123', earlyDay2)]);
    expect((await store.sealPastHours('2026-09-17', earlyDay2 + 60_000)).map((s) => s.hour)).toEqual(['23']);
    expect((await store.readWindow(lateDay1 - H, earlyDay2 + H)).days).toEqual(['2026-09-17', '2026-09-18']);
    const days = await store.listDays();
    expect(days.map((d) => d.day)).toEqual(['2026-09-17', '2026-09-18']);
    expect(days[0].sealedSegments).toBe(1);
    expect(await store.pruneOlderThan(1, earlyDay2 + 2 * 24 * H)).toEqual(['2026-09-17', '2026-09-18']);
    expect(await store.listDays()).toEqual([]);
    await expect(store.verifyDay('nope')).rejects.toThrow(/YYYY-MM-DD/);
  });
});
