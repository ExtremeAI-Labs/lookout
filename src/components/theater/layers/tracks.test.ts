import { describe, expect, it } from 'vitest';
import type { StoredFix } from '@/lib/tracks/store';
import { positionAt } from './tracks';

const T = 1_700_000_000_000;
const fixes: StoredFix[] = [
  [T, 'abc123', 34.0, -118.0, 10_000, 90, 200, 'X', 0, 9],
  [T + 10_000, 'abc123', 34.0, -117.9, 12_000, 95, 220, 'X', 0, 9],
  [T + 20_000, 'abc123', 34.1, -117.9, 12_000, 0, 220, 'X', 0, 9],
];

describe('positionAt', () => {
  it('interpolates between fixes and carries the next heading/speed', () => {
    const p = positionAt(fixes, T + 5000)!;
    expect(p.lat).toBeCloseTo(34.0, 6);
    expect(p.lng).toBeCloseTo(-117.95, 6);
    expect(p.alt).toBeCloseTo(11_000 * 0.3048, 3);
    expect(p.heading).toBe(95);
    expect(p.gsKt).toBe(220);
  });
  it('sits on a fix exactly at its time, lingers a minute past the last fix, and is null outside', () => {
    expect(positionAt(fixes, T)).toMatchObject({ lat: 34, lng: -118, heading: 90 });
    expect(positionAt(fixes, T + 20_000)).toMatchObject({ lat: 34.1, lng: -117.9 });
    expect(positionAt(fixes, T + 50_000)).toMatchObject({ lat: 34.1, lng: -117.9 });
    expect(positionAt(fixes, T + 81_000)).toBeNull();
    expect(positionAt(fixes, T - 1)).toBeNull();
    expect(positionAt([], T)).toBeNull();
  });
});
