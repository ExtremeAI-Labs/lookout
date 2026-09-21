import type * as CesiumNS from 'cesium';
import type { TheaterContact, TheaterLayerId } from '@/lib/theater/layers';
import type { CesiumGlobal, TheaterLayer } from './base';

type Quake = { id: string; contact: TheaterContact };

export class EarthquakesLayer implements TheaterLayer {
  readonly id: TheaterLayerId = 'earthquakes';
  private points: CesiumNS.PointPrimitiveCollection;
  private byId = new Map<string, { q: Quake; point: CesiumNS.PointPrimitive }>();
  private visible = true;

  constructor(private Cesium: CesiumGlobal, private viewer: CesiumNS.Viewer) {
    this.points = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    this.points.show = visible;
  }

  update(payload: unknown) {
    const list = ((payload as { earthquakes?: unknown[] })?.earthquakes || []) as Record<string, unknown>[];
    const seen = new Set<string>();
    for (const raw of list) {
      const id = String(raw.id || '');
      const lat = raw.lat as number, lng = raw.lng as number, mag = Number(raw.magnitude) || 0;
      if (!id || typeof lat !== 'number' || typeof lng !== 'number') continue;
      seen.add(id);
      const color = mag >= 6 ? '#FF3D3D' : mag >= 4.5 ? '#FF9500' : '#FFD166';
      const contact: TheaterContact = { layer: 'earthquakes', id, name: `M${mag.toFixed(1)} ${String(raw.place || '')}`, lat, lng, alt: 0, kind: 'earthquake',
        detail: `${typeof raw.depth === 'number' ? raw.depth + ' km deep · ' : ''}${raw.time ? new Date(Number(raw.time)).toISOString().replace('T', ' ').slice(0, 16) + 'Z' : ''}` };
      let entry = this.byId.get(id);
      if (!entry) {
        const point = this.points.add({
          position: this.Cesium.Cartesian3.fromDegrees(lng, lat, 0),
          pixelSize: 4 + Math.max(0, mag - 2) * 3,
          color: this.Cesium.Color.fromCssColorString(color).withAlpha(0.85),
          outlineColor: this.Cesium.Color.BLACK.withAlpha(0.6),
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          id: { layer: 'earthquakes', id },
        });
        entry = { q: { id, contact }, point };
        this.byId.set(id, entry);
      }
      entry.q.contact = contact;
    }
    for (const [id, entry] of this.byId) if (!seen.has(id)) { this.points.remove(entry.point); this.byId.delete(id); }
  }

  tick() {}

  contact(id: string) {
    return this.byId.get(id)?.q.contact;
  }

  *contacts(): Iterable<TheaterContact> {
    if (!this.visible) return;
    for (const { q } of this.byId.values()) yield q.contact;
  }

  count() {
    return this.byId.size;
  }

  dispose() {
    this.viewer.scene.primitives.remove(this.points);
    this.byId.clear();
  }
}
