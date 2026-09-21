import { describe, expect, it } from 'vitest';
import { sha256 } from '@/lib/cases';
import { buildTrackExport } from './export';
import type { StoredFix } from './store';

const T = Date.UTC(2026, 8, 17, 10, 0, 0);
const fixes: StoredFix[] = [
  [T + 5000, 'abc123', 34.02, -118.02, 5200, 92, 250, 'UAL1', 0, 9],
  [T, 'abc123', 34.0, -118.0, 5000, 90, 250, 'UAL1', 0, 9],
  [T + 1000, 'zzz999', 35, -117, 100, 0, 10, '', 1, null],
];

describe('buildTrackExport', () => {
  it('seals the track as a finding and places an observed reconstruction item at the first fix', () => {
    const r = buildTrackExport({ hex: 'ABC123', fromMs: T - 1000, toMs: T + 10_000, fixes, provenance: [{ day: '2026-09-17', segments: [] }], receiver: 'receiver.local', unsealedLines: 2 });
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.finding.tool).toBe('track');
    expect(r.finding.sha256).toBe(sha256(r.finding.data));
    const data = r.finding.data as { fixes: StoredFix[]; source: { kind: string } };
    expect(data.fixes.map((f) => f[0])).toEqual([T, T + 5000]);
    expect(data.source.kind).toBe('own-receiver');
    expect(r.item).toMatchObject({ kind: 'track', basis: 'observed', findingId: r.finding.id, at: { lat: 34, lng: -118, headingDeg: 90 }, eventTime: { start: new Date(T).toISOString(), end: new Date(T + 5000).toISOString() } });
    expect(r.item.source.sha256).toBe(r.finding.sha256);
    expect(r.item.title).toBe('Track UAL1');
  });
  it('refuses an aircraft with no fixes in the window', () => {
    expect(buildTrackExport({ hex: 'nope', fromMs: T, toMs: T + 1, fixes, provenance: [], receiver: 'r', unsealedLines: 0 })).toEqual({ error: 'no fixes for that aircraft in the window' });
  });
});
