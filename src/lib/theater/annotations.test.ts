import { describe, expect, it } from 'vitest';
import { formatArea, formatDistance, haversineM, measureOf, pathLengthM, polygonAreaM2, validateAnnotation } from './annotations';

const sm = { lat: 34.0089, lng: -118.4973 }; // Santa Monica Pier
const lax = { lat: 33.9416, lng: -118.4085 }; // LAX

describe('validateAnnotation', () => {
  it('accepts each kind with its minimum points and keeps id/createdAt on edit', () => {
    const pin = validateAnnotation({ kind: 'pin', points: [sm], label: 'Pier' });
    expect(pin.ok && pin.item).toMatchObject({ kind: 'pin', label: 'Pier', points: [sm] });
    expect(pin.ok && pin.item.id).toMatch(/^an-/);
    const edited = validateAnnotation({ kind: 'pin', points: [lax] }, pin.ok ? pin.item : undefined);
    expect(edited.ok && edited.item.id).toBe(pin.ok ? pin.item.id : 'x');
    expect(validateAnnotation({ kind: 'measure', points: [sm, lax] }).ok).toBe(true);
    expect(validateAnnotation({ kind: 'outline', points: [sm, lax, { lat: 34, lng: -118.3 }], color: '#00d4ff' }).ok).toBe(true);
  });
  it('rejects too few points, a label without text, bad coordinates and bad colours', () => {
    expect(validateAnnotation({ kind: 'outline', points: [sm, lax] })).toMatchObject({ ok: false, errors: [expect.stringMatching(/at least 3/)] });
    expect(validateAnnotation({ kind: 'label', points: [sm] })).toMatchObject({ ok: false, errors: [expect.stringMatching(/needs text/)] });
    expect(validateAnnotation({ kind: 'pin', points: [{ lat: 95, lng: 0 }] }).ok).toBe(false);
    expect(validateAnnotation({ kind: 'pin', points: [sm], color: 'red' }).ok).toBe(false);
    expect(validateAnnotation({ kind: 'nope', points: [sm] }).ok).toBe(false);
    expect(validateAnnotation(null).ok).toBe(false);
  });
});

describe('geometry', () => {
  it('measures the pier-to-LAX leg at about 11 km and formats units', () => {
    const m = haversineM(sm, lax);
    expect(m).toBeGreaterThan(11_000); expect(m).toBeLessThan(11_500);
    expect(pathLengthM([sm, lax, sm])).toBeCloseTo(2 * m, 6);
    expect(formatDistance(850)).toBe('850 m · 2,789 ft');
    expect(formatDistance(m)).toMatch(/^11\.\d km · 6\.\d\d mi · 5\.\d\d nmi$/);
  });
  it('computes a plausible area for a small square and reports measures per kind', () => {
    // ~100 m × 100 m square near the pier
    const d = 100 / 111_320;
    const sq = [sm, { lat: sm.lat + d, lng: sm.lng }, { lat: sm.lat + d, lng: sm.lng + d / Math.cos((sm.lat * Math.PI) / 180) }, { lat: sm.lat, lng: sm.lng + d / Math.cos((sm.lat * Math.PI) / 180) }];
    const a = polygonAreaM2(sq);
    expect(a).toBeGreaterThan(9_500); expect(a).toBeLessThan(10_500);
    expect(formatArea(a)).toMatch(/^9,\d{3} m² · 10\d,\d{3} ft²$/);
    expect(formatArea(500)).toBe('500 m² · 5,382 ft²');
    expect(formatArea(250_000)).toBe('0.250 km² · 61.8 acres');
    expect(formatArea(2_500_000)).toBe('2.50 km² · 617.8 acres');
    const outline = validateAnnotation({ kind: 'outline', points: sq });
    expect(outline.ok && measureOf(outline.item)?.kind).toBe('area');
    const pin = validateAnnotation({ kind: 'pin', points: [sm] });
    expect(pin.ok && measureOf(pin.item)).toBeNull();
  });
});
