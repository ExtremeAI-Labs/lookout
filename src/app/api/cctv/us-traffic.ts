/** Official, keyless traffic-camera catalogs. No stream extraction or access workarounds. */
import type { CctvCamera } from './types';
import { createHash } from 'node:crypto';

export const CALTRANS_LAYER = 'https://caltrans-gis.dot.ca.gov/arcgis/rest/services/CHhighway/CCTV/FeatureServer/0';
export const WSDOT_LAYER = 'https://data.wsdot.wa.gov/arcgis/rest/services/TravelInformation/TravelInfoCamerasWeather/FeatureServer/0';
export const CALTRANS_DISTRICT_7 = 'https://cwwp2.dot.ca.gov/data/d7/cctv/cctvStatusD07.json';

interface Feature {
  attributes: Record<string, unknown>;
  geometry?: { x?: number; y?: number };
}

/** ArcGIS silently truncates the default response at 2,000 records. Fetch every page in order.
 * A failed/repeated page throws so the region can retain its previous catalog, not save half one.
 * The deadline covers the entire source, including response bodies. */
export async function fetchCameraFeatures(layer: string, fields: string, request: typeof fetch = fetch): Promise<Feature[]> {
  const signal = AbortSignal.timeout(25_000);
  const features: Feature[] = [];
  const ids = new Set<number>();
  for (let page = 0; page < 20; page++) {
    const url = new URL(`${layer}/query`);
    url.search = new URLSearchParams({
      where: '1=1', outFields: fields, outSR: '4326', f: 'json',
      orderByFields: 'OBJECTID ASC', resultOffset: String(features.length), resultRecordCount: '2000',
    }).toString();
    const res = await request(url, { signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Traffic catalog HTTP ${res.status}`);
    const data = await res.json();
    if (data.error || !Array.isArray(data.features)) throw new Error('Invalid traffic catalog response');
    if (!data.features.length && (page === 0 || data.exceededTransferLimit)) throw new Error('Empty traffic catalog page');
    for (const feature of data.features as Feature[]) {
      const id = feature?.attributes?.OBJECTID;
      if (typeof id !== 'number' || !Number.isFinite(id) || ids.has(id)) {
        throw new Error('Invalid or repeated traffic catalog page');
      }
      ids.add(id);
      features.push(feature);
    }
    if (!data.exceededTransferLimit) return features;
  }
  throw new Error('Traffic catalog pagination limit reached');
}

function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }

function imageUrl(value: unknown): string | undefined {
  try {
    const url = new URL(text(value));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
    return url.toString();
  } catch { return; }
}

function coordinates(lat: unknown, lng: unknown, bounds: [number, number, number, number]): { lat: number; lng: number } | undefined {
  if (lat === null || lng === null || lat === '' || lng === '') return;
  const y = Number(lat), x = Number(lng);
  if (!Number.isFinite(y) || !Number.isFinite(x) || y < bounds[0] || y > bounds[1] || x < bounds[2] || x > bounds[3]) return;
  return { lat: y, lng: x };
}

export async function fetchCaltransCameras(request: typeof fetch = fetch): Promise<CctvCamera[]> {
  const features = await fetchCameraFeatures(CALTRANS_LAYER,
    'OBJECTID,latitude,longitude,locationName,nearbyPlace,county,currentImageURL', request);
  const cameras = features.flatMap(({ attributes: p }) => {
    const position = coordinates(p.latitude, p.longitude, [32, 43, -125, -114]);
    const feed = imageUrl(p.currentImageURL);
    if (!position || !feed) return [];
    return [{
      id: `cal-${p.OBJECTID}`, ...position,
      name: text(p.locationName) || 'Caltrans', city: text(p.nearbyPlace) || text(p.county) || 'California',
      country: 'US', feed_url: feed, stream_type: 'jpg' as const, source: 'Caltrans',
      external_url: 'https://cwwp2.dot.ca.gov/vm/iframemap.htm',
    }];
  });
  // District 7's wholesale file includes LA/Ventura cameras missing from the GIS mirror.
  // Prefer that district's current list when available; retain statewide coverage if it fails.
  try {
    const res = await request(CALTRANS_DISTRICT_7, { signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json' } });
    if (!res.ok) return cameras;
    return mergeDistrictSeven(cameras, await res.json());
  } catch { return cameras; }
}

/** Replace only District 7; preserve existing camera ids where the image URL still matches.
 * "inService" is a provider report, not a guarantee that the JPEG is current or free of outage cards. */
export function mergeDistrictSeven(base: CctvCamera[], data: unknown): CctvCamera[] {
  const rows = (data as { data?: Array<{ cctv?: {
    inService?: string | boolean;
    location?: { district?: string; latitude?: string; longitude?: string; locationName?: string; nearbyPlace?: string };
    imageData?: { static?: { currentImageURL?: string } };
  } }> })?.data;
  if (!Array.isArray(rows) || !rows.length) return base;
  const existing = new Map(base.map(c => [c.feed_url, c]));
  const district = new Map<string, CctvCamera>();
  let validRows = 0;
  for (const { cctv: c } of rows) {
    if (!c || String(c.location?.district) !== '7') continue;
    const position = coordinates(c.location?.latitude, c.location?.longitude, [33, 35.5, -120, -117]);
    const feed = imageUrl(c.imageData?.static?.currentImageURL);
    if (!position || !feed || !feed.startsWith('https://cwwp2.dot.ca.gov/data/d7/cctv/')) continue;
    if (!['true', 'false'].includes(String(c.inService).toLowerCase())) continue;
    validRows++;
    if (String(c.inService).toLowerCase() !== 'true') continue;
    district.set(feed, {
      id: existing.get(feed)?.id || `cal-d7-${createHash('sha256').update(feed).digest('hex').slice(0, 16)}`,
      ...position, name: text(c.location?.locationName) || 'Caltrans District 7',
      city: text(c.location?.nearbyPlace) || 'Los Angeles / Ventura', country: 'US',
      feed_url: feed, stream_type: 'jpg', source: 'Caltrans',
      external_url: 'https://cwwp2.dot.ca.gov/vm/iframemap.htm',
    });
  }
  if (!validRows) return base;
  return [...base.filter(c => !c.feed_url?.includes('/data/d7/cctv/')), ...district.values()];
}

/** The previous data.wsdot.wa.gov/log/public/cameras.json endpoint is gone (404).
 * This official GIS layer provides WGS84 coordinates and periodically refreshed stills. */
export async function fetchWSDOTCameras(request: typeof fetch = fetch): Promise<CctvCamera[]> {
  const features = await fetchCameraFeatures(WSDOT_LAYER, 'OBJECTID,CameraTitle,ImageURL', request);
  return features.flatMap(({ attributes: p, geometry }) => {
    const position = coordinates(geometry?.y, geometry?.x, [45, 50, -125, -116]);
    const feed = imageUrl(p.ImageURL);
    if (!position || !feed) return [];
    return [{
      id: `wsdot-${p.OBJECTID}`, ...position,
      name: text(p.CameraTitle) || 'WSDOT Camera', city: 'Washington', country: 'US',
      feed_url: feed, stream_type: 'jpg' as const, source: 'WSDOT',
      external_url: 'https://wsdot.com/travel/real-time/map/',
    }];
  });
}
