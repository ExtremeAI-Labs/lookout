/**
 * Lookout — camera CANVASS layer: where the cameras are, not what they see.
 *
 * OpenStreetMap volunteers have mapped ~27,000 surveillance cameras in California (4,500 in LA
 * County) as `man_made=surveillance` nodes, often with the camera's type, zone, mount, direction and
 * operator. For a PI that is the useful half of "security cameras from commercial buildings": you
 * cannot lawfully watch someone's private camera, but you CAN know it exists, whose it is, and
 * which way it points — then ask for the footage (preservation letter → subpoena). This module
 * pulls the whole state from Overpass in small boxes (one giant query times out), keeps a weekly
 * snapshot on disk, and answers radius / bbox questions from memory.
 */
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

export interface OsmCamera {
  id: number;
  lat: number;
  lng: number;
  /** surveillance:type — camera | guard | ALPR | … */
  type: string;
  /** surveillance:zone — traffic | parking | shop | building | town | … */
  zone: string;
  /** surveillance — public | outdoor | indoor */
  scope: string;
  /** camera:mount — pole | wall | ceiling | … */
  mount: string;
  /** camera:direction in degrees, when mapped */
  direction: number | null;
  /** camera:type — fixed | dome | panning */
  cameraType: string;
  operator: string;
  name: string;
}

export const SNAPSHOT_PATH = path.join(process.env.LOOKOUT_DATA_DIR || path.join(os.homedir(), '.lookout'), 'osm-cameras-ca.json');
const SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // a week — mappers are slow and so is Overpass

const CA = { south: 32.5, west: -124.6, north: 42.05, east: -114.1 };
const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

/** Latitude bands × two longitude halves: each box answers in seconds instead of timing out. */
function boxes(): Array<[number, number, number, number]> {
  const bands = [32.5, 34.0, 35.0, 36.0, 37.0, 37.6, 38.2, 39.0, 40.0, 41.0, CA.north];
  const out: Array<[number, number, number, number]> = [];
  for (let i = 0; i < bands.length - 1; i++) {
    out.push([bands[i], CA.west, bands[i + 1], -119.5]);
    out.push([bands[i], -119.5, bands[i + 1], CA.east]);
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeNode(el: any): OsmCamera | null {
  if (typeof el?.lat !== 'number' || typeof el?.lon !== 'number') return null;
  const t = el.tags || {};
  const dir = t['camera:direction'];
  const dirNum = dir === undefined ? NaN : Number(String(dir).split(/[;,\-]/)[0]);
  return {
    id: el.id,
    lat: el.lat,
    lng: el.lon,
    type: t['surveillance:type'] || '',
    zone: t['surveillance:zone'] || '',
    scope: t['surveillance'] || '',
    mount: t['camera:mount'] || '',
    direction: Number.isFinite(dirNum) ? dirNum : null,
    cameraType: t['camera:type'] || '',
    operator: t['operator'] || '',
    name: t['name'] || '',
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One Overpass box with mirror rotation and back-off. Throws only when every attempt failed. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchBox(box: [number, number, number, number]): Promise<any[]> {
  const q = `[out:json][timeout:120];node["man_made"="surveillance"](${box.join(',')});out body;`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = `${MIRRORS[attempt % MIRRORS.length]}?data=${encodeURIComponent(q)}`;
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'lookout-canvass/1.0' }, signal: AbortSignal.timeout(150_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      if (!Array.isArray(d?.elements)) throw new Error('no elements');
      return d.elements;
    } catch (e) {
      lastErr = e;
      await sleep(8_000 + 8_000 * attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export interface CameraSnapshot { fetched: string; cameras: OsmCamera[]; boxesFailed: number }

/** Pull every California camera from Overpass. Slow (minutes) — callers cache the result. */
export async function fetchCaliforniaCameras(): Promise<CameraSnapshot> {
  const seen = new Map<number, OsmCamera>();
  let boxesFailed = 0;
  for (const box of boxes()) {
    try {
      for (const el of await fetchBox(box)) {
        const c = normalizeNode(el);
        if (c) seen.set(c.id, c);
      }
    } catch (e) {
      boxesFailed++;
      console.warn('[canvass] Overpass box failed', box.join(','), e instanceof Error ? e.message : e);
    }
    await sleep(3_000);   // be a polite Overpass citizen
  }
  return { fetched: new Date().toISOString(), cameras: [...seen.values()], boxesFailed };
}

let memo: CameraSnapshot | null = null;
let inflight: Promise<CameraSnapshot> | null = null;

async function readSnapshot(): Promise<CameraSnapshot | null> {
  try {
    const s = JSON.parse(await fs.readFile(SNAPSHOT_PATH, 'utf8')) as CameraSnapshot;
    return Array.isArray(s?.cameras) && s.cameras.length ? s : null;
  } catch { return null; }
}

async function writeSnapshot(s: CameraSnapshot): Promise<void> {
  await fs.mkdir(path.dirname(SNAPSHOT_PATH), { recursive: true });
  const tmp = `${SNAPSHOT_PATH}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(s));
  await fs.rename(tmp, SNAPSHOT_PATH);
}

function isFresh(s: CameraSnapshot): boolean {
  return Date.now() - Date.parse(s.fetched) < SNAPSHOT_TTL_MS;
}

export class SnapshotWarming extends Error {
  constructor() { super('Camera snapshot is being built from OpenStreetMap — try again in a few minutes'); this.name = 'SnapshotWarming'; }
}

/**
 * The camera set, from memory → disk → Overpass. A stale snapshot is served immediately while a
 * refresh runs behind it. With no snapshot at all the pull is started in the background and the
 * caller gets SnapshotWarming (a request must never sit on a multi-minute Overpass crawl); pass
 * `waitForCold` to block instead (scripts, tests).
 */
export async function californiaCameras({ waitForCold = false }: { waitForCold?: boolean } = {}): Promise<CameraSnapshot> {
  if (memo && isFresh(memo)) return memo;
  if (!memo) memo = await readSnapshot();
  if (memo && isFresh(memo)) return memo;
  if (!inflight) {
    inflight = fetchCaliforniaCameras()
      .then(async (s) => {
        // Never replace a good snapshot with a badly failed refresh (Overpass has bad days).
        if (s.cameras.length && (!memo || s.cameras.length > memo.cameras.length * 0.8)) {
          memo = s;
          await writeSnapshot(s).catch((e) => console.warn('[canvass] snapshot write failed', e));
        }
        return memo ?? s;
      })
      .finally(() => { inflight = null; });
  }
  if (memo) return memo;      // stale but present: serve now, refresh in the background
  if (waitForCold) return inflight;
  inflight.catch(() => { /* logged per box above; the next request retries */ });
  throw new SnapshotWarming();
}

/** Great-circle distance in metres. */
export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export interface NearbyCamera extends OsmCamera { distanceM: number; bearingDeg: number }

/** Bearing from the point to the camera (so the letter can say "north-east corner"). */
export function bearingDeg(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(lng2 - lng1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lng2 - lng1));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

export function camerasNear(cams: OsmCamera[], lat: number, lng: number, radiusM: number): NearbyCamera[] {
  // Cheap bbox pre-filter before the trig — 27k points per click otherwise.
  const dLat = radiusM / 111_000, dLng = radiusM / (111_000 * Math.cos((lat * Math.PI) / 180));
  return cams
    .filter((c) => Math.abs(c.lat - lat) <= dLat && Math.abs(c.lng - lng) <= dLng)
    .map((c) => ({ ...c, distanceM: haversineM(lat, lng, c.lat, c.lng), bearingDeg: bearingDeg(lat, lng, c.lat, c.lng) }))
    .filter((c) => c.distanceM <= radiusM)
    .sort((a, b) => a.distanceM - b.distanceM);
}

export function compass(deg: number): string {
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];
}
