import { describe, expect, it } from 'vitest';
import { haversineKm, parseAircraftJson } from './receiver';

const sample = {
  now: 1758000000.5,
  messages: 12345,
  aircraft: [
    { hex: 'A1B2C3', type: 'adsb_icao', flight: 'UAL123  ', alt_baro: 35000, alt_geom: 35600, gs: 450.2, track: 271.4, lat: 34.05, lon: -118.25, seen_pos: 0.4, nac_p: 9, dbFlags: 0, r: 'N12345', t: 'B738' },
    { hex: 'ae1234', type: 'adsb_icao', flight: 'RCH441', alt_baro: 'ground', gs: 12, track: 90, lat: 34.0, lon: -118.4, seen_pos: 1, dbFlags: 1 },
    { hex: '~2a3b4c', type: 'tisb_other', alt_geom: 1200, lat: 34.1, lon: -118.3, seen_pos: 2 },
    { hex: 'c0ffee', lat: 34.2, lon: -118.2, seen_pos: 45 },            // stale position
    { hex: 'deadbe', alt_baro: 3000 },                                     // no position at all
    { hex: 'zz', lat: 1, lon: 2 },                                          // malformed hex
    { hex: 'abcdef', lat: 95, lon: 0 },                                     // out of range
    'garbage',
  ],
};

describe('parseAircraftJson', () => {
  it('reads readsb fields as documented and derives the fix time from now - seen_pos', () => {
    const p = parseAircraftJson(sample, 1);
    expect(p.nowMs).toBe(1758000000500);
    expect(p.total).toBe(8);
    expect(p.withPosition).toBe(4);
    expect(p.stale).toBe(1);
    expect(p.fixes).toHaveLength(3);
    const ual = p.fixes[0];
    expect(ual).toMatchObject({ hex: 'a1b2c3', lat: 34.05, lng: -118.25, altFt: 35000, ground: false, gsKt: 450.2, trackDeg: 271.4, callsign: 'UAL123', reg: 'N12345', typeCode: 'B738', nacP: 9, source: 'adsb_icao' });
    expect(ual.t).toBe(1758000000500 - 400);
    expect(ual.military).toBeUndefined();
  });
  it('treats "ground" as altitude 0, flags military from dbFlags, keeps non-ICAO addresses marked', () => {
    const p = parseAircraftJson(sample);
    expect(p.fixes[1]).toMatchObject({ hex: 'ae1234', altFt: 0, ground: true, military: true, callsign: 'RCH441' });
    expect(p.fixes[2]).toMatchObject({ hex: '~2a3b4c', altFt: 1200, source: 'tisb_other' });
  });
  it('falls back to the receive time when the receiver has no clock, and never throws', () => {
    expect(parseAircraftJson({ aircraft: [{ hex: 'abc123', lat: 1, lon: 2 }] }, 5000).fixes[0].t).toBe(5000);
    expect(parseAircraftJson(null).fixes).toEqual([]);
    expect(parseAircraftJson('nope').total).toBe(0);
  });
});

describe('haversineKm', () => {
  it('measures LAX to SFO at about 543 km', () => {
    expect(haversineKm(33.9416, -118.4085, 37.6213, -122.379)).toBeCloseTo(543, -1);
  });
});
