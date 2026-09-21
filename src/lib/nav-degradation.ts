// Where aircraft are reporting degraded navigation accuracy — the signal people
// loosely call "GPS jamming". Aircraft broadcast NACp, their own estimate of how
// accurate their position is; this bins one feed snapshot into grid cells and asks
// what share of the aircraft in each cell are reporting a poor one.
//
// The method is GPSJAM's, stated in its FAQ (gpsjam.org/faq):
//     percent_bad = 100 * (bad - 1) / (good + bad)      yellow 2–10 %, red > 10 %
// The "- 1" is deliberate denoising: one aircraft with a flaky receiver must not
// paint a cell. A share matters because a raw count does not — three degraded
// aircraft over an empty ocean is a finding; three over LAX is a Tuesday.
//
// What this does NOT establish: that anything is being jammed. The data says an
// aircraft reported low accuracy, not why. GPSJAM's own author attributes the
// recurring Texas hot spot to military trainers blocking their own antennas in
// hard manoeuvres. And where GPSJAM aggregates 24 hours, this is ONE snapshot —
// treat a cell as "worth a look", never as an observation of interference.

export type NavSample = { lat: number; lng: number; nac_p: number };

export type NavDegradedCell = {
  /** cell centre */
  lat: number;
  lng: number;
  /** cell edge length in degrees, so the renderer can draw the real extent */
  size: number;
  degraded: number;
  total: number;
  /** GPSJAM's denoised share, 0–100, one decimal */
  percent: number;
  level: 'elevated' | 'high';
};

/** NACp ≤ 4 means the aircraft's own 95 % position bound is worse than 0.3 NM. */
export const NAV_DEGRADED_NACP_MAX = 4;
export const NAV_GRID_DEGREES = 2;
export const NAV_ELEVATED_PERCENT = 2;
export const NAV_HIGH_PERCENT = 10;
/** Below this many reporting aircraft a share is noise, whatever it says. */
export const NAV_MIN_AIRCRAFT = 5;

export function aggregateNavDegradation(samples: NavSample[], grid = NAV_GRID_DEGREES): NavDegradedCell[] {
  const cells = new Map<string, { gLat: number; gLng: number; degraded: number; total: number }>();
  for (const s of samples) {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lng) || !Number.isFinite(s.nac_p)) continue;
    if (Math.abs(s.lat) > 90 || Math.abs(s.lng) > 180) continue;
    const gLat = Math.floor(s.lat / grid) * grid;
    const gLng = Math.floor(s.lng / grid) * grid;
    const key = `${gLat},${gLng}`;
    let cell = cells.get(key);
    if (!cell) cells.set(key, (cell = { gLat, gLng, degraded: 0, total: 0 }));
    cell.total++;
    if (s.nac_p <= NAV_DEGRADED_NACP_MAX) cell.degraded++;
  }

  const out: NavDegradedCell[] = [];
  for (const c of cells.values()) {
    if (c.total < NAV_MIN_AIRCRAFT) continue;
    const percent = (100 * (c.degraded - 1)) / c.total;
    if (percent < NAV_ELEVATED_PERCENT) continue;
    out.push({
      lat: c.gLat + grid / 2,
      lng: c.gLng + grid / 2,
      size: grid,
      degraded: c.degraded,
      total: c.total,
      percent: Math.round(percent * 10) / 10,
      level: percent > NAV_HIGH_PERCENT ? 'high' : 'elevated',
    });
  }
  return out.sort((a, b) => b.percent - a.percent);
}
