// The aircraft watchlist — "notable" airframes the operator wants to know about, matched against
// every flights poll and remembered in a sightings log. Packs are DATA-DRIVEN: each is a query
// over the public registry (an owner, a type description, a set of tail numbers) resolved on
// this machine, so nothing here hardcodes an ICAO hex from memory. What this can and cannot do:
//   · ADS-B is an unencrypted public broadcast; Lookout's feeds (OpenSky, adsb.fi) do not honour
//     the FAA's LADD list, so LADD aircraft (most VIP jets) are visible when they transmit.
//   · An aircraft flying under an FAA PIA code broadcasts a rotating hex, not its registered one
//     — Falcon Landing's jets do this — so a hex match will usually miss; say so, don't guess.
//   · Coverage is community receivers: no receiver in range, no sighting. Absence is not evidence.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { aircraftDb, type AircraftDb, type AircraftFlags, type AircraftRecord } from './aircraft-db';
import { dataDir } from '@/lib/data-dir';

export const WATCH_DIR = process.env.LOOKOUT_WATCH_DIR || dataDir('watch');
export type WatchPackId = 'executive' | 'codel' | 'djt' | 'falcon-landing' | 'custom';
export type WatchItem = {
  id: string; hex: string; reg: string; label: string; pack: WatchPackId;
  type?: string; desc?: string; owner?: string; flags?: AircraftFlags; addedAt: string; note?: string;
};
export type Sighting = { lastSeenAt: number; firstSeenAt: number; callsign: string; lat: number; lng: number; alt: number; count: number };
export type NotableTag = { label: string; pack: WatchPackId; reg: string };
export type AircraftLike = { icao24?: string; callsign?: string; lat: number; lng: number; alt: number; speed_knots?: number | null; heading?: number | null };

export const PACKS: { id: WatchPackId; label: string; note: string; resolve: (db: AircraftDb) => Promise<AircraftRecord[]> }[] = [
  { id: 'executive', label: 'US executive fleet', note: 'VC-25A "Air Force One" (82-8000, 92-9000) and the C-32A "Air Force Two" fleet (98-0001 … 99-0004). Military-flagged; they transmit ADS-B on most legs and go dark on some.',
    resolve: async (db) => (await Promise.all(['82-8000', '92-9000', '98-0001', '98-0002', '99-0003', '99-0004'].map((r) => db.lookupReg(r)))).filter((x): x is AircraftRecord => !!x) },
  { id: 'codel', label: 'USAF C-40B/C fleet', note: 'The 89th Airlift Wing / Guard C-40s that carry cabinet members and congressional delegations (CODELs). Resolved from the registry by type description.',
    resolve: (db) => db.scan((r) => r.flags.military && /Boeing C-40[BC]/.test(r.desc), 40) },
  { id: 'djt', label: 'DJT Operations (Trump Organization)', note: 'Aircraft registered to DJT Operations I LLC — the 757-200 N757AF. LADD-listed: hidden on FAA-fed sites, visible on community feeds.',
    resolve: (db) => db.scan((r) => /\bDJT OPERATIONS\b/i.test(r.owner), 20) },
  { id: 'falcon-landing', label: 'Falcon Landing LLC (Musk)', note: 'N628TS and siblings. These fly under FAA PIA codes: the broadcast hex is not the registered one, so hex matching usually misses. Shown for honesty, not as a promise.',
    resolve: (db) => db.scan((r) => /^FALCON LANDING LLC$/i.test(r.owner), 20) },
];

const APPEAR_GAP_MS = 30 * 60_000;
const UPDATE_EVERY_MS = 10 * 60_000;
const ID_RE = /^[A-Za-z0-9_-]{4,40}$/;
const uid = () => `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

type StoreFile = { version: 1; custom: WatchItem[]; disabledPacks: WatchPackId[] };
type ResolvedFile = { dbFetchedAt: string | null; items: WatchItem[] };

const itemFromRecord = (r: AircraftRecord, pack: WatchPackId, label?: string, note?: string): WatchItem => ({
  id: `${pack}-${r.hex}`, hex: r.hex, reg: r.reg, label: label || r.reg || r.hex.toUpperCase(), pack,
  type: r.type || undefined, desc: r.desc || undefined, owner: r.owner || undefined, flags: r.flags, addedAt: new Date().toISOString(), note,
});

export class Watchlist {
  private seen = new Map<string, Sighting>();
  private lastUpdateWritten = new Map<string, number>();
  private byHex: Map<string, WatchItem> | null = null;
  private loaded = false;
  constructor(readonly dir: string = WATCH_DIR, private db: AircraftDb = aircraftDb(), private deps: { fetchImpl?: typeof fetch; ntfyUrl?: string; log?: (m: string) => void } = {}) {}

  private file(name: string) { return path.join(this.dir, name); }
  private async readJson<T>(name: string, fallback: T): Promise<T> {
    try { return JSON.parse(await fs.readFile(this.file(name), 'utf8')) as T; } catch { return fallback; }
  }
  private async writeJson(name: string, v: unknown) {
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = this.file(name) + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(v, null, 1));
    await fs.rename(tmp, this.file(name));
  }

  private async load() {
    if (this.loaded) return;
    this.loaded = true;
    const seen = await this.readJson<Record<string, Sighting>>('seen.json', {});
    for (const [k, v] of Object.entries(seen)) this.seen.set(k, v);
  }

  async store(): Promise<StoreFile> { return this.readJson<StoreFile>('watchlist.json', { version: 1, custom: [], disabledPacks: [] }); }

  /** Pack items, resolved against the current registry and cached until the registry refreshes. */
  async packItems(): Promise<WatchItem[]> {
    const meta = await this.db.meta();
    if (!meta.ready) return [];
    const cached = await this.readJson<ResolvedFile>('packs-resolved.json', { dbFetchedAt: null, items: [] });
    if (cached.dbFetchedAt === meta.fetchedAt && cached.items.length) return cached.items;
    const items: WatchItem[] = [];
    for (const p of PACKS) {
      try { for (const r of await p.resolve(this.db)) items.push(itemFromRecord(r, p.id)); }
      catch (e) { this.deps.log?.(`pack ${p.id} failed to resolve: ${e instanceof Error ? e.message : e}`); }
    }
    await this.writeJson('packs-resolved.json', { dbFetchedAt: meta.fetchedAt, items } satisfies ResolvedFile);
    this.byHex = null;
    return items;
  }

  async items(): Promise<WatchItem[]> {
    const s = await this.store();
    const packs = (await this.packItems()).filter((i) => !s.disabledPacks.includes(i.pack));
    return [...packs, ...s.custom];
  }

  private async index(): Promise<Map<string, WatchItem>> {
    if (this.byHex) return this.byHex;
    const m = new Map<string, WatchItem>();
    for (const i of await this.items()) if (!m.has(i.hex)) m.set(i.hex, i);
    this.byHex = m;
    return m;
  }

  /** Add by tail number or hex. Resolves through the registry; a hex the registry lacks is still watchable. */
  async addCustom(query: string, label?: string, note?: string): Promise<{ ok: true; item: WatchItem } | { ok: false; error: string }> {
    const q = query.trim().toUpperCase().replace(/\s+/g, '');
    if (!q || q.length > 12) return { ok: false, error: 'give a tail number (N757AF) or a 6-digit ICAO hex' };
    let rec = await this.db.lookupReg(q);
    if (!rec && /^[0-9A-F]{6}$/.test(q)) rec = (await this.db.lookupHex(q)) ?? { hex: q.toLowerCase(), reg: '', type: '', flags: { military: false, interesting: false, pia: false, ladd: false }, desc: '', year: '', owner: '' };
    if (!rec) return { ok: false, error: `no aircraft registered as ${q} in the registry (${(await this.db.meta()).rows.toLocaleString()} rows)` };
    const s = await this.store();
    if (s.custom.some((c) => c.hex === rec!.hex)) return { ok: false, error: `${rec.reg || rec.hex.toUpperCase()} is already on the watchlist` };
    const item = { ...itemFromRecord(rec, 'custom', (label || '').trim().slice(0, 80) || undefined, (note || '').trim().slice(0, 300) || undefined), id: uid() };
    s.custom.push(item);
    await this.writeJson('watchlist.json', s);
    this.byHex = null;
    return { ok: true, item };
  }

  async remove(id: string): Promise<boolean> {
    if (!ID_RE.test(id)) return false;
    const s = await this.store();
    const n = s.custom.length;
    s.custom = s.custom.filter((c) => c.id !== id);
    if (s.custom.length === n) return false;
    await this.writeJson('watchlist.json', s);
    this.byHex = null;
    return true;
  }

  async setPackEnabled(pack: WatchPackId, enabled: boolean): Promise<void> {
    const s = await this.store();
    s.disabledPacks = enabled ? s.disabledPacks.filter((p) => p !== pack) : [...new Set([...s.disabledPacks, pack])];
    await this.writeJson('watchlist.json', s);
    this.byHex = null;
  }

  /** Match one poll's aircraft. Returns the tags to attach; records sightings; alerts on (re)appearance. */
  async observe(aircraft: AircraftLike[], now = Date.now()): Promise<{ notables: (NotableTag & { hex: string; callsign: string; lat: number; lng: number; alt: number })[]; appeared: WatchItem[] }> {
    await this.load();
    const idx = await this.index();
    if (!idx.size) return { notables: [], appeared: [] };
    const notables: (NotableTag & { hex: string; callsign: string; lat: number; lng: number; alt: number })[] = [];
    const appeared: WatchItem[] = [];
    const lines: string[] = [];
    let dirty = false;
    for (const a of aircraft) {
      const hex = String(a.icao24 || '').toLowerCase();
      const item = hex ? idx.get(hex) : undefined;
      if (!item) continue;
      const callsign = String(a.callsign || '').trim();
      notables.push({ hex, label: item.label, pack: item.pack, reg: item.reg, callsign, lat: a.lat, lng: a.lng, alt: a.alt });
      const prev = this.seen.get(hex);
      const isAppearance = !prev || now - prev.lastSeenAt > APPEAR_GAP_MS;
      const s: Sighting = { firstSeenAt: isAppearance || !prev ? now : prev.firstSeenAt, lastSeenAt: now, callsign, lat: a.lat, lng: a.lng, alt: a.alt, count: (prev?.count ?? 0) + 1 };
      this.seen.set(hex, s);
      dirty = true;
      const lastWritten = this.lastUpdateWritten.get(hex) ?? 0;
      if (isAppearance || now - lastWritten > UPDATE_EVERY_MS) {
        lines.push(JSON.stringify({ t: new Date(now).toISOString(), event: isAppearance ? 'appeared' : 'update', hex, reg: item.reg, label: item.label, pack: item.pack, callsign, lat: a.lat, lng: a.lng, alt: a.alt, speed_knots: a.speed_knots ?? null, heading: a.heading ?? null }));
        this.lastUpdateWritten.set(hex, now);
      }
      if (isAppearance) appeared.push(item);
    }
    if (dirty) {
      await this.writeJson('seen.json', Object.fromEntries(this.seen));
      if (lines.length) { await fs.mkdir(this.dir, { recursive: true }); await fs.appendFile(this.file('sightings.ndjson'), lines.join('\n') + '\n'); }
    }
    if (appeared.length) void this.alert(appeared, notables);
    return { notables, appeared };
  }

  private async alert(appeared: WatchItem[], notables: { hex: string; callsign: string; lat: number; lng: number; alt: number }[]) {
    const url = this.deps.ntfyUrl ?? process.env.LOOKOUT_NTFY_URL;
    if (!url) return;
    const f = this.deps.fetchImpl ?? fetch;
    for (const it of appeared) {
      const n = notables.find((x) => x.hex === it.hex);
      const body = `${it.label}${it.reg && it.reg !== it.label ? ` (${it.reg})` : ''}${n?.callsign ? ` as ${n.callsign}` : ''} — ${n ? `${n.lat.toFixed(3)}, ${n.lng.toFixed(3)} · ${Math.round(n.alt * 3.28084).toLocaleString()} ft` : 'seen'}`;
      try {
        await f(url, { method: 'POST', headers: { Title: `Lookout watch: ${it.label}`, Tags: 'airplane', 'User-Agent': 'Mozilla/5.0 (Lookout watchlist)' }, body, signal: AbortSignal.timeout(8000) });
      } catch (e) { this.deps.log?.(`ntfy failed: ${e instanceof Error ? e.message : e}`); }
    }
  }

  sighting(hex: string): Sighting | undefined { return this.seen.get(hex.toLowerCase()); }

  async status(now = Date.now()) {
    await this.load();
    const s = await this.store();
    const items = await this.items();
    const withSightings = (list: WatchItem[]) => list.map((i) => { const sg = this.seen.get(i.hex); return { ...i, sighting: sg ?? null, airborne: !!sg && now - sg.lastSeenAt < 3 * 60_000 }; });
    return {
      packs: PACKS.map((p) => ({ id: p.id, label: p.label, note: p.note, enabled: !s.disabledPacks.includes(p.id), items: withSightings(items.filter((i) => i.pack === p.id)) })),
      custom: withSightings(s.custom),
      db: await this.db.meta(),
      alerts: !!(this.deps.ntfyUrl ?? process.env.LOOKOUT_NTFY_URL),
    };
  }

  async recentSightings(limit = 200): Promise<Record<string, unknown>[]> {
    try {
      const text = await fs.readFile(this.file('sightings.ndjson'), 'utf8');
      const lines = text.trim().split('\n');
      return lines.slice(-limit).reverse().map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } }).filter((x): x is Record<string, unknown> => !!x);
    } catch { return []; }
  }
}

let shared: Watchlist | null = null;
export function watchlist(): Watchlist { return (shared ??= new Watchlist()); }
