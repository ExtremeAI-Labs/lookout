/**
 * Lookout — Windy Webcams (api.windy.com/webcams, v3): the largest owner-opt-in public-webcam
 * index in the world, which is the lawful version of "see other people's cameras" — every stream
 * here was published by its operator through a broadcasting network (hotels, marinas, ski areas,
 * cities, businesses). Free tier: commercial use with attribution is fine per Windy support, no
 * daily cap, but listing depth stops at offset 1000 per query and image tokens expire after
 * 10 minutes — so the catalogue keeps the webcam ids and asks Windy for fresh image/player URLs
 * each time a region is (re)built, one county-sized slice at a time.
 *
 * Key: WINDY_WEBCAMS_KEY in the service environment (loaded from your environment by
 * run-console.sh). Without it this source is simply absent — nothing else breaks.
 */
import { createPool } from './fetch-pool';

const BASE = 'https://api.windy.com/webcams/api/v3';
const KEY = () => process.env.WINDY_WEBCAMS_KEY || '';
const pool = createPool(4);

/** Slices of California small enough to stay under the free tier's 1000-offset ceiling. */
export const CA_SLICES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'San Diego',        bbox: [32.5, -117.6, 33.5, -114.4] },
  { name: 'LA / Orange',      bbox: [33.5, -118.95, 34.85, -117.0] },
  { name: 'Inland Empire',    bbox: [33.5, -117.0, 35.0, -114.1] },
  { name: 'Central Coast',    bbox: [34.85, -121.5, 36.4, -119.0] },
  { name: 'Central Valley S', bbox: [35.0, -119.0, 37.0, -117.0] },
  { name: 'Bay Area',         bbox: [36.4, -123.1, 38.4, -121.4] },
  { name: 'Central Valley N', bbox: [37.0, -121.4, 39.5, -117.0] },
  { name: 'Tahoe / Sierra',   bbox: [38.4, -121.4, 40.0, -119.0] },
  { name: 'North Coast',      bbox: [38.4, -124.6, 42.05, -121.4] },
  { name: 'Far North',        bbox: [39.5, -121.4, 42.05, -119.0] },
];

/** The rest of the US, in boxes each small enough to stay under the free tier's 1000-offset ceiling. */
export const US_WEST_NONCA_SLICES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Pacific NW',   bbox: [42.0, -124.8, 49.0, -116.5] },   // OR, WA
  { name: 'Great Basin',  bbox: [35.0, -120.0, 42.0, -114.0] },   // NV, most of it
  { name: 'Mountain SW',  bbox: [31.3, -114.9, 37.0, -108.0] },   // AZ
  { name: 'Rockies',      bbox: [37.0, -114.1, 45.0, -104.0] },   // UT, CO, WY, ID, MT south
  { name: 'North Rockies',bbox: [44.0, -117.3, 49.0, -104.0] },   // MT, ID north
];

export const US_CENTRAL_SLICES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'TX South',     bbox: [25.8, -106.7, 31.0, -97.0] },
  { name: 'TX North',     bbox: [31.0, -106.7, 36.6, -93.5] },
  { name: 'Plains S',     bbox: [33.0, -104.1, 40.0, -94.5] },    // OK, KS
  { name: 'Plains N',     bbox: [40.0, -104.1, 49.0, -96.0] },    // NE, SD, ND
  { name: 'Upper MW',     bbox: [42.5, -97.3, 49.4, -86.5] },     // MN, WI, MI-UP
  { name: 'Great Lakes',  bbox: [36.9, -91.6, 43.5, -80.5] },     // IL, IN, OH, MO, KY
  { name: 'Gulf',         bbox: [29.0, -94.1, 35.0, -84.9] },     // LA, MS, AL, TN, AR
];

export const US_EAST_SLICES: Array<{ name: string; bbox: [number, number, number, number] }> = [
  { name: 'Florida',      bbox: [24.4, -87.7, 31.1, -79.9] },
  { name: 'Deep South',   bbox: [30.3, -85.7, 35.2, -75.4] },     // GA, SC, NC
  { name: 'Mid-Atlantic', bbox: [36.5, -83.7, 40.7, -74.9] },     // VA, WV, MD, DC, DE
  { name: 'Northeast',    bbox: [40.4, -80.6, 45.1, -71.8] },     // PA, NJ, NY
  { name: 'New England',  bbox: [41.0, -73.8, 47.5, -66.9] },     // CT, RI, MA, VT, NH, ME
];

export interface WindyWebcam {
  webcamId: number;
  title: string;
  status?: string;
  lastUpdatedOn?: string;
  location?: { city?: string; region?: string; region_code?: string; country?: string; country_code?: string; latitude: number; longitude: number };
  images?: { current?: { icon?: string; thumbnail?: string; preview?: string }; daylight?: { preview?: string } };
  player?: { live?: string; day?: string; month?: string; year?: string; lifetime?: string };
  urls?: { detail?: string; provider?: string };
  categories?: Array<{ id: string; name: string }>;
}

async function page(bbox: [number, number, number, number], offset: number): Promise<{ total: number; webcams: WindyWebcam[] } | null> {
  const [s, w, n, e] = bbox;
  const qs = new URLSearchParams({
    limit: '50', offset: String(offset), lang: 'en',
    include: 'categories,images,location,player,urls',
    // north-lat,east-lng,south-lat,west-lng per the v3 docs
    bbox: `${n},${e},${s},${w}`,
  });
  try {
    const r = await fetch(`${BASE}/webcams?${qs}`, { headers: { 'x-windy-api-key': KEY() }, signal: AbortSignal.timeout(12_000) });
    if (!r.ok) { console.warn('[windy] HTTP', r.status, 'for', bbox.join(','), 'offset', offset); return null; }
    const d = await r.json();
    return { total: Number(d?.total || 0), webcams: Array.isArray(d?.webcams) ? d.webcams : [] };
  } catch (e) { console.warn('[windy] fetch failed', e instanceof Error ? e.message : e); return null; }
}

/** Every webcam in one slice (paged, bounded by the free tier's offset ceiling). */
export async function windySlice(bbox: [number, number, number, number]): Promise<WindyWebcam[]> {
  const out: WindyWebcam[] = [];
  let offset = 0, total = Infinity;
  while (offset < total && offset <= 1000) {
    const p = await page(bbox, offset);
    if (!p) break;
    total = p.total; out.push(...p.webcams);
    if (p.webcams.length < 50) break;
    offset += 50;
  }
  return out;
}

/**
 * Windy's `player.live` page is a still frame whose ▶ opens a new tab, so it is never embedded.
 * The page that actually holds the operator's player is /webcams/stream/{id}; the viewer resolves
 * that to the inner player (see /api/cctv/resolve) so the stream plays inside Lookout.
 */
export const windyStreamPage = (webcamId: number) => `https://webcams.windy.com/webcams/stream/${webcamId}`;

/**
 * 1,034 of California's 1,072 Windy "live" cams are Caltrans re-hosts, and Caltrans video
 * (wzmedia.dot.ca.gov) is IP-restricted from this network. Calling those LIVE would repeat the
 * 2026-09-13 over-reach; they stay snapshot cameras. Everything else streams from the operator.
 */
export function liveIsPlayableHere(w: WindyWebcam): boolean {
  if (!w.player?.live) return false;
  try { return !/(^|\.)dot\.ca\.gov$/i.test(new URL(w.urls?.provider || 'https://x.invalid').hostname); }
  catch { return true; }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toCatalogueCamera(w: WindyWebcam): any | null {
  const lat = w.location?.latitude, lng = w.location?.longitude;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  const live = liveIsPlayableHere(w);
  const preview = w.images?.current?.preview || w.images?.daylight?.preview || '';
  if (!live && !preview) return null;
  const detail = w.urls?.detail || `https://www.windy.com/webcams/${w.webcamId}`;
  return {
    id: `windy-${w.webcamId}`,
    lat, lng,
    name: w.title || `Webcam ${w.webcamId}`,
    city: w.location?.city || '', country: w.location?.country_code || 'US',
    // LIVE only when the operator's own stream can play here; the still is the freshest frame Windy holds.
    ...(live ? { stream_url: windyStreamPage(w.webcamId), stream_type: 'iframe' } : {}),
    timelapse_url: w.player?.day || undefined,
    feed_url: preview,
    external_url: detail,
    source: 'Windy Webcams',
    attribution: 'Webcams provided by windy.com',
    categories: (w.categories || []).map((c) => c.name),
    last_updated: w.lastUpdatedOn,
  };
}

/**
 * Windy image URLs carry a token that expires 10 minutes after the catalogue fetched them, while the
 * catalogue itself is cached for 30. When the proxy sees a 401/403 from imgproxy.windy.com it asks
 * for the webcam again (one 2 KB call) and retries with the fresh URL — the operator never sees a
 * dead tile because a token aged out.
 */
export function windyIdFromImageUrl(url: string): number | null {
  try {
    const u = new URL(url);
    if (u.hostname !== 'imgproxy.windy.com') return null;
    const m = u.pathname.match(/\/current\/(\d+)\//);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

export async function freshWindyImageUrl(webcamId: number, size: 'preview' | 'thumbnail' | 'icon' = 'preview'): Promise<string | null> {
  if (!KEY()) return null;
  try {
    const r = await fetch(`${BASE}/webcams/${webcamId}?include=images`, { headers: { 'x-windy-api-key': KEY() }, signal: AbortSignal.timeout(8_000) });
    if (!r.ok) return null;
    const d = (await r.json()) as WindyWebcam;
    return d?.images?.current?.[size] || d?.images?.current?.preview || null;
  } catch { return null; }
}

/** The operator's player inside a Windy stream page (`<iframe id="iframe" src="…">`), decoded. */
export function extractWindyInnerPlayer(html: string): string | null {
  const m = html.match(/<iframe[^>]*\ssrc="([^"]+)"/i);
  if (!m) return null;
  const src = m[1].replace(/&#x3D;/g, '=').replace(/&#61;/g, '=').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
  try { const u = new URL(src); return u.protocol === 'https:' ? u.toString() : null; } catch { return null; }
}

export { isWindyStreamUrl } from './camera-feed';

/** Caltrans' streaming host — geo/IP-restricted; a resolved inner player pointing here cannot play. */
export const isBlockedStreamHost = (url: string) => { try { return /(^|\.)dot\.ca\.gov$/i.test(new URL(url).hostname); } catch { return false; } };

/** Owner-published Windy webcams across a set of bbox slices; [] when no key / API down. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function windyCamerasForSlices(slices: Array<{ bbox: [number, number, number, number] }>): Promise<any[]> {
  if (!KEY()) return [];
  const results = await Promise.all(slices.map((s) => pool.run(() => windySlice(s.bbox))));
  const seen = new Set<number>();
  const out = [];
  for (const w of results.flat()) {
    if (seen.has(w.webcamId)) continue;   // slices overlap at their edges
    seen.add(w.webcamId);
    const c = toCatalogueCamera(w);
    if (c) out.push(c);
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const windyCaliforniaCameras = (): Promise<any[]> => windyCamerasForSlices(CA_SLICES);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const windyUSEastCameras = (): Promise<any[]> => windyCamerasForSlices(US_EAST_SLICES);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const windyUSCentralCameras = (): Promise<any[]> => windyCamerasForSlices([...US_CENTRAL_SLICES, ...US_WEST_NONCA_SLICES]);
