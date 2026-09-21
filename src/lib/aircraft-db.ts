// The aircraft registry — Mictronics' database as published by tar1090-db (csv branch):
// 617k rows of `HEX;REG;TYPE;FLAGS;DESC;YEAR;OWNER;`, sorted by hex, ~32 MB uncompressed. It is
// what every community tracker uses to turn an ICAO hex into a tail number, a type and an owner.
// Kept on disk and binary-searched (a lookup is ~20 small reads), never loaded whole into memory.
// FLAGS is four characters: military · interesting · PIA (FAA privacy-address block) · LADD
// (FAA "Limiting Aircraft Data Displayed" — hidden on FAA-fed sites, visible on community feeds).
import { promises as fs } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import { dataDir } from '@/lib/data-dir';

export const AIRCRAFT_DB_DIR = process.env.LOOKOUT_AIRCRAFT_DB_DIR || dataDir('aircraft-db');
export const AIRCRAFT_DB_URL = 'https://github.com/wiedehopf/tar1090-db/raw/refs/heads/csv/aircraft.csv.gz';
export const REFRESH_AFTER_MS = 7 * 24 * 3_600_000;

export type AircraftFlags = { military: boolean; interesting: boolean; pia: boolean; ladd: boolean };
export type AircraftRecord = { hex: string; reg: string; type: string; flags: AircraftFlags; desc: string; year: string; owner: string };

export function parseFlags(raw: string): AircraftFlags {
  const f = (raw || '').padEnd(4, '0');
  return { military: f[0] === '1', interesting: f[1] === '1', pia: f[2] === '1', ladd: f[3] === '1' };
}

export function parseRow(line: string): AircraftRecord | null {
  const c = line.split(';');
  if (c.length < 4 || !/^[0-9A-Fa-f]{6}$/.test(c[0])) return null;
  return { hex: c[0].toLowerCase(), reg: c[1] || '', type: c[2] || '', flags: parseFlags(c[3]), desc: c[4] || '', year: c[5] || '', owner: c[6] || '' };
}

const csvPath = (dir: string) => path.join(dir, 'aircraft.csv');
const regIndexPath = (dir: string) => path.join(dir, 'reg-index.csv');
const metaPath = (dir: string) => path.join(dir, 'meta.json');

/** Binary search a sorted text file of `KEY;...` lines; keys compared bytewise (upper-case hex / regs). */
async function bsearchLine(file: string, key: string): Promise<string | null> {
  let fh: fs.FileHandle;
  try { fh = await fs.open(file, 'r'); } catch { return null; }
  try {
    const size = (await fh.stat()).size;
    const CH = 4096;
    const buf = Buffer.alloc(CH);
    let lo = 0, hi = size;
    for (let i = 0; i < 40 && lo < hi; i++) {
      const mid = Math.floor((lo + hi) / 2);
      // Read a window and step back to the start of the line containing `mid`.
      const start = Math.max(0, mid - CH / 2);
      const n = (await fh.read(buf, 0, Math.min(CH, size - start), start)).bytesRead;
      const text = buf.toString('latin1', 0, n);
      const rel = mid - start;
      const lineStart = start === 0 && rel === 0 ? 0 : text.lastIndexOf('\n', rel - 1) + 1;
      const lineEnd = text.indexOf('\n', lineStart);
      if (lineEnd < 0 && start + n < size) { hi = start + lineStart; continue; }
      const line = text.slice(lineStart, lineEnd < 0 ? n : lineEnd);
      const k = line.slice(0, line.indexOf(';') < 0 ? line.length : line.indexOf(';'));
      if (k === key) return line;
      if (k < key) lo = start + (lineEnd < 0 ? n : lineEnd + 1); else hi = start + lineStart;
    }
    return null;
  } finally { await fh.close(); }
}

const cache = new Map<string, AircraftRecord | null>();
const remember = (k: string, v: AircraftRecord | null) => { if (cache.size > 5000) cache.delete(cache.keys().next().value as string); cache.set(k, v); return v; };

export class AircraftDb {
  constructor(readonly dir: string = AIRCRAFT_DB_DIR) {}

  async meta(): Promise<{ fetchedAt: string | null; rows: number; ready: boolean }> {
    try {
      const m = JSON.parse(await fs.readFile(metaPath(this.dir), 'utf8')) as { fetchedAt: string; rows: number };
      await fs.access(csvPath(this.dir)); await fs.access(regIndexPath(this.dir));
      return { ...m, ready: true };
    } catch { return { fetchedAt: null, rows: 0, ready: false }; }
  }

  /** Download (if absent or stale) and build the registration index. Idempotent; safe to call often. */
  async ensure(opts: { fetchImpl?: typeof fetch; force?: boolean; now?: number } = {}): Promise<{ refreshed: boolean; rows: number }> {
    const now = opts.now ?? Date.now();
    const m = await this.meta();
    const stale = !m.fetchedAt || now - Date.parse(m.fetchedAt) > REFRESH_AFTER_MS;
    const haveCsv = await fs.access(csvPath(this.dir)).then(() => true, () => false);
    if (m.ready && !stale && !opts.force) return { refreshed: false, rows: m.rows };
    await fs.mkdir(this.dir, { recursive: true });
    // A CSV with no index yet (hand-staged, or an interrupted first run) is indexed, not re-fetched.
    const needDownload = !haveCsv || opts.force || (m.fetchedAt !== null && stale);
    if (needDownload) {
      const f = opts.fetchImpl ?? fetch;
      const res = await f(AIRCRAFT_DB_URL, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok || !res.body) throw new Error(`aircraft db download failed: HTTP ${res.status}`);
      const tmp = csvPath(this.dir) + '.tmp';
      await pipeline(Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream), createGunzip(), createWriteStream(tmp));
      await fs.rename(tmp, csvPath(this.dir));
    }
    const rows = await this.buildRegIndex();
    await fs.writeFile(metaPath(this.dir), JSON.stringify({ fetchedAt: new Date(now).toISOString(), rows }));
    cache.clear();
    return { refreshed: true, rows };
  }

  /** `REG;HEX` sorted by registration, so a tail number resolves in one binary search. */
  private async buildRegIndex(): Promise<number> {
    const text = await fs.readFile(csvPath(this.dir), 'latin1');
    const pairs: string[] = [];
    let rows = 0;
    for (const line of text.split('\n')) {
      if (!line) continue;
      rows++;
      const a = line.indexOf(';'), b = line.indexOf(';', a + 1);
      if (a < 0 || b < 0) continue;
      const reg = line.slice(a + 1, b);
      if (reg) pairs.push(`${reg.toUpperCase()};${line.slice(0, a)}`);
    }
    // Sort by the KEY, not the line: ';' sorts after digits and letters, so a whole-line sort
    // would put "98-00010;…" before "98-0001;…" and the key-ordered binary search would miss.
    const keyOf = (l: string) => l.slice(0, l.indexOf(';'));
    pairs.sort((a, b) => { const ka = keyOf(a), kb = keyOf(b); return ka < kb ? -1 : ka > kb ? 1 : 0; });
    const tmp = regIndexPath(this.dir) + '.tmp';
    await fs.writeFile(tmp, pairs.join('\n') + '\n', 'latin1');
    await fs.rename(tmp, regIndexPath(this.dir));
    return rows;
  }

  async lookupHex(hex: string): Promise<AircraftRecord | null> {
    const key = hex.trim().toUpperCase();
    if (!/^[0-9A-F]{6}$/.test(key)) return null;
    const ck = `h:${key}`;
    if (cache.has(ck)) return cache.get(ck)!;
    const line = await bsearchLine(csvPath(this.dir), key);
    return remember(ck, line ? parseRow(line) : null);
  }

  async lookupReg(reg: string): Promise<AircraftRecord | null> {
    const key = reg.trim().toUpperCase().replace(/\s+/g, '');
    if (!key || key.length > 12) return null;
    const ck = `r:${key}`;
    if (cache.has(ck)) return cache.get(ck)!;
    const line = await bsearchLine(regIndexPath(this.dir), key);
    if (!line) return remember(ck, null);
    const hex = line.slice(line.indexOf(';') + 1).trim();
    return remember(ck, await this.lookupHex(hex));
  }

  /** Full scan with a predicate — for building packs (owner / description matches). Seconds, not ms. */
  async scan(pred: (r: AircraftRecord) => boolean, limit = 500): Promise<AircraftRecord[]> {
    const out: AircraftRecord[] = [];
    let fh: fs.FileHandle;
    try { fh = await fs.open(csvPath(this.dir), 'r'); } catch { return out; }
    try {
      const CH = 1 << 20;
      const buf = Buffer.alloc(CH);
      let rest = '';
      for (let pos = 0; ; ) {
        const n = (await fh.read(buf, 0, CH, pos)).bytesRead;
        if (!n) break;
        pos += n;
        const text = rest + buf.toString('latin1', 0, n);
        const lines = text.split('\n');
        rest = lines.pop() ?? '';
        for (const l of lines) { const r = parseRow(l); if (r && pred(r)) { out.push(r); if (out.length >= limit) return out; } }
      }
      const r = parseRow(rest); if (r && pred(r)) out.push(r);
    } finally { await fh.close(); }
    return out;
  }
}

let shared: AircraftDb | null = null;
export function aircraftDb(): AircraftDb { return (shared ??= new AircraftDb()); }
