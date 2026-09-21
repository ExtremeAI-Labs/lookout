// The track store — append-only NDJSON, one file per UTC day, hash-chained by the hour so a
// recording can be shown to be what the receiver produced. Every fix is one compact line:
//   [t, hex, lat, lng, altFt|null, trackDeg|null, gsKt|null, callsign, flags, nacP|null]
// A day's manifest lists sealed hourly segments {hour, start, end, lines, sha256, chain} where
// chain = sha256(previousChain + sha256): change one byte in a sealed hour and every later
// chain value stops matching. The open tail (the current hour) is the only unsealed data.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Fix } from './receiver';
import { dataDir } from '@/lib/data-dir';

export const TRACKS_DIR = process.env.LOOKOUT_TRACKS_DIR || dataDir('tracks');
export const FLAG_GROUND = 1, FLAG_MILITARY = 2, FLAG_NON_ICAO = 4;
export const MAX_WINDOW_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_FIX_LIMIT = 200_000;

export type StoredFix = [t: number, hex: string, lat: number, lng: number, altFt: number | null, trackDeg: number | null, gsKt: number | null, callsign: string, flags: number, nacP: number | null];
export type Segment = { hour: string; start: number; end: number; lines: number; sha256: string; chain: string };
export type DayManifest = { version: 1; day: string; segments: Segment[]; updatedAt: string };
export type Track = { hex: string; callsign: string; military: boolean; fixes: StoredFix[] };
export type WindowResult = { fixes: StoredFix[]; scanned: number; truncated: boolean; sealedLines: number; unsealedLines: number; days: string[] };
export type DayVerification = { day: string; ok: boolean; segments: { hour: string; ok: boolean; expected: string; actual: string; chainOk: boolean }[]; unsealedBytes: number };

export const dayOf = (tMs: number) => new Date(tMs).toISOString().slice(0, 10);
export const hourOf = (tMs: number) => new Date(tMs).toISOString().slice(11, 13);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const sha = (buf: Buffer | string) => createHash('sha256').update(buf).digest('hex');

export function toStored(f: Fix): StoredFix {
  const flags = (f.ground ? FLAG_GROUND : 0) | (f.military ? FLAG_MILITARY : 0) | (f.hex.startsWith('~') ? FLAG_NON_ICAO : 0);
  return [f.t, f.hex, Math.round(f.lat * 1e5) / 1e5, Math.round(f.lng * 1e5) / 1e5, f.altFt === null ? null : Math.round(f.altFt), f.trackDeg === undefined ? null : Math.round(f.trackDeg), f.gsKt === undefined ? null : Math.round(f.gsKt), f.callsign ?? '', flags, f.nacP ?? null];
}

function parseLine(line: string): StoredFix | null {
  try {
    const a = JSON.parse(line);
    if (!Array.isArray(a) || a.length < 9 || typeof a[0] !== 'number' || typeof a[1] !== 'string' || typeof a[2] !== 'number' || typeof a[3] !== 'number') return null;
    return a as StoredFix;
  } catch { return null; }
}

/** Group a window's fixes into per-aircraft tracks, fixes in time order. */
export function groupTracks(fixes: StoredFix[]): Track[] {
  const by = new Map<string, Track>();
  for (const f of fixes) {
    let t = by.get(f[1]);
    if (!t) { t = { hex: f[1], callsign: '', military: false, fixes: [] }; by.set(f[1], t); }
    t.fixes.push(f);
    if (f[7] && !t.callsign) t.callsign = f[7];
    if (f[8] & FLAG_MILITARY) t.military = true;
  }
  for (const t of by.values()) t.fixes.sort((a, b) => a[0] - b[0]);
  return [...by.values()].sort((a, b) => a.fixes[0][0] - b.fixes[0][0]);
}

export class TrackStore {
  constructor(readonly dir: string = TRACKS_DIR) {}

  private file(day: string) { return path.join(this.dir, `${day}.ndjson`); }
  private manifestFile(day: string) { return path.join(this.dir, `${day}.manifest.json`); }

  async readManifest(day: string): Promise<DayManifest> {
    try {
      const m = JSON.parse(await fs.readFile(this.manifestFile(day), 'utf8')) as DayManifest;
      if (m && m.version === 1 && Array.isArray(m.segments)) return m;
    } catch { /* absent or unreadable → empty */ }
    return { version: 1, day, segments: [], updatedAt: new Date(0).toISOString() };
  }

  private async writeManifest(m: DayManifest) {
    m.updatedAt = new Date().toISOString();
    const tmp = this.manifestFile(m.day) + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(m, null, 1));
    await fs.rename(tmp, this.manifestFile(m.day));
  }

  /** Append fixes (grouped by their own UTC day). Seals any hour that has rolled. Returns lines written. */
  async append(fixes: Fix[]): Promise<number> {
    if (!fixes.length) return 0;
    await fs.mkdir(this.dir, { recursive: true });
    const byDay = new Map<string, Fix[]>();
    for (const f of fixes) { const d = dayOf(f.t); (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(f); }
    let written = 0;
    for (const [day, list] of byDay) {
      list.sort((a, b) => a.t - b.t);
      await this.sealPastHours(day, list[0].t);
      const text = list.map((f) => JSON.stringify(toStored(f))).join('\n') + '\n';
      await fs.appendFile(this.file(day), text);
      written += list.length;
    }
    return written;
  }

  /** Seal every complete hour before `nowMs` in `day` (and any older day still open). Idempotent. */
  async sealPastHours(day: string, nowMs: number): Promise<Segment[]> {
    const sealed: Segment[] = [];
    let fh: fs.FileHandle;
    try { fh = await fs.open(this.file(day), 'r'); } catch { return sealed; }
    try {
      const size = (await fh.stat()).size;
      const m = await this.readManifest(day);
      let start = m.segments.length ? m.segments[m.segments.length - 1].end : 0;
      const currentHour = dayOf(nowMs) === day ? hourOf(nowMs) : '24';
      while (start < size) {
        // Read the open tail; split it at the first line that belongs to the current hour.
        const buf = Buffer.alloc(size - start);
        await fh.read(buf, 0, buf.length, start);
        const text = buf.toString('utf8');
        const lines = text.split('\n');
        if (lines[lines.length - 1] === '') lines.pop();
        if (!lines.length) break;
        const firstHour = hourOf((parseLine(lines[0])?.[0]) ?? nowMs);
        if (firstHour >= currentHour) break; // the tail is the current hour: stays open
        let bytes = 0, count = 0;
        for (const line of lines) {
          const t = parseLine(line)?.[0];
          if (t !== undefined && hourOf(t) !== firstHour) break;
          bytes += Buffer.byteLength(line, 'utf8') + 1;
          count++;
        }
        const segBuf = buf.subarray(0, bytes);
        const digest = sha(segBuf);
        const prev = m.segments.length ? m.segments[m.segments.length - 1].chain : '';
        const seg: Segment = { hour: firstHour, start, end: start + bytes, lines: count, sha256: digest, chain: sha(prev + digest) };
        m.segments.push(seg);
        sealed.push(seg);
        start = seg.end;
      }
      if (sealed.length) await this.writeManifest(m);
    } finally { await fh.close(); }
    return sealed;
  }

  /** Fixes in [fromMs, toMs], read by hour ranges from the manifest, oldest first. */
  async readWindow(fromMs: number, toMs: number, opts: { hex?: string; bbox?: [number, number, number, number]; limit?: number } = {}): Promise<WindowResult> {
    const out: WindowResult = { fixes: [], scanned: 0, truncated: false, sealedLines: 0, unsealedLines: 0, days: [] };
    if (!(toMs > fromMs)) return out;
    const limit = Math.max(1, opts.limit ?? DEFAULT_FIX_LIMIT);
    const hex = opts.hex?.toLowerCase();
    for (let d = Date.UTC(+dayOf(fromMs).slice(0, 4), +dayOf(fromMs).slice(5, 7) - 1, +dayOf(fromMs).slice(8, 10)); d <= toMs && !out.truncated; d += 86_400_000) {
      const day = dayOf(d);
      let fh: fs.FileHandle;
      try { fh = await fs.open(this.file(day), 'r'); } catch { continue; }
      out.days.push(day);
      try {
        const size = (await fh.stat()).size;
        const m = await this.readManifest(day);
        const ranges: { start: number; end: number; sealed: boolean }[] = [];
        for (const s of m.segments) {
          const hStart = Date.parse(`${day}T${s.hour}:00:00Z`);
          if (hStart + 3_600_000 >= fromMs && hStart <= toMs) ranges.push({ start: s.start, end: s.end, sealed: true });
        }
        const tailStart = m.segments.length ? m.segments[m.segments.length - 1].end : 0;
        if (tailStart < size) ranges.push({ start: tailStart, end: size, sealed: false });
        for (const r of ranges) {
          const buf = Buffer.alloc(r.end - r.start);
          await fh.read(buf, 0, buf.length, r.start);
          for (const line of buf.toString('utf8').split('\n')) {
            if (!line) continue;
            out.scanned++;
            const f = parseLine(line);
            if (!f || f[0] < fromMs || f[0] > toMs) continue;
            if (hex && f[1] !== hex) continue;
            if (opts.bbox && (f[3] < opts.bbox[0] || f[2] < opts.bbox[1] || f[3] > opts.bbox[2] || f[2] > opts.bbox[3])) continue;
            if (out.fixes.length >= limit) { out.truncated = true; break; }
            out.fixes.push(f);
            if (r.sealed) out.sealedLines++; else out.unsealedLines++;
          }
          if (out.truncated) break;
        }
      } finally { await fh.close(); }
    }
    return out;
  }

  /** Recompute every sealed segment's hash and chain for a day. */
  async verifyDay(day: string): Promise<DayVerification> {
    if (!DAY_RE.test(day)) throw new Error('day must be YYYY-MM-DD');
    const m = await this.readManifest(day);
    const res: DayVerification = { day, ok: true, segments: [], unsealedBytes: 0 };
    let fh: fs.FileHandle;
    try { fh = await fs.open(this.file(day), 'r'); } catch { res.ok = m.segments.length === 0; return res; }
    try {
      const size = (await fh.stat()).size;
      let prev = '';
      for (const s of m.segments) {
        const buf = Buffer.alloc(Math.max(0, s.end - s.start));
        if (s.end <= size) await fh.read(buf, 0, buf.length, s.start);
        const actual = s.end <= size ? sha(buf) : 'missing';
        const chainOk = sha(prev + actual) === s.chain;
        const ok = actual === s.sha256 && chainOk;
        res.segments.push({ hour: s.hour, ok, expected: s.sha256, actual, chainOk });
        if (!ok) res.ok = false;
        prev = s.chain;
      }
      res.unsealedBytes = Math.max(0, size - (m.segments.length ? m.segments[m.segments.length - 1].end : 0));
    } finally { await fh.close(); }
    return res;
  }

  async listDays(): Promise<{ day: string; bytes: number; sealedSegments: number }[]> {
    let names: string[];
    try { names = await fs.readdir(this.dir); } catch { return []; }
    const days = names.filter((n) => /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(n)).map((n) => n.slice(0, 10)).sort();
    const out = [];
    for (const day of days) {
      const st = await fs.stat(this.file(day)).catch(() => null);
      const m = await this.readManifest(day);
      out.push({ day, bytes: st?.size ?? 0, sealedSegments: m.segments.length });
    }
    return out;
  }

  /** Delete whole days older than `days` before `nowMs`. Returns the days removed. */
  async pruneOlderThan(days: number, nowMs = Date.now()): Promise<string[]> {
    const cutoff = dayOf(nowMs - Math.max(1, days) * 86_400_000);
    const removed: string[] = [];
    for (const d of await this.listDays()) {
      if (d.day < cutoff) {
        await fs.rm(this.file(d.day), { force: true });
        await fs.rm(this.manifestFile(d.day), { force: true });
        removed.push(d.day);
      }
    }
    return removed;
  }
}
