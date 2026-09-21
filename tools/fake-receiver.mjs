#!/usr/bin/env node
// A stand-in for a readsb receiver: serves /data/aircraft.json and /data/receiver.json with a
// handful of synthetic aircraft flying arcs around a point, in exactly readsb's documented
// shape. For developing and verifying the track recorder without hardware.
//   node tools/fake-receiver.mjs [port=4631] [lat=34.05] [lon=-118.4]
import http from 'node:http';

const port = Number(process.argv[2] || 4631);
const lat0 = Number(process.argv[3] || 34.05), lon0 = Number(process.argv[4] || -118.4);
const t0 = Date.now();
const fleet = [
  { hex: 'a1b2c3', flight: 'UAL123  ', r: 'N12345', t: 'B738', radiusKm: 40, periodS: 900, alt: 12000, phase: 0 },
  { hex: 'a9e4f1', flight: 'SWA88   ', r: 'N8801Q', t: 'B737', radiusKm: 25, periodS: 600, alt: 6500, phase: 2.1 },
  { hex: 'ae1234', flight: 'RCH441  ', t: 'C17', radiusKm: 60, periodS: 1400, alt: 25000, phase: 4.0, dbFlags: 1 },
  { hex: 'a3c0de', flight: 'N77XY   ', r: 'N77XY', t: 'C172', radiusKm: 12, periodS: 420, alt: 2500, phase: 1.0 },
  { hex: '~2a3b4c', t: 'GRND', radiusKm: 0.6, periodS: 300, alt: 'ground', phase: 0.5, type: 'tisb_other' },
];

function aircraft(now) {
  const out = [];
  for (const a of fleet) {
    const ang = a.phase + ((now - t0) / 1000 / a.periodS) * 2 * Math.PI;
    const dLat = (a.radiusKm / 111) * Math.sin(ang);
    const dLon = (a.radiusKm / (111 * Math.cos((lat0 * Math.PI) / 180))) * Math.cos(ang);
    const track = ((ang * 180) / Math.PI + 90 + 360) % 360;
    out.push({
      hex: a.hex, type: a.type || 'adsb_icao', flight: a.flight, r: a.r, t: a.t, dbFlags: a.dbFlags || 0,
      alt_baro: a.alt, alt_geom: a.alt === 'ground' ? undefined : a.alt + 300, gs: a.alt === 'ground' ? 8 : 180 + a.radiusKm * 4,
      track: Math.round(track * 10) / 10, lat: +(lat0 + dLat).toFixed(5), lon: +(lon0 + dLon).toFixed(5),
      seen_pos: 0.2, seen: 0.1, nac_p: 9, nic: 8, rc: 186, messages: 1000, rssi: -12.3, category: 'A3',
    });
  }
  // one aircraft with no position (Mode S only), one with a stale position
  out.push({ hex: 'c0ffee', type: 'mode_s', flight: 'NOPOS   ', alt_baro: 30000, seen: 3 });
  out.push({ hex: 'deadbe', type: 'adsb_icao', lat: lat0 + 1, lon: lon0 + 1, alt_baro: 20000, seen_pos: 90 });
  return out;
}

http.createServer((req, res) => {
  const now = Date.now();
  if (req.url?.startsWith('/data/aircraft.json')) {
    const list = aircraft(now);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ now: now / 1000, messages: 100000 + Math.floor((now - t0) / 10), aircraft: list }));
  } else if (req.url?.startsWith('/data/receiver.json')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ version: 'fake-receiver', refresh: 1000, lat: lat0, lon: lon0 }));
  } else { res.writeHead(404); res.end('not found'); }
}).listen(port, '127.0.0.1', () => console.log(`fake receiver on http://127.0.0.1:${port}/data/aircraft.json (${fleet.length} aircraft around ${lat0},${lon0})`));
