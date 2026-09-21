// Maritime in the theater: live AIS vessels (when the console has an aisstream.io key), the
// curated major ports, and the chokepoints — one payload from /api/maritime, three kinds of
// contact. Vessels move between polls on the same motion model as aircraft, just slower.
import type * as CesiumNS from 'cesium';
import { TrackMotion } from '@/lib/theater/motion';
import type { TheaterContact, TheaterLayerId } from '@/lib/theater/layers';
import { scratchCartesian, type CesiumGlobal, type TheaterLayer } from './base';

type Kind = 'vessel' | 'port' | 'chokepoint';
type Entry = { kind: Kind; contact: TheaterContact; point: CesiumNS.PointPrimitive; label: CesiumNS.Label | null; lastReport: string };

const KNOTS_TO_MPS = 0.514444;
const COLORS = { vessel: '#5EEAD4', port: '#F5D37A', chokeLow: '#9CA3AF', chokeElevated: '#FFB300', chokeHigh: '#FF4D5E' };
/** a vessel keeps sailing on its last course for this long, then stops and dims */
const VESSEL_MAX_COAST_MS = 15 * 60_000;
const VESSEL_MAX_AGE_MS = 30 * 60_000;

export class VesselsLayer implements TheaterLayer {
  readonly id: TheaterLayerId = 'vessels';
  private points: CesiumNS.PointPrimitiveCollection;
  private labels: CesiumNS.LabelCollection;
  private byId = new Map<string, Entry>();
  private motion = new TrackMotion({ maxCoastMs: VESSEL_MAX_COAST_MS, renderDelayMs: 60_000 });
  private visible = true;
  private lastTick = 0;
  private vesselCount = 0;

  constructor(private Cesium: CesiumGlobal, private viewer: CesiumNS.Viewer) {
    this.points = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
    this.labels = viewer.scene.primitives.add(new Cesium.LabelCollection());
  }

  setVisible(visible: boolean) { this.visible = visible; this.points.show = visible; this.labels.show = visible; }

  private color(css: string) { return this.Cesium.Color.fromCssColorString(css); }

  private upsert(id: string, kind: Kind, contact: TheaterContact, css: string, size: number, labelText: string | null, report: string) {
    const { Cesium } = this;
    let e = this.byId.get(id);
    const pos = Cesium.Cartesian3.fromDegrees(contact.lng, contact.lat, contact.alt);
    if (!e) {
      const point = this.points.add({ position: pos, pixelSize: size, color: this.color(css), outlineColor: Cesium.Color.BLACK.withAlpha(0.6), outlineWidth: 1, disableDepthTestDistance: Number.POSITIVE_INFINITY, scaleByDistance: new Cesium.NearFarScalar(2.0e5, 1.3, 1.0e7, 0.5), id: { layer: 'vessels', id } });
      const label = labelText ? this.labels.add({ position: pos, text: labelText, font: '600 10px "JetBrains Mono", ui-monospace, Menlo, monospace', fillColor: this.color(css), showBackground: true, backgroundColor: new Cesium.Color(0.04, 0.07, 0.1, 0.72), backgroundPadding: new Cesium.Cartesian2(6, 3), style: Cesium.LabelStyle.FILL, pixelOffset: new Cesium.Cartesian2(0, -14), disableDepthTestDistance: Number.POSITIVE_INFINITY, translucencyByDistance: new Cesium.NearFarScalar(1.0e6, 1.0, 8.0e6, 0.0) }) : null;
      e = { kind, contact, point, label, lastReport: report };
      this.byId.set(id, e);
    } else {
      e.contact = contact; e.lastReport = report; e.point.color = this.color(css);
      if (kind !== 'vessel') { e.point.position = pos; if (e.label) e.label.position = pos; }
    }
    return e;
  }

  update(payload: unknown, now: number) {
    const p = (payload || {}) as { ships?: Record<string, unknown>[]; ports?: Record<string, unknown>[]; chokepoints?: Record<string, unknown>[] };
    const seen = new Set<string>();
    let vessels = 0;
    for (const s of p.ships || []) {
      const id = `v:${String(s.mmsi || s.id || '')}`;
      const lat = s.lat as number, lng = s.lng as number;
      if (!id.slice(2) || typeof lat !== 'number' || typeof lng !== 'number') continue;
      vessels++; seen.add(id);
      const speedKt = typeof s.speed === 'number' ? s.speed : 0, heading = typeof s.heading === 'number' ? s.heading : 0;
      const report = `${lat.toFixed(5)},${lng.toFixed(5)},${Math.round(heading)}`;
      const known = this.byId.get(id);
      if (!known || known.lastReport !== report) this.motion.addFix(id, { lat, lng, alt: 0, heading, speedMps: speedKt * KNOTS_TO_MPS, t: now });
      const name = String(s.name || '').trim() || `MMSI ${id.slice(2)}`;
      const detail = `${s.type ? String(s.type) + ' · ' : ''}${Math.round(speedKt)} kt · hdg ${String(Math.round(heading)).padStart(3, '0')}°${s.destination ? ` · → ${String(s.destination)}` : ''}`;
      this.upsert(id, 'vessel', { layer: 'vessels', id, name, lat, lng, alt: 0, kind: 'vessel', detail }, COLORS.vessel, 5, null, report);
    }
    for (const pt of p.ports || []) {
      const name = String(pt.name || ''); const lat = pt.lat as number, lng = pt.lng as number;
      if (!name || typeof lat !== 'number' || typeof lng !== 'number') continue;
      const id = `p:${name}`; seen.add(id);
      this.upsert(id, 'port', { layer: 'vessels', id, name, lat, lng, alt: 0, kind: 'port', detail: `${pt.country ? String(pt.country) + ' · ' : ''}${pt.type ? String(pt.type) + ' port' : 'port'}${pt.volume ? ` · ${String(pt.volume)}` : ''}${pt.rank ? ` · #${String(pt.rank)}` : ''}` }, COLORS.port, 6, name.toUpperCase(), name);
    }
    for (const c of p.chokepoints || []) {
      const name = String(c.name || ''); const lat = c.lat as number, lng = c.lng as number;
      if (!name || typeof lat !== 'number' || typeof lng !== 'number') continue;
      const id = `c:${name}`; seen.add(id);
      const risk = String(c.risk || '').toUpperCase();
      const css = risk === 'HIGH' || risk === 'CRITICAL' ? COLORS.chokeHigh : risk === 'ELEVATED' ? COLORS.chokeElevated : COLORS.chokeLow;
      this.upsert(id, 'chokepoint', { layer: 'vessels', id, name, lat, lng, alt: 0, kind: 'chokepoint', detail: `${c.traffic ? String(c.traffic) + ' · ' : ''}risk ${risk || 'n/a'}` }, css, 7, `⌇ ${name.toUpperCase()}`, `${name}:${risk}`);
    }
    this.vesselCount = vessels;
    for (const [id, e] of this.byId) {
      if (e.kind === 'vessel' ? !this.motion.has(id) && !seen.has(id) : !seen.has(id)) { this.points.remove(e.point); if (e.label) this.labels.remove(e.label); this.byId.delete(id); }
    }
    this.motion.prune(now, VESSEL_MAX_AGE_MS);
  }

  tick(now: number) {
    if (now - this.lastTick < 500) return;
    this.lastTick = now;
    const scratch = scratchCartesian(this.Cesium);
    for (const [id, e] of this.byId) {
      if (e.kind !== 'vessel') continue;
      const pos = this.motion.positionAt(id, now);
      if (!pos) continue;
      this.Cesium.Cartesian3.fromDegrees(pos.lng, pos.lat, 0, undefined, scratch);
      e.point.position = scratch;
      e.contact.lat = pos.lat; e.contact.lng = pos.lng;
      const alpha = pos.coasting ? 0.4 : 1;
      if (e.point.color.alpha !== alpha) e.point.color = this.color(COLORS.vessel).withAlpha(alpha);
    }
  }

  contact(id: string) { return this.byId.get(id)?.contact; }
  *contacts(): Iterable<TheaterContact> { if (!this.visible) return; for (const e of this.byId.values()) yield e.contact; }
  /** live vessels only — ports and chokepoints are fixtures, the panel note says so */
  count() { return this.vesselCount; }
  dispose() { this.viewer.scene.primitives.remove(this.points); this.viewer.scene.primitives.remove(this.labels); this.byId.clear(); }
}
