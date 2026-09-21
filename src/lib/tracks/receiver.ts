// The operator's own receiver — readsb / dump1090-fa / tar1090 `aircraft.json`, read exactly as
// its README-json documents it (wiedehopf/readsb, README-json.md): `now` in seconds, one object
// per aircraft, keys omitted when unknown, `alt_baro` a number OR the string "ground",
// `seen_pos` = seconds since the position was last updated. This is the ONLY source the track
// recorder accepts: OpenSky's terms forbid recording, adsb.fi's licence is display-only.

export type Fix = {
  /** 24-bit ICAO hex, lowercase; a leading '~' marks a non-ICAO (TIS-B / anonymised) address */
  hex: string;
  /** ms since epoch when the position was current (receiver `now` minus `seen_pos`) */
  t: number;
  lat: number;
  lng: number;
  /** barometric feet (geometric when baro is missing); 0 on the ground; null when unknown */
  altFt: number | null;
  ground: boolean;
  gsKt?: number;
  trackDeg?: number;
  callsign?: string;
  reg?: string;
  typeCode?: string;
  nacP?: number;
  /** readsb `type`: adsb_icao, mlat, tisb_icao, … */
  source?: string;
  /** readsb dbFlags & 1 (only with --db-file) */
  military?: boolean;
};

/** Positions older than this are not "now" — readsb keeps aircraft listed for 60 s after the last message. */
export const MAX_POSITION_AGE_S = 30;

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown, max = 16): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().slice(0, max);
  return s || undefined;
};

export type ParsedReceiver = { fixes: Fix[]; nowMs: number; total: number; withPosition: number; stale: number };

/** Never throws; malformed entries are skipped, not guessed. */
export function parseAircraftJson(json: unknown, receivedAtMs = Date.now()): ParsedReceiver {
  const root = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const nowS = num(root.now);
  const nowMs = nowS !== undefined && nowS > 1e9 ? Math.round(nowS * 1000) : receivedAtMs;
  const list = Array.isArray(root.aircraft) ? (root.aircraft as unknown[]) : [];
  const fixes: Fix[] = [];
  let withPosition = 0, stale = 0;
  for (const item of list) {
    const a = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const hexRaw = str(a.hex, 8)?.toLowerCase();
    const lat = num(a.lat), lng = num(a.lon);
    if (!hexRaw || !/^~?[0-9a-f]{6}$/.test(hexRaw) || lat === undefined || lng === undefined || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    withPosition++;
    const seenPos = num(a.seen_pos) ?? 0;
    if (seenPos > MAX_POSITION_AGE_S) { stale++; continue; }
    const ground = a.alt_baro === 'ground';
    const altFt = ground ? 0 : num(a.alt_baro) ?? num(a.alt_geom) ?? null;
    const fix: Fix = { hex: hexRaw, t: nowMs - Math.round(seenPos * 1000), lat, lng, altFt, ground };
    const gs = num(a.gs), track = num(a.track), nacP = num(a.nac_p);
    if (gs !== undefined) fix.gsKt = gs;
    if (track !== undefined) fix.trackDeg = ((track % 360) + 360) % 360;
    if (nacP !== undefined) fix.nacP = nacP;
    const callsign = str(a.flight, 8);
    if (callsign) fix.callsign = callsign;
    const reg = str(a.r, 12);
    if (reg) fix.reg = reg;
    const typeCode = str(a.t, 6);
    if (typeCode) fix.typeCode = typeCode;
    const source = str(a.type, 16);
    if (source) fix.source = source;
    const flags = num(a.dbFlags);
    if (flags !== undefined && (flags & 1) === 1) fix.military = true;
    fixes.push(fix);
  }
  return { fixes, nowMs, total: list.length, withPosition, stale };
}

const R_EARTH_KM = 6371;
export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}
