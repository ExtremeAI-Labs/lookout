// Recorded tracks — the history layer. Paths for a loaded window, and one marker per aircraft
// at the playhead, interpolated between its recorded fixes. Data comes from the HISTORY panel
// (a time window from /api/tracks), never from a live feed; the scrubber sets the playhead.
import type * as CesiumNS from 'cesium';
import type { TheaterContact, TheaterLayerId } from '@/lib/theater/layers';
import type { StoredFix, Track } from '@/lib/tracks/store';
import type { CesiumGlobal, TheaterLayer } from './base';

const FT_TO_M = 0.3048;
const MAX_LABELS = 80;
/** a marker stays after its last fix for this long, then the aircraft is "gone" */
const LINGER_MS = 60_000;

type Entry = { track: Track; line: CesiumNS.Polyline; point: CesiumNS.PointPrimitive; label: CesiumNS.Label | null; contact: TheaterContact | null };

const altM = (f: StoredFix) => Math.max(0, (f[4] ?? 0) * FT_TO_M);

/** Position at time t along a track (linear between neighbours); null outside its life. */
export function positionAt(fixes: StoredFix[], t: number): { lat: number; lng: number; alt: number; heading: number; gsKt: number | null } | null {
  if (!fixes.length || t < fixes[0][0] || t > fixes[fixes.length - 1][0] + LINGER_MS) return null;
  let lo = 0, hi = fixes.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (fixes[mid][0] <= t) lo = mid; else hi = mid - 1; }
  const a = fixes[lo], b = fixes[Math.min(lo + 1, fixes.length - 1)];
  if (a === b || b[0] <= a[0] || t <= a[0]) return { lat: a[2], lng: a[3], alt: altM(a), heading: a[5] ?? 0, gsKt: a[6] };
  const k = Math.min(1, (t - a[0]) / (b[0] - a[0]));
  return { lat: a[2] + (b[2] - a[2]) * k, lng: a[3] + (b[3] - a[3]) * k, alt: altM(a) + (altM(b) - altM(a)) * k, heading: b[5] ?? a[5] ?? 0, gsKt: b[6] ?? a[6] };
}

export class TracksLayer implements TheaterLayer {
  readonly id: TheaterLayerId = 'tracks';
  private lines: CesiumNS.PolylineCollection;
  private points: CesiumNS.PointPrimitiveCollection;
  private labels: CesiumNS.LabelCollection;
  private byHex = new Map<string, Entry>();
  private visible = true;
  private playhead = 0;

  constructor(private Cesium: CesiumGlobal, private viewer: CesiumNS.Viewer) {
    this.lines = viewer.scene.primitives.add(new Cesium.PolylineCollection());
    this.points = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
    this.labels = viewer.scene.primitives.add(new Cesium.LabelCollection());
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    this.lines.show = visible; this.points.show = visible; this.labels.show = visible;
  }

  /** `{ tracks }` from /api/tracks; replaces everything drawn. */
  update(payload: unknown) {
    const tracks = ((payload as { tracks?: Track[] })?.tracks || []).filter((t) => t && Array.isArray(t.fixes) && t.fixes.length);
    this.clear();
    const { Cesium } = this;
    for (const track of tracks) {
      const color = Cesium.Color.fromCssColorString(track.military ? '#FFB300' : '#7DD3FC');
      const positions = track.fixes.map((f) => Cesium.Cartesian3.fromDegrees(f[3], f[2], altM(f)));
      const line = this.lines.add({ positions, width: 2, material: Cesium.Material.fromType('Color', { color: color.withAlpha(0.55) }) });
      const point = this.points.add({
        position: positions[0], pixelSize: track.military ? 8 : 6, color, outlineColor: Cesium.Color.BLACK.withAlpha(0.7), outlineWidth: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY, show: false, id: { layer: 'tracks', id: track.hex },
      });
      const label = this.byHex.size < MAX_LABELS ? this.labels.add({
        position: positions[0], text: track.callsign || track.hex.toUpperCase(), font: '600 10px "JetBrains Mono", ui-monospace, Menlo, monospace', fillColor: color,
        showBackground: true, backgroundColor: new Cesium.Color(0.04, 0.07, 0.1, 0.78), backgroundPadding: new Cesium.Cartesian2(7, 4),
        style: Cesium.LabelStyle.FILL, pixelOffset: new Cesium.Cartesian2(12, -12), disableDepthTestDistance: Number.POSITIVE_INFINITY, show: false,
      }) : null;
      this.byHex.set(track.hex, { track, line, point, label, contact: null });
    }
    this.setPlayhead(this.playhead || (tracks.length ? tracks[0].fixes[0][0] : 0));
  }

  setPlayhead(t: number) {
    this.playhead = t;
    for (const e of this.byHex.values()) {
      const p = positionAt(e.track.fixes, t);
      if (!p) { e.point.show = false; if (e.label) e.label.show = false; e.contact = null; continue; }
      const pos = this.Cesium.Cartesian3.fromDegrees(p.lng, p.lat, p.alt);
      e.point.position = pos; e.point.show = true;
      if (e.label) { e.label.position = pos; e.label.show = true; }
      const name = e.track.callsign || e.track.hex.toUpperCase();
      e.contact = { layer: 'tracks', id: e.track.hex, name, lat: p.lat, lng: p.lng, alt: p.alt, kind: e.track.military ? 'recorded military track' : 'recorded track',
        detail: `${Math.round(p.alt / FT_TO_M).toLocaleString()} ft · hdg ${Math.round(p.heading)}°${p.gsKt !== null ? ` · ${Math.round(p.gsKt)} kt` : ''} · ${e.track.fixes.length} fixes · ${new Date(t).toISOString().replace('T', ' ').slice(0, 19)} UTC` };
    }
  }

  playheadAt() { return this.playhead; }
  tracks(): Track[] { return [...this.byHex.values()].map((e) => e.track); }

  /** Follow-camera state at the PLAYHEAD (not wall time): same shape FlightsLayer.state returns. */
  state(hex: string) {
    const e = this.byHex.get(hex);
    if (!e) return null;
    const p = positionAt(e.track.fixes, this.playhead);
    return p ? { lat: p.lat, lng: p.lng, alt: p.alt, heading: p.heading, speedMps: (p.gsKt ?? 0) * 0.514444, coasting: false } : null;
  }

  /** In cockpit mode the aircraft's own marker would sit on the lens. */
  setPointHidden(hex: string, hidden: boolean) {
    const e = this.byHex.get(hex);
    if (!e) return;
    e.point.show = !hidden && e.contact !== null;
    if (e.label) e.label.show = !hidden && e.contact !== null;
  }

  tick() {}

  contact(id: string) { return this.byHex.get(id)?.contact ?? undefined; }

  *contacts(): Iterable<TheaterContact> {
    if (!this.visible) return;
    for (const e of this.byHex.values()) if (e.contact) yield e.contact;
  }

  /** aircraft alive at the playhead */
  count() { let n = 0; for (const e of this.byHex.values()) if (e.contact) n++; return n; }

  private clear() {
    this.lines.removeAll(); this.points.removeAll(); this.labels.removeAll();
    this.byHex.clear();
  }

  dispose() {
    this.viewer.scene.primitives.remove(this.lines);
    this.viewer.scene.primitives.remove(this.points);
    this.viewer.scene.primitives.remove(this.labels);
    this.byHex.clear();
  }
}
