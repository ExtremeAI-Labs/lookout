// Adapted from God's Eye View (github.com/bilawalsidhu/gods-eye-view), MIT © 2026 Bilawal Sidhu.
/**
 * Small pure geodesic + heading primitives shared by the theater cockpit
 * camera math and the dead-reckoning motion model. Spherical approximation
 * (mean Earth radius) — well inside the precision of the ADS-B/AIS fixes
 * these serve, and keeps the formulas exact, cheap, and easy to check.
 */

const EARTH_RADIUS_M = 6_371_000;

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

export interface LatLng {
  lat: number;
  lng: number;
}

/** Normalize a heading into the [0, 360) range. Non-finite input reads as 0. */
export function normalizeHeading(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return ((value % 360) + 360) % 360;
}

/** Shortest signed delta from `fromDeg` to `toDeg`, in the [-180, 180) range. */
export function shortestHeadingDelta(fromDeg: number, toDeg: number): number {
  const from = normalizeHeading(fromDeg);
  const to = normalizeHeading(toDeg);
  return ((to - from + 540) % 360) - 180;
}

/** Great-circle distance between two points, in metres. */
export function distanceMetres(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Initial great-circle bearing from (lat1,lng1) to (lat2,lng2), degrees
 * clockwise from north, in [0, 360).
 */
export function bearingBetween(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lng2 - lng1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return normalizeHeading(toDeg(Math.atan2(y, x)));
}

/**
 * The point `metres` from (lat,lng) along `bearingDeg`. A negative `metres`
 * lands on the opposite bearing, so callers never need to special-case it.
 */
export function destinationPoint(lat: number, lng: number, bearingDeg: number, metres: number): LatLng {
  const δ = metres / EARTH_RADIUS_M;
  const θ = toRad(bearingDeg);
  const φ1 = toRad(lat);
  const λ1 = toRad(lng);

  const sinφ2 = Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ);
  const φ2 = Math.asin(Math.min(1, Math.max(-1, sinφ2)));
  const λ2 =
    λ1 +
    Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * sinφ2);

  return { lat: toDeg(φ2), lng: ((toDeg(λ2) + 540) % 360) - 180 };
}
