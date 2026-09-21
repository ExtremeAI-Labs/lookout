import { describe, it, expect } from 'vitest';
import { TrackMotion, MAX_COAST_MS, type Fix } from './motion';

const fix = (over: Partial<Fix>): Fix => ({
  lat: 0,
  lng: 0,
  alt: 1000,
  heading: 0,
  speedMps: 100,
  t: 0,
  ...over,
});

describe('TrackMotion', () => {
  it('interpolates the midpoint between the last two fixes (render-one-behind)', () => {
    const tm = new TrackMotion();
    tm.addFix('a1', fix({ lat: 0, lng: 0, alt: 1000, heading: 0, t: 0 }));
    tm.addFix('a1', fix({ lat: 1, lng: 1, alt: 2000, heading: 90, t: 1000 }));
    const mid = tm.positionAt('a1', 500);
    expect(mid).not.toBeNull();
    expect(mid!.lat).toBeCloseTo(0.5, 6);
    expect(mid!.lng).toBeCloseTo(0.5, 6);
    expect(mid!.alt).toBeCloseTo(1500, 6);
    expect(mid!.coasting).toBe(false);
  });

  it('dead-reckons forward from the latest fix along heading and speed', () => {
    const tm = new TrackMotion();
    tm.addFix('a1', fix({ lat: 0, lng: 0, heading: 90, speedMps: 100, t: 0 }));
    const p10s = tm.positionAt('a1', 10_000);
    expect(p10s).not.toBeNull();
    // Heading 90 (east) increases longitude; latitude stays essentially flat.
    expect(p10s!.lng).toBeGreaterThan(0);
    expect(Math.abs(p10s!.lat)).toBeLessThan(0.001);
    expect(p10s!.coasting).toBe(false);
  });

  it('caps coasting at MAX_COAST_MS and reports coasting: true beyond it', () => {
    const tm = new TrackMotion();
    tm.addFix('a1', fix({ lat: 0, lng: 0, heading: 90, speedMps: 100, t: 0 }));
    const atCap = tm.positionAt('a1', MAX_COAST_MS);
    const wayPast = tm.positionAt('a1', MAX_COAST_MS * 10);
    expect(atCap).not.toBeNull();
    expect(wayPast).not.toBeNull();
    expect(wayPast!.coasting).toBe(true);
    // Position freezes once the coast cap is reached.
    expect(wayPast!.lat).toBeCloseTo(atCap!.lat, 9);
    expect(wayPast!.lng).toBeCloseTo(atCap!.lng, 9);
  });

  it('holds at the earlier fix when now is before both known fixes (never extrapolates backwards)', () => {
    const tm = new TrackMotion();
    tm.addFix('a1', fix({ lat: 1, lng: 1, t: 1000 }));
    tm.addFix('a1', fix({ lat: 2, lng: 2, t: 2000 }));
    const p = tm.positionAt('a1', 500);
    expect(p!.lat).toBe(1);
    expect(p!.lng).toBe(1);
    expect(p!.coasting).toBe(false);
  });

  it('holds at the only known fix when now is before it', () => {
    const tm = new TrackMotion();
    tm.addFix('a1', fix({ lat: 10, lng: 20, t: 1000 }));
    const before = tm.positionAt('a1', 0);
    expect(before).toEqual({ lat: 10, lng: 20, alt: 1000, heading: 0, speedMps: 100, coasting: false });
  });

  it('ignores a fix that arrives older than (or the same age as) the current latest', () => {
    const tm = new TrackMotion();
    tm.addFix('a1', fix({ lat: 0, lng: 0, t: 1000 }));
    tm.addFix('a1', fix({ lat: 99, lng: 99, t: 500 })); // stale, must be ignored
    tm.addFix('a1', fix({ lat: 99, lng: 99, t: 1000 })); // same age, must be ignored
    const p = tm.positionAt('a1', 1000);
    expect(p!.lat).toBe(0);
    expect(p!.lng).toBe(0);
  });

  it('returns null for an entity with no recorded fix', () => {
    const tm = new TrackMotion();
    expect(tm.positionAt('ghost', 0)).toBeNull();
    expect(tm.has('ghost')).toBe(false);
  });

  it('prunes entities whose latest fix is older than maxAgeMs', () => {
    const tm = new TrackMotion();
    tm.addFix('a1', fix({ t: 0 }));
    tm.addFix('a2', fix({ t: 9000 }));
    tm.prune(10_000, 5000);
    expect(tm.has('a1')).toBe(false);
    expect(tm.has('a2')).toBe(true);
  });
});

describe('renderDelayMs', () => {
  it('renders one interval behind so a regular feed is always interpolated, never guessed', () => {
    const m = new TrackMotion({ renderDelayMs: 1000, maxCoastMs: 5000 });
    m.addFix('s', { lat: 0, lng: 0, alt: 0, heading: 90, speedMps: 0, t: 0 });
    m.addFix('s', { lat: 0, lng: 1, alt: 0, heading: 90, speedMps: 0, t: 1000 });
    // wall time 1500 renders at 500: halfway along the chord, not dead-reckoned past the newest fix
    const p = m.positionAt('s', 1500)!;
    expect(p.lng).toBeCloseTo(0.5, 6);
    expect(p.coasting).toBe(false);
  });
  it('still accepts the plain-number form', () => {
    const m = new TrackMotion(250);
    m.addFix('a', { lat: 0, lng: 0, alt: 0, heading: 0, speedMps: 10, t: 0 });
    expect(m.positionAt('a', 10_000)!.coasting).toBe(true);
  });
});
