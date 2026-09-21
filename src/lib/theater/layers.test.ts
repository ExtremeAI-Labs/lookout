import { describe, expect, it } from 'vitest';
import { THEATER_LAYERS, bearingDeg, distanceKm, fetchCanvassQuery, formatAltitude, nearbyContacts, parseLayerParam, serializeLayerParam, type TheaterContact } from './layers';

describe('layer param', () => {
  it('defaults to the layers marked on when the param is absent', () => {
    expect([...parseLayerParam(null)]).toEqual(THEATER_LAYERS.filter((l) => l.defaultOn).map((l) => l.id));
  });
  it('reads a list, ignoring names the theater does not know', () => {
    expect([...parseLayerParam('satellites, cctv,balloons,,earthquakes')]).toEqual(['satellites', 'cctv', 'earthquakes']);
  });
  it('an explicit empty param means nothing on', () => {
    expect(parseLayerParam('').size).toBe(0);
  });
  it('serialises in registry order, round-tripping', () => {
    const s = serializeLayerParam(new Set(['earthquakes', 'flights']));
    expect(s).toBe('flights,earthquakes');
    expect([...parseLayerParam(s)]).toEqual(['flights', 'earthquakes']);
  });
});

describe('geometry', () => {
  it('measures LAX to SFO at about 543 km', () => {
    expect(distanceKm(33.9416, -118.4085, 37.6213, -122.379)).toBeCloseTo(543, -1);
  });
  it('bears roughly north-west from LAX to SFO', () => {
    const b = bearingDeg(33.9416, -118.4085, 37.6213, -122.379);
    expect(b).toBeGreaterThan(310);
    expect(b).toBeLessThan(330);
  });
});

describe('nearbyContacts', () => {
  const c = (id: string, lat: number, lng: number): TheaterContact => ({ layer: 'flights', id, name: id, lat, lng, alt: 0, kind: 'test' });
  it('returns only contacts inside the radius, nearest first, with distance and bearing', () => {
    const list = nearbyContacts([c('far', 40, -118), c('near', 34.1, -118.4), c('mid', 34.5, -118.4)], 34.0, -118.4, 250);
    expect(list.map((x) => x.id)).toEqual(['near', 'mid']);
    expect(list[0].distanceKm).toBeCloseTo(11.1, 0);
    expect(Math.round(list[0].bearingDeg)).toBe(0);
  });
  it('honours the limit', () => {
    const many = Array.from({ length: 50 }, (_, i) => c(`c${i}`, 34 + i * 0.01, -118));
    expect(nearbyContacts(many, 34, -118, 500, 10)).toHaveLength(10);
  });
});

describe('helpers', () => {
  it('builds a bounded canvass query around a point', () => {
    expect(fetchCanvassQuery(34.016, -118.496)).toBe('/api/canvass?lat=34.01600&lng=-118.49600&radius=1500');
  });
  it('formats altitude in feet, and in km once it is orbital', () => {
    expect(formatAltitude(10_668)).toBe('35,000 ft');
    expect(formatAltitude(550_000)).toBe('550 km');
    expect(formatAltitude(NaN)).toBe('—');
  });
});
