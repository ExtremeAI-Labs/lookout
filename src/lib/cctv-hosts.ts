/**
 * Lookout — the camera-image proxy's allowlist, derived from the camera catalogue itself.
 *
 * Michael's call (2026-09-13): allow the hosts that actually appear in the catalogue, rather than
 * a hand-kept list (too narrow — it excluded Caltrans' 2,000 cameras) or anything public (an open
 * relay on his machine). The proxy ALSO runs the SSRF guard, so a catalogue entry that resolved to
 * a private or reserved address still cannot be fetched.
 */
import { readSnapshot } from './cctv-snapshot';

/** Seeds kept from the original hand-written list: hosts needing special handling. */
export const STATIC_HOSTS = [
  // Windy Webcams stills + players (first-class source; the catalogue-derived list lags a cold boot)
  'imgproxy.windy.com',
  'webcams.windy.com',
  'cdn.skylinewebcams.com',
  'cdn2.skylinewebcams.com',
  's3-eu-west-1.amazonaws.com',
  'voyage.aprr.fr',
  'stream.inmoves.nl',
  'thb.gov.tw',
  'etraffic.dgt.es',
];

// Known official stills work before a disk catalog is written; no subdomain wildcard grant.
const EXACT_SEED_HOSTS = ['cwwp2.dot.ca.gov', 'images.wsdot.wa.gov', 'www.tripcheck.com'];

const TTL_MS = 10 * 60_000;
let cache: { at: number; hosts: Set<string> } | null = null;

export async function allowedCameraHosts(): Promise<Set<string>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.hosts;
  const hosts = new Set<string>([...STATIC_HOSTS, ...EXACT_SEED_HOSTS]);
  try {
    const snap = await readSnapshot();
    for (const list of Object.values(snap?.regions ?? {})) {
      for (const cam of (list as unknown[]) ?? []) {
        const c = cam as { stream_url?: unknown; feed_url?: unknown };
        // A camera may have a stream AND a preview on a different host. Include both.
        for (const u of [c?.stream_url, c?.feed_url]) {
          if (typeof u !== 'string' || !u) continue;
          try { hosts.add(new URL(u).hostname.toLowerCase()); } catch { /* not a URL */ }
        }
      }
    }
  } catch { /* no snapshot yet — the seeds still work */ }
  cache = { at: Date.now(), hosts };
  return hosts;
}

/** Exact match against the catalogue; subdomain match only for the curated seeds. */
export function hostAllowed(hostname: string, hosts: Set<string>): boolean {
  const h = hostname.toLowerCase();
  if (hosts.has(h)) return true;
  return STATIC_HOSTS.some((s) => h === s || h.endsWith('.' + s));
}
