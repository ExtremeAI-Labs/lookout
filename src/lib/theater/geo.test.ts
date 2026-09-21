import { describe, it, expect } from 'vitest';
import { normalizeHeading, shortestHeadingDelta, distanceMetres, bearingBetween, destinationPoint } from './geo';

describe('normalizeHeading', () => {
  it('wraps negative and oversized headings into [0, 360)', () => {
    expect(normalizeHeading(-1)).toBe(359);
    expect(normalizeHeading(721)).toBe(1);
    expect(normalizeHeading(0)).toBe(0);
    expect(normalizeHeading(360)).toBe(0);
  });

  it('treats non-finite input as 0', () => {
    expect(normalizeHeading(Number.NaN)).toBe(0);
    expect(normalizeHeading(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('shortestHeadingDelta', () => {
  it('takes the short way round across north', () => {
    expect(shortestHeadingDelta(350, 10)).toBe(20);
    expect(shortestHeadingDelta(10, 350)).toBe(-20);
  });

  it('is zero for identical headings and 180 for a reversal', () => {
    expect(shortestHeadingDelta(90, 90)).toBe(0);
    expect(Math.abs(shortestHeadingDelta(0, 180))).toBe(180);
  });
});

describe('distanceMetres', () => {
  it('is zero for identical points', () => {
    expect(distanceMetres(51.5, -0.1, 51.5, -0.1)).toBe(0);
  });

  it('is symmetric', () => {
    expect(distanceMetres(51.5, -0.1, 48.85, 2.35)).toBeCloseTo(distanceMetres(48.85, 2.35, 51.5, -0.1), 6);
  });

  it("measures a quarter meridian as a quarter of Earth's circumference", () => {
    const EARTH_RADIUS_M = 6_371_000;
    const quarter = (2 * Math.PI * EARTH_RADIUS_M) / 4;
    expect(distanceMetres(0, 0, 90, 0)).toBeCloseTo(quarter, 0);
  });

  it('matches a known great-circle distance (London-Paris, ~344 km)', () => {
    const metres = distanceMetres(51.5074, -0.1278, 48.8566, 2.3522);
    expect(metres).toBeGreaterThan(340_000);
    expect(metres).toBeLessThan(348_000);
  });
});

describe('bearingBetween', () => {
  it('reads cardinal directions correctly', () => {
    expect(bearingBetween(0, 0, 10, 0)).toBeCloseTo(0, 6);
    expect(bearingBetween(0, 0, 0, 10)).toBeCloseTo(90, 6);
    expect(bearingBetween(0, 0, -10, 0)).toBeCloseTo(180, 6);
    expect(bearingBetween(0, 0, 0, -10)).toBeCloseTo(270, 6);
  });

  it('always returns a value in [0, 360)', () => {
    const b = bearingBetween(51.5, -0.1, 48.85, 2.35);
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThan(360);
  });
});

describe('destinationPoint', () => {
  it('inverts with bearingBetween + distanceMetres', () => {
    const origin = { lat: 51.5, lng: -0.1 };
    const dest = destinationPoint(origin.lat, origin.lng, 45, 10_000);
    expect(distanceMetres(origin.lat, origin.lng, dest.lat, dest.lng)).toBeCloseTo(10_000, 0);
    expect(bearingBetween(origin.lat, origin.lng, dest.lat, dest.lng)).toBeCloseTo(45, 3);
  });

  it('moving north increases latitude only', () => {
    const dest = destinationPoint(0, 0, 0, 111_000);
    expect(dest.lat).toBeGreaterThan(0);
    expect(dest.lng).toBeCloseTo(0, 6);
  });

  it('a negative distance lands on the opposite bearing', () => {
    const forward = destinationPoint(10, 20, 30, 5000);
    const backward = destinationPoint(10, 20, 30, -5000);
    const opposite = destinationPoint(10, 20, 210, 5000);
    expect(backward.lat).toBeCloseTo(opposite.lat, 6);
    expect(backward.lng).toBeCloseTo(opposite.lng, 6);
    expect(backward.lat).not.toBeCloseTo(forward.lat, 3);
  });
});
