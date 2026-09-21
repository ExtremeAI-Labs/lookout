// Satellites: points at their real altitude — something the flat map has to fake with a
// custom layer and Cesium does natively. Positions arrive every poll; between polls the
// motion model interpolates one poll behind, so 7 km/s objects glide rather than jump.
import type * as CesiumNS from 'cesium';
import { TrackMotion } from '@/lib/theater/motion';
import type { TheaterContact, TheaterLayerId } from '@/lib/theater/layers';
import { scratchCartesian, type CesiumGlobal, type TheaterLayer } from './base';

type Sat = { id: string; name: string; category: string; contact: TheaterContact };

export class SatellitesLayer implements TheaterLayer {
  readonly id: TheaterLayerId = 'satellites';
  private points: CesiumNS.PointPrimitiveCollection;
  private byId = new Map<string, { s: Sat; point: CesiumNS.PointPrimitive }>();
  private motion: TrackMotion;
  private lastTick = 0;
  private visible = true;

  constructor(private Cesium: CesiumGlobal, private viewer: CesiumNS.Viewer, pollMs: number) {
    this.points = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
    // Render one poll behind: with two fixes in hand every frame is an interpolation.
    this.motion = new TrackMotion({ renderDelayMs: pollMs, maxCoastMs: pollMs * 2 });
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    this.points.show = visible;
  }

  update(payload: unknown, now: number) {
    const list = ((payload as { satellites?: unknown[] })?.satellites || []) as Record<string, unknown>[];
    const seen = new Set<string>();
    for (const raw of list) {
      const id = String(raw.noradId || raw.name || '');
      const lat = raw.lat as number, lng = raw.lng as number;
      if (!id || typeof lat !== 'number' || typeof lng !== 'number') continue;
      const alt = (typeof raw.alt === 'number' ? raw.alt : 500) * 1000; // km → m
      seen.add(id);
      this.motion.addFix(id, { lat, lng, alt, heading: 0, speedMps: 0, t: now });
      let entry = this.byId.get(id);
      if (!entry) {
        const color = this.Cesium.Color.fromCssColorString(String(raw.color || '#00E5FF'));
        const point = this.points.add({
          position: this.Cesium.Cartesian3.fromDegrees(lng, lat, alt),
          pixelSize: 3,
          color,
          outlineWidth: 0,
          scaleByDistance: new this.Cesium.NearFarScalar(1.0e6, 1.6, 2.0e7, 0.6),
          id: { layer: 'satellites', id },
        });
        const name = String(raw.name || id);
        entry = { s: { id, name, category: String(raw.category || ''), contact: { layer: 'satellites', id, name, lat, lng, alt, kind: 'satellite' } }, point };
        this.byId.set(id, entry);
      }
      entry.s.category = String(raw.category || entry.s.category);
      entry.s.contact.detail = `${String(raw.mission || entry.s.category || 'satellite')} · ${Math.round(alt / 1000).toLocaleString()} km`;
    }
    for (const [id, entry] of this.byId) {
      if (!seen.has(id)) { this.points.remove(entry.point); this.byId.delete(id); }
    }
  }

  tick(now: number) {
    if (!this.visible || now - this.lastTick < 250) return;
    this.lastTick = now;
    const scratch = scratchCartesian(this.Cesium);
    for (const { s, point } of this.byId.values()) {
      const pos = this.motion.positionAt(s.id, now);
      if (!pos) continue;
      this.Cesium.Cartesian3.fromDegrees(pos.lng, pos.lat, pos.alt, undefined, scratch);
      point.position = scratch;
      s.contact.lat = pos.lat; s.contact.lng = pos.lng; s.contact.alt = pos.alt;
    }
  }

  contact(id: string) {
    return this.byId.get(id)?.s.contact;
  }

  *contacts(): Iterable<TheaterContact> {
    if (!this.visible) return;
    for (const { s } of this.byId.values()) yield s.contact;
  }

  count() {
    return this.byId.size;
  }

  dispose() {
    this.viewer.scene.primitives.remove(this.points);
    this.byId.clear();
  }
}
