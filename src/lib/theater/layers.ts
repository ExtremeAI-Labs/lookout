// What the 3D theater can draw, described once without any engine in the room.
// The flat map and the theater read the SAME /api routes; each engine only owns the
// drawing. Keys match the flat map's `?layers=` names so a share link means the same
// thing on either surface.

// 'tracks' is the recorded-history layer: driven by the HISTORY panel (a time window), not a
// live feed, so it has no row in THEATER_LAYERS and never lands in the ?layers= param.
export type TheaterLayerId = 'flights' | 'military' | 'vessels' | 'satellites' | 'cctv' | 'canvass' | 'earthquakes' | 'tracks';

export type TheaterLayerDef = {
  id: TheaterLayerId;
  label: string;
  group: 'AVIATION' | 'MARITIME' | 'SPACE' | 'SURVEIL' | 'HAZARD';
  /** the /api route that feeds it (canvass is fetched around the camera, see fetchCanvassQuery) */
  endpoint: string;
  /** how often to re-fetch while on; 0 = once per toggle */
  refreshMs: number;
  defaultOn: boolean;
  /** what the record count in the panel is counting */
  countNoun: string;
  /** honest provenance line shown under the toggle */
  source: string;
};

/** Hosted demo (NEXT_PUBLIC_LOOKOUT_DEMO=1): PER LAYER, not a blanket switch. Aircraft feeds are
 *  non-commercial (adsb.fi/OpenSky, 1 req/s) and maritime needs a paid AIS_API_KEY, so those keep
 *  reading the bundled synthetic samples under /sample-data/ and say so in the source line.
 *  Earthquakes (USGS), satellites (CelesTrak) and cameras (the /api/cctv catalogue, incl. YouTube
 *  live cams) have no non-commercial clause and no per-viewer cost, so the showcase calls their
 *  live routes even in demo mode — see DEMO_MODE.md. */
export const DEMO_MODE = process.env.NEXT_PUBLIC_LOOKOUT_DEMO === '1';
const feed = (live: string, sample: string) => (DEMO_MODE ? `/sample-data/${sample}.json` : live);
const src = (live: string) => (DEMO_MODE ? 'Synthetic sample data (offline demo)' : live);

export const THEATER_LAYERS: TheaterLayerDef[] = [
  { id: 'flights', label: 'Aircraft', group: 'AVIATION', endpoint: feed('/api/flights', 'flights'), refreshMs: 45_000, defaultOn: true, countNoun: 'aircraft', source: src('OpenSky Network · adsb.fi') },
  { id: 'military', label: 'Military', group: 'AVIATION', endpoint: feed('/api/flights', 'flights'), refreshMs: 45_000, defaultOn: true, countNoun: 'aircraft', source: src('adsb.fi /mil') },
  { id: 'vessels', label: 'Ships & ports', group: 'MARITIME', endpoint: '/api/maritime', refreshMs: 60_000, defaultOn: false, countNoun: 'vessels', source: 'AIS via aisstream.io (needs AIS_API_KEY) · major ports & chokepoints curated' },
  { id: 'satellites', label: 'Satellites', group: 'SPACE', endpoint: '/api/satellites', refreshMs: 60_000, defaultOn: false, countNoun: 'objects', source: 'CelesTrak TLEs, propagated here' },
  { id: 'cctv', label: 'Cameras', group: 'SURVEIL', endpoint: '/api/cctv', refreshMs: 0, defaultOn: false, countNoun: 'cameras', source: 'DOT feeds · Windy · owner-published' },
  { id: 'canvass', label: 'Canvass devices', group: 'SURVEIL', endpoint: '/api/canvass', refreshMs: 0, defaultOn: false, countNoun: 'devices', source: 'OpenStreetMap / DeFlock, within 1.5 km of the view' },
  { id: 'earthquakes', label: 'Earthquakes', group: 'HAZARD', endpoint: '/api/earthquakes', refreshMs: 300_000, defaultOn: false, countNoun: 'events', source: 'USGS, last 24 h' },
];

const IDS = new Set<string>([...THEATER_LAYERS.map((l) => l.id), 'tracks']);

export function isTheaterLayerId(x: string): x is TheaterLayerId {
  return IDS.has(x);
}

/** `?layers=a,b` → the set of layers to show; unknown names are ignored, absent = defaults. */
export function parseLayerParam(raw: string | null): Set<TheaterLayerId> {
  if (raw === null) return new Set(THEATER_LAYERS.filter((l) => l.defaultOn).map((l) => l.id));
  const out = new Set<TheaterLayerId>();
  for (const part of raw.split(',')) {
    const k = part.trim();
    if (isTheaterLayerId(k)) out.add(k);
  }
  return out;
}

export function serializeLayerParam(active: Set<TheaterLayerId>): string {
  return THEATER_LAYERS.map((l) => l.id).filter((id) => active.has(id)).join(',');
}

/** A thing the theater has drawn that can be listed, picked and flown to. */
export type TheaterContact = {
  layer: TheaterLayerId;
  id: string;
  name: string;
  lat: number;
  lng: number;
  /** metres above the ellipsoid, 0 for ground objects */
  alt: number;
  kind: string;
  detail?: string;
};

export type NearbyContact = TheaterContact & { distanceKm: number; bearingDeg: number };

const R = 6371.0088;
const toRad = (d: number) => (d * Math.PI) / 180;

export function distanceKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function bearingDeg(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const y = Math.sin(toRad(bLng - aLng)) * Math.cos(toRad(bLat));
  const x = Math.cos(toRad(aLat)) * Math.sin(toRad(bLat)) - Math.sin(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.cos(toRad(bLng - aLng));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Everything within `km` of a point, nearest first — the contacts panel's question. */
export function nearbyContacts(contacts: Iterable<TheaterContact>, lat: number, lng: number, km: number, limit = 200): NearbyContact[] {
  const out: NearbyContact[] = [];
  for (const c of contacts) {
    const d = distanceKm(lat, lng, c.lat, c.lng);
    if (d <= km) out.push({ ...c, distanceKm: d, bearingDeg: bearingDeg(lat, lng, c.lat, c.lng) });
  }
  out.sort((a, b) => a.distanceKm - b.distanceKm);
  return out.slice(0, limit);
}

/** The canvass feed is queried around the view, never wholesale (27k devices statewide). */
export function fetchCanvassQuery(lat: number, lng: number): string {
  return `/api/canvass?lat=${lat.toFixed(5)}&lng=${lng.toFixed(5)}&radius=1500`;
}

/** Above this the canvass layer shows nothing: a 1.5 km ring is meaningless from 20 km up. */
export const CANVASS_MAX_ALT_M = 6000;

export function formatAltitude(m: number): string {
  if (!Number.isFinite(m)) return '—';
  if (m >= 100_000) return `${Math.round(m / 1000).toLocaleString()} km`;
  return `${Math.round(m * 3.28084).toLocaleString()} ft`;
}
