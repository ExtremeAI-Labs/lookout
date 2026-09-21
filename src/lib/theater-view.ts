// The 3D theater's camera, as it travels in a URL. The flat map hands a position
// to the theater ("open here in 3D") through these query params, and the theater
// writes them back as the camera moves, so a reload or a shared link lands on the
// same view. Every value is clamped: the params are user-editable text.

export type TheaterView = {
  lat: number;
  lng: number;
  /** camera height above the ellipsoid, metres */
  alt: number;
  /** degrees clockwise from north */
  heading: number;
  /** degrees; -90 looks straight down, 0 looks at the horizon */
  pitch: number;
};

// Downtown Los Angeles from a helicopter's height: close enough that photoreal
// tiles are obviously photoreal, far enough that the first frame is not a wall.
export const DEFAULT_THEATER_VIEW: TheaterView = { lat: 34.0522, lng: -118.2437, alt: 1800, heading: 0, pitch: -35 };

export const THEATER_ALT_MIN = 50;
export const THEATER_ALT_MAX = 40_000_000;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function num(raw: string | null, fallback: number): number {
  if (raw === null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function parseTheaterView(params: URLSearchParams, fallback: TheaterView = DEFAULT_THEATER_VIEW): TheaterView {
  const heading = num(params.get('heading'), fallback.heading) % 360;
  return {
    lat: clamp(num(params.get('lat'), fallback.lat), -90, 90),
    lng: clamp(num(params.get('lng'), fallback.lng), -180, 180),
    alt: clamp(num(params.get('alt'), fallback.alt), THEATER_ALT_MIN, THEATER_ALT_MAX),
    heading: heading < 0 ? heading + 360 : heading,
    pitch: clamp(num(params.get('pitch'), fallback.pitch), -90, 0),
  };
}

export function theaterViewToSearch(view: TheaterView): string {
  const p = new URLSearchParams({
    lat: view.lat.toFixed(5),
    lng: view.lng.toFixed(5),
    alt: String(Math.round(view.alt)),
    heading: String(Math.round(view.heading)),
    pitch: String(Math.round(view.pitch)),
  });
  return `?${p.toString()}`;
}

/** A flat-map zoom level is a scale, not a height. This is the height at which
 *  the theater shows roughly the same ground as MapLibre does at that zoom. */
export function altitudeForZoom(zoom: number, lat: number): number {
  const metresPerPixel = (156_543.03392 * Math.cos((clamp(lat, -85, 85) * Math.PI) / 180)) / 2 ** clamp(zoom, 0, 22);
  return clamp(metresPerPixel * 900, THEATER_ALT_MIN, THEATER_ALT_MAX);
}

/** The inverse, for handing a theater view back to the flat map. */
export function zoomForAltitude(alt: number, lat: number): number {
  const equator = 156_543.03392 * Math.cos((clamp(lat, -85, 85) * Math.PI) / 180);
  return clamp(Math.log2((equator * 900) / clamp(alt, THEATER_ALT_MIN, THEATER_ALT_MAX)), 0, 22);
}
