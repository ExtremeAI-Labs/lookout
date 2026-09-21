/**
 * Lookout — which catalogue entries can actually be shown, and which are live video.
 *
 * Measured against the live catalogue on 2026-09-13 (23,123 entries):
 *   • Quebec 511 (678 mp4 entries) answers HTTP 403 to every request, with or without a Referer,
 *     from the browser and from the server alike. Dead to us; dropped.
 *   • 27 entries (APRR, AREA) carry an empty feed value and can never load; dropped.
 *
 * CAREFUL — 4,490 entries (THB Taiwan 2,181, DGT 1,917, SkylineWebcams 340, Rijkswaterstaat 52)
 * carry a RELATIVE url of the form `/api/cctv/proxy?url=…`. Those are not broken: the catalogue
 * deliberately pre-routes those hosts through our own image proxy because they need it. An earlier
 * version of this filter required an absolute http(s) URL and silently removed all of them from the
 * map. Same-origin relative feeds are valid — keep them.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Cam = any;

/** Sources measured as hard-blocked. Re-test before adding to (or removing from) this list. */
export const DEAD_SOURCES = new Set<string>(['Quebec 511']);

export function cameraFeedUrl(c: Cam): string {
  return String(c?.stream_url || c?.feed_url || '');
}

export function cameraKind(c: Cam): string {
  if (c?.access_mode === 'operator-page') return 'external';
  return String(c?.stream_type || (c?.feed_url ? 'jpg' : 'none'));
}

/** True live video the browser can play, as opposed to a periodically refreshed still. */
export function isLiveCamera(c: Cam): boolean {
  const k = cameraKind(c);
  return k === 'hls' || k === 'mjpeg' || k === 'mp4' || k === 'iframe'; // iframe = YouTube-live embed
}

/** Absolute http(s), or a same-origin path we serve ourselves (the pre-proxied camera hosts). */
export function isFetchableFeed(u: string): boolean {
  if (/^https?:\/\//i.test(u)) return true;
  return u.startsWith('/');
}

export function isUsableCamera(c: Cam): boolean {
  if (c?.access_mode === 'operator-page') {
    try {
      const url = new URL(c.external_url);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
    } catch { return false; }
  }
  if (!isFetchableFeed(cameraFeedUrl(c))) return false;
  if (DEAD_SOURCES.has(String(c?.source ?? ''))) return false;
  return true;
}

/** Filter a camera list for display; `liveOnly` narrows to real video feeds. */
export function usableCameras(list: Cam[], liveOnly = false): Cam[] {
  const kept = (list || []).filter(isUsableCamera);
  return liveOnly ? kept.filter(isLiveCamera) : kept;
}
