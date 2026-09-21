import { describe, expect, it } from 'vitest';
import { AIRCRAFT_MODELS, classifyAircraft, modelFor } from './aircraft-class';

describe('classifyAircraft (God\'s Eye View tables, ported)', () => {
  it('reads ICAO type designators', () => {
    expect(classifyAircraft({ typeCode: 'B738' })).toBe('airliner');
    expect(classifyAircraft({ typeCode: 'B789' })).toBe('widebody');
    expect(classifyAircraft({ typeCode: 'A388' })).toBe('quadjet');
    expect(classifyAircraft({ typeCode: 'EC35' })).toBe('helicopter');
    expect(classifyAircraft({ typeCode: 'C172' })).toBe('light');
    expect(classifyAircraft({ typeCode: 'AT76' })).toBe('turboprop');
    expect(classifyAircraft({ typeCode: 'C25A' })).toBe('bizjet');
    expect(classifyAircraft({ typeCode: 'F16' })).toBe('fastjet');
    expect(classifyAircraft({ typeCode: 'Q9' })).toBe('uav');
  });
  it('falls back to emitter / OpenSky categories, then airliner', () => {
    expect(classifyAircraft({ category: 8 })).toBe('helicopter');
    expect(classifyAircraft({ category: 'A7' })).toBe('helicopter');
    expect(classifyAircraft({ category: 'A1' })).toBe('light');
    expect(classifyAircraft({})).toBe('airliner');
    expect(classifyAircraft({ typeCode: 'ZZZZ' })).toBe('airliner');
  });
  it('maps every class to a bundled model with a 180° nose offset', () => {
    for (const cls of Object.keys(AIRCRAFT_MODELS) as (keyof typeof AIRCRAFT_MODELS)[]) {
      const m = modelFor(cls);
      expect(m.url).toMatch(/^\/models\/[a-z0-9]+\.glb$/);
      expect(m.headingOffsetDeg).toBe(180);
      expect(m.scale).toBeGreaterThan(0);
    }
  });
});
