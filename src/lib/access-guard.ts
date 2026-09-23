// Who may talk to the console, decided per request.
//
//   loopback (127.0.0.1 / localhost / [::1]) → allowed. The console binds to loopback
//        (run-console.sh), so only processes on this Mac can arrive this way.
//   the public hostname (LOOKOUT_PUBLIC_HOST) → allowed ONLY with a valid Cloudflare
//        Access token. Cloudflare already bounces unauthenticated visitors at its edge;
//        verifying the signed token here as well means the console still refuses if that
//        Access application is ever deleted or misconfigured while the tunnel rule remains
//        — the failure that once left another of the author's tunnels open. A header's mere presence
//        proves nothing (with no Access app, a visitor could send their own), so the
//        signature, audience, issuer, expiry and e-mail are all checked.
//   anything else (a LAN address, a Bonjour name) → refused.
//
// The Host header is not a security boundary against a LAN client — it can be forged.
// The loopback bind is the boundary; this guard is what makes the tunnel path safe and
// what fails loudly if someone re-opens the bind without thinking.
//
// Uses WebCrypto only, so it runs unchanged in Next's middleware runtime and in vitest.

export type AccessConfig = {
  /** e.g. "lookout.example.com"; empty = no public hostname is served */
  publicHost: string;
  /** e.g. "yourteam.cloudflareaccess.com" */
  teamDomain: string;
  /** the Access application's Audience (AUD) tag */
  audience: string;
  /** lower-cased; empty = any identity the Access policy admitted */
  allowedEmails: string[];
};

export type HostKind = 'loopback' | 'public' | 'other';

/* ── Kit modes (this public tree only) ──
   LOOKOUT_DEMO=1        the hosted showcase: GET/HEAD only, a denylist of everything that writes,
                         reaches a live feed, or needs a key — the same rule the demo always had.
   LOOKOUT_ALLOW_LAN=1   a self-hosted install that wants phones/other machines on the same network
                         to reach it: hosts that are neither loopback nor the public hostname are
                         admitted. Off by default — the loopback bind is the boundary. */
export const DEMO_MODE = process.env.LOOKOUT_DEMO === '1';
export const ALLOW_LAN = process.env.LOOKOUT_ALLOW_LAN === '1';

/** Path prefixes the hosted demo never serves: writes, live feeds, key-bearing routes, the console.
 *  '/api/earthquakes' (USGS), '/api/satellites' (CelesTrak) and '/api/cctv' (the camera catalogue +
 *  YouTube live cams) are deliberately NOT in this list — those three have no non-commercial clause
 *  and no per-viewer cost, so the showcase serves them live (2026-09-23). See DEMO_MODE.md. */
const DEMO_BLOCKED_PREFIXES = [
  '/console', '/fisherman', '/docs',
  '/api/fisherman', '/api/osint', '/api/scanner', '/api/person', '/api/client-cameras', '/api/tracker',
  '/api/cases', '/api/canvass', '/api/watchlist', '/api/watches', '/api/assistant',
  '/api/flights', '/api/aircraft', '/api/maritime', '/api/geosearch',
];
export function isBlockedDemoPath(pathname: string): boolean {
  const p = pathname.toLowerCase();
  return DEMO_BLOCKED_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
}
const SAFE_METHODS = new Set(['GET', 'HEAD']);
export function isSafeMethod(method: string): boolean { return SAFE_METHODS.has(method.toUpperCase()); }

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

function hostname(hostHeader: string | null): string {
  const h = (hostHeader || '').trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1); // [::1]:4610
  return h.split(':')[0];
}

export function classifyHost(hostHeader: string | null, publicHost: string): HostKind {
  const h = hostname(hostHeader);
  if (LOOPBACK.has(h)) return 'loopback';
  if (publicHost && h === publicHost.trim().toLowerCase()) return 'public';
  return 'other';
}

export function readAccessConfig(env: Record<string, string | undefined>): AccessConfig {
  return {
    publicHost: (env.LOOKOUT_PUBLIC_HOST || '').trim().toLowerCase(),
    teamDomain: (env.LOOKOUT_CF_TEAM_DOMAIN || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, ''),
    audience: (env.LOOKOUT_CF_ACCESS_AUD || '').trim(),
    allowedEmails: (env.LOOKOUT_ALLOWED_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
  };
}

type Jwk = JsonWebKey & { kid?: string };
export type JwksFetcher = (url: string) => Promise<{ keys: Jwk[] }>;

const JWKS_TTL_MS = 10 * 60 * 1000;
let jwksCache: { url: string; at: number; keys: Jwk[] } | null = null;

const defaultFetchJwks: JwksFetcher = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`certs ${res.status}`);
  return res.json();
};

async function signingKeys(url: string, fetchJwks: JwksFetcher, now: number, forceRefresh: boolean): Promise<Jwk[]> {
  if (!forceRefresh && jwksCache && jwksCache.url === url && now - jwksCache.at < JWKS_TTL_MS) return jwksCache.keys;
  const { keys } = await fetchJwks(url);
  jwksCache = { url, at: now, keys: Array.isArray(keys) ? keys : [] };
  return jwksCache.keys;
}

function b64urlBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = atob(pad);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const b64urlJson = (s: string) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

export type AccessVerdict = { ok: true; email: string } | { ok: false; reason: string };

export async function verifyAccessJwt(
  token: string | null | undefined,
  config: AccessConfig,
  { now = Date.now(), fetchJwks = defaultFetchJwks }: { now?: number; fetchJwks?: JwksFetcher } = {},
): Promise<AccessVerdict> {
  // Misconfiguration must read as "closed", never as "nothing to check".
  if (!config.teamDomain || !config.audience) return { ok: false, reason: 'access verification is not configured' };
  if (!token) return { ok: false, reason: 'no access token' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed token' };

  let header: { alg?: string; kid?: string };
  let claims: { aud?: string | string[]; iss?: string; exp?: number; nbf?: number; email?: string };
  try {
    header = b64urlJson(parts[0]);
    claims = b64urlJson(parts[1]);
  } catch {
    return { ok: false, reason: 'malformed token' };
  }
  // Pin the algorithm: never let the token choose how it is verified.
  if (header.alg !== 'RS256' || !header.kid) return { ok: false, reason: 'unexpected algorithm' };

  const certsUrl = `https://${config.teamDomain}/cdn-cgi/access/certs`;
  let jwk: Jwk | undefined;
  try {
    jwk = (await signingKeys(certsUrl, fetchJwks, now, false)).find((k) => k.kid === header.kid);
    // Cloudflare rotates keys; an unknown kid earns exactly one refetch.
    if (!jwk) jwk = (await signingKeys(certsUrl, fetchJwks, now, true)).find((k) => k.kid === header.kid);
  } catch (e) {
    return { ok: false, reason: `could not load signing keys: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!jwk) return { ok: false, reason: 'unknown signing key' };

  let valid = false;
  try {
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch {
    return { ok: false, reason: 'signature check failed' };
  }
  if (!valid) return { ok: false, reason: 'bad signature' };

  const aud = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
  if (!aud.includes(config.audience)) return { ok: false, reason: 'token is for a different application' };
  if (claims.iss !== `https://${config.teamDomain}`) return { ok: false, reason: 'unexpected issuer' };
  const nowSec = Math.floor(now / 1000);
  if (typeof claims.exp !== 'number' || claims.exp <= nowSec) return { ok: false, reason: 'token expired' };
  if (typeof claims.nbf === 'number' && claims.nbf > nowSec + 60) return { ok: false, reason: 'token not yet valid' };

  const email = (claims.email || '').toLowerCase();
  if (config.allowedEmails.length && !config.allowedEmails.includes(email)) return { ok: false, reason: 'identity not allowed' };
  return { ok: true, email };
}

/** Test seam: forget cached signing keys. */
export function resetAccessKeyCache() {
  jwksCache = null;
}
