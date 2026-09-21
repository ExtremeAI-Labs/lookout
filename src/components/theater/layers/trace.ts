// The flown path of one aircraft over the last day, drawn where it actually was: a 3D line
// coloured by altitude (an orbit becomes a stacked loop, a hold a spring), with a playhead the
// operator can scrub or run. Source is adsb.lol's readsb trace (community receivers), so a
// gap in the line is a gap in coverage, and the panel says so.
import type * as CesiumNS from 'cesium';
import { distanceKm } from '@/lib/theater/layers';
import type { CesiumGlobal } from './base';

export type TraceDetail = {
  icao24: string; registration: string | null; typeCode: string | null; model: string | null; operator: string | null;
  track: [number, number][]; altitudes: (number | null)[]; times?: (number | null)[]; speeds?: (number | null)[];
  points: number; source: string;
};

export type TraceInfo = {
  icao24: string; label: string; points: number;
  /** unix seconds, null when the trace carried no clock */
  from: number | null; to: number | null;
  distanceKm: number; minAltFt: number | null; maxAltFt: number | null;
  center: { lat: number; lng: number }; spanM: number; replayable: boolean; source: string;
};

export type TracePlayState = { t: number | null; playing: boolean; rate: number; altFt: number | null; speedKt: number | null; fraction: number };

const FT = 0.3048;
const GROUND_ALT_M = 25;

/** altitude fraction 0..1 → sky-blue → amber → red */
function altColor(Cesium: CesiumGlobal, f: number, ground: boolean): CesiumNS.Color {
  if (ground) return Cesium.Color.fromCssColorString('#8b93a7');
  const a = Cesium.Color.fromCssColorString('#38bdf8'), b = Cesium.Color.fromCssColorString('#facc15'), c = Cesium.Color.fromCssColorString('#ff5a36');
  return f < 0.5 ? Cesium.Color.lerp(a, b, f * 2, new Cesium.Color()) : Cesium.Color.lerp(b, c, (f - 0.5) * 2, new Cesium.Color());
}

export class TraceLayer {
  private primitives: CesiumNS.PrimitiveCollection;
  private points: CesiumNS.PointPrimitiveCollection;
  private labels: CesiumNS.LabelCollection;
  private line: CesiumNS.Primitive | null = null;
  private head: CesiumNS.PointPrimitive | null = null;
  private headLabel: CesiumNS.Label | null = null;
  private info: TraceInfo | null = null;
  private sphere: CesiumNS.BoundingSphere | null = null;
  /** replay arrays: only the points that carry a time */
  private tt: number[] = [];
  private pp: CesiumNS.Cartesian3[] = [];
  private aa: (number | null)[] = [];
  private ss: (number | null)[] = [];
  private t: number | null = null;
  private playing = false;
  private rate = 120;
  private lastTick = 0;

  constructor(private Cesium: CesiumGlobal, private viewer: CesiumNS.Viewer) {
    this.primitives = viewer.scene.primitives.add(new Cesium.PrimitiveCollection());
    this.points = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
    this.labels = viewer.scene.primitives.add(new Cesium.LabelCollection());
  }

  show(d: TraceDetail): TraceInfo {
    this.clear();
    const { Cesium } = this;
    const n = Math.min(d.track.length, d.altitudes.length);
    const alts = d.altitudes.slice(0, n);
    const known = alts.filter((a): a is number => typeof a === 'number');
    const minAlt = known.length ? Math.min(...known) : null, maxAlt = known.length ? Math.max(...known) : null;
    const span = maxAlt !== null && minAlt !== null ? Math.max(1, maxAlt - minAlt) : 1;
    const positions: CesiumNS.Cartesian3[] = [];
    const colors: CesiumNS.Color[] = [];
    let dist = 0, latSum = 0, lngSum = 0;
    for (let i = 0; i < n; i++) {
      const [lng, lat] = d.track[i];
      const alt = alts[i];
      positions.push(Cesium.Cartesian3.fromDegrees(lng, lat, alt === null ? GROUND_ALT_M : Math.max(GROUND_ALT_M, alt * FT)));
      colors.push(altColor(Cesium, alt === null || minAlt === null ? 0 : (alt - minAlt) / span, alt === null));
      latSum += lat; lngSum += lng;
      if (i > 0) dist += distanceKm(d.track[i - 1][1], d.track[i - 1][0], lat, lng);
    }
    const center = n ? { lat: latSum / n, lng: lngSum / n } : { lat: 0, lng: 0 };
    let spanM = 0;
    for (let i = 0; i < n; i++) spanM = Math.max(spanM, distanceKm(center.lat, center.lng, d.track[i][1], d.track[i][0]) * 1000);
    this.sphere = positions.length ? Cesium.BoundingSphere.fromPoints(positions) : null;
    if (positions.length > 1) {
      this.line = this.primitives.add(new Cesium.Primitive({
        geometryInstances: new Cesium.GeometryInstance({ geometry: new Cesium.PolylineGeometry({ positions, width: 3.5, colors, colorsPerVertex: true, arcType: Cesium.ArcType.NONE }) }),
        appearance: new Cesium.PolylineColorAppearance({ translucent: false }),
        asynchronous: false,
      }));
    }
    const times = (d.times || []).slice(0, n);
    for (let i = 0; i < n; i++) {
      const t = times[i];
      if (typeof t === 'number') { this.tt.push(t); this.pp.push(positions[i]); this.aa.push(alts[i]); this.ss.push(d.speeds?.[i] ?? null); }
    }
    const replayable = this.tt.length > 1;
    const from = replayable ? this.tt[0] : null, to = replayable ? this.tt[this.tt.length - 1] : null;
    const hhmm = (s: number) => new Date(s * 1000).toISOString().slice(11, 16) + 'Z';
    if (n) {
      this.points.add({ position: positions[0], pixelSize: 7, color: Cesium.Color.fromCssColorString('#4ade80'), outlineColor: Cesium.Color.BLACK.withAlpha(0.7), outlineWidth: 1, disableDepthTestDistance: Number.POSITIVE_INFINITY });
      this.points.add({ position: positions[n - 1], pixelSize: 7, color: Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK.withAlpha(0.7), outlineWidth: 1, disableDepthTestDistance: Number.POSITIVE_INFINITY });
      const font = '600 10px "JetBrains Mono", ui-monospace, Menlo, monospace';
      const bg = new Cesium.Color(0.04, 0.07, 0.1, 0.72);
      this.labels.add({ position: positions[0], text: `START${from !== null ? ' ' + hhmm(from) : ''}`, font, fillColor: Cesium.Color.fromCssColorString('#4ade80'), showBackground: true, backgroundColor: bg, backgroundPadding: new Cesium.Cartesian2(5, 3), pixelOffset: new Cesium.Cartesian2(0, -12), verticalOrigin: Cesium.VerticalOrigin.BOTTOM, disableDepthTestDistance: Number.POSITIVE_INFINITY });
      this.labels.add({ position: positions[n - 1], text: `LATEST${to !== null ? ' ' + hhmm(to) : ''}`, font, fillColor: Cesium.Color.WHITE, showBackground: true, backgroundColor: bg, backgroundPadding: new Cesium.Cartesian2(5, 3), pixelOffset: new Cesium.Cartesian2(0, -12), verticalOrigin: Cesium.VerticalOrigin.BOTTOM, disableDepthTestDistance: Number.POSITIVE_INFINITY });
      this.head = this.points.add({ position: positions[n - 1], pixelSize: 11, color: Cesium.Color.fromCssColorString('#ffb300'), outlineColor: Cesium.Color.BLACK.withAlpha(0.8), outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY, show: false });
      this.headLabel = this.labels.add({ position: positions[n - 1], text: '', font, fillColor: Cesium.Color.fromCssColorString('#ffb300'), showBackground: true, backgroundColor: bg, backgroundPadding: new Cesium.Cartesian2(5, 3), pixelOffset: new Cesium.Cartesian2(0, 16), verticalOrigin: Cesium.VerticalOrigin.TOP, disableDepthTestDistance: Number.POSITIVE_INFINITY, show: false });
    }
    const label = [d.registration, d.model && d.model !== 'Unknown' ? d.model : d.typeCode].filter(Boolean).join(' · ') || d.icao24.toUpperCase();
    this.info = { icao24: d.icao24, label, points: n, from, to, distanceKm: dist, minAltFt: minAlt, maxAltFt: maxAlt, center, spanM, replayable, source: d.source };
    this.t = to;
    this.playing = false;
    return this.info;
  }

  current(): TraceInfo | null { return this.info; }
  /** the whole path, for framing — robust to routes that cross the antimeridian */
  boundingSphere(): CesiumNS.BoundingSphere | null { return this.sphere; }

  state(): TracePlayState {
    const i = this.indexAt(this.t);
    const from = this.info?.from ?? null, to = this.info?.to ?? null;
    const fraction = this.t !== null && from !== null && to !== null && to > from ? (this.t - from) / (to - from) : 1;
    return { t: this.t, playing: this.playing, rate: this.rate, altFt: i >= 0 ? this.aa[i] : null, speedKt: i >= 0 ? this.ss[i] : null, fraction };
  }

  private indexAt(t: number | null): number {
    if (t === null || !this.tt.length) return -1;
    let lo = 0, hi = this.tt.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.tt[mid] <= t) lo = mid; else hi = mid - 1; }
    return lo;
  }

  /** move the playhead to a fraction of the recorded window (0 = start, 1 = latest) */
  seek(fraction: number) {
    const from = this.info?.from, to = this.info?.to;
    if (from == null || to == null) return;
    this.setTime(from + Math.min(1, Math.max(0, fraction)) * (to - from));
  }

  setTime(t: number) {
    if (!this.info?.replayable || !this.head || !this.headLabel) return;
    const from = this.info.from as number, to = this.info.to as number;
    this.t = Math.min(to, Math.max(from, t));
    const i = this.indexAt(this.t);
    const j = Math.min(i + 1, this.pp.length - 1);
    const span = this.tt[j] - this.tt[i];
    const f = span > 0 ? (this.t - this.tt[i]) / span : 0;
    const pos = this.Cesium.Cartesian3.lerp(this.pp[i], this.pp[j], f, new this.Cesium.Cartesian3());
    this.head.position = pos; this.headLabel.position = pos;
    const alt = this.aa[i], spd = this.ss[i];
    this.headLabel.text = `${new Date(this.t * 1000).toISOString().slice(11, 19)}Z${alt !== null ? ` · ${Math.round(alt).toLocaleString()} ft` : ' · ground'}${spd !== null ? ` · ${Math.round(spd)} kt` : ''}`;
    const atEnd = this.t >= to;
    this.head.show = !atEnd; this.headLabel.show = !atEnd;
    if (atEnd) this.playing = false;
  }

  setPlaying(on: boolean) {
    if (!this.info?.replayable) return;
    if (on && this.t !== null && this.info.to !== null && this.t >= this.info.to) this.setTime(this.info.from as number);
    this.playing = on;
    this.lastTick = 0;
  }
  setRate(r: number) { this.rate = Math.max(1, Math.min(3600, r)); }

  tick(nowMs: number) {
    if (!this.playing || this.t === null) return;
    if (!this.lastTick) { this.lastTick = nowMs; return; }
    const dt = (nowMs - this.lastTick) / 1000;
    this.lastTick = nowMs;
    this.setTime(this.t + dt * this.rate);
  }

  clear() {
    if (this.line) { this.primitives.remove(this.line); this.line = null; }
    this.points.removeAll(); this.labels.removeAll();
    this.head = null; this.headLabel = null; this.info = null; this.sphere = null;
    this.tt = []; this.pp = []; this.aa = []; this.ss = [];
    this.t = null; this.playing = false;
  }

  dispose() {
    this.clear();
    this.viewer.scene.primitives.remove(this.primitives);
    this.viewer.scene.primitives.remove(this.points);
    this.viewer.scene.primitives.remove(this.labels);
  }
}
