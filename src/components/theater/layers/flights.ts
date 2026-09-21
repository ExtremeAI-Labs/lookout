// Aircraft in the theater: one point per airframe, moved between polls by the motion
// model so the fleet glides instead of teleporting every 45 s. Two toggles share this
// layer — civil ("flights") and military — because they arrive in one payload.
import type * as CesiumNS from 'cesium';
import { TrackMotion } from '@/lib/theater/motion';
import type { TheaterContact, TheaterLayerId } from '@/lib/theater/layers';
import { scratchCartesian, type CesiumGlobal, type TheaterLayer } from './base';
import { classifyAircraft, modelFor, type AircraftClass } from '@/lib/theater/aircraft-class';

type Category = 'commercial' | 'private' | 'jet' | 'military';
type Aircraft = { id: string; category: Category; callsign: string; model: string; registration: string; grounded: boolean; notable?: { label: string; pack: string; reg: string }; contact: TheaterContact; lastReport: string };

const KNOTS_TO_MPS = 0.514444;
const COLORS: Record<Category, string> = { commercial: '#E8E6E0', private: '#7FDBFF', jet: '#D4AF37', military: '#FFB300' };
/** how long a last-known position keeps moving before it stops and dims (OpenSky's anonymous snapshot is 15 min) */
export const AIRCRAFT_MAX_COAST_MS = 10 * 60 * 1000;
/** older than this and the airframe is dropped from the scene */
const AIRCRAFT_MAX_AGE_MS = 20 * 60 * 1000;
/** 3D models: the selected/followed airframe always; the nearest few when the camera is low */
const MODEL_MAX_ALT_M = 6000;
const MODEL_RADIUS_M = 6000;
const MODEL_CAP = 10;
const MODEL_MIN_PIXELS = 40;
const MODEL_CREDIT = 'Aircraft models CC BY 4.0 — creators in /models/ATTRIBUTION.md';

type ModelEntry = { model: CesiumNS.Model | null; cls: AircraftClass; dead: boolean; groundH: number | null };

export class FlightsLayer implements TheaterLayer {
  readonly id: TheaterLayerId = 'flights';
  private points: CesiumNS.PointPrimitiveCollection;
  private byId = new Map<string, { a: Aircraft; point: CesiumNS.PointPrimitive }>();
  private motion = new TrackMotion({ maxCoastMs: AIRCRAFT_MAX_COAST_MS });
  private showCivil = true;
  private showMilitary = true;
  private colors: Record<Category, CesiumNS.Color>;
  private lastTick = 0;
  private modelPrims: CesiumNS.PrimitiveCollection;
  private models = new Map<string, ModelEntry>();
  private focusId: string | null = null;
  private lastModelScan = 0;
  private credited = false;

  constructor(private Cesium: CesiumGlobal, private viewer: CesiumNS.Viewer) {
    this.points = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
    this.modelPrims = viewer.scene.primitives.add(new Cesium.PrimitiveCollection());
    this.colors = Object.fromEntries(Object.entries(COLORS).map(([k, v]) => [k, Cesium.Color.fromCssColorString(v)])) as Record<Category, CesiumNS.Color>;
  }

  /** "flights" and "military" are two switches on one layer. */
  setCategoryVisible(which: 'flights' | 'military', visible: boolean) {
    if (which === 'flights') this.showCivil = visible; else this.showMilitary = visible;
    for (const { a, point } of this.byId.values()) point.show = !this.hidden.has(a.id) && this.visibleFor(a.category);
  }

  setVisible(visible: boolean) {
    this.showCivil = visible;
    this.showMilitary = visible;
    this.points.show = visible;
    this.modelPrims.show = visible;
  }

  /** the airframe that always gets a 3D model (selected or followed), or null */
  setFocus(id: string | null) { this.focusId = id; }
  /** models currently in the scene (loaded) */
  modelCount(): number { let n = 0; for (const m of this.models.values()) if (m.model) n++; return n; }

  private classOf(a: Aircraft): AircraftClass {
    const code = a.model && a.model !== 'Unknown' ? a.model : '';
    if (code) return classifyAircraft({ typeCode: code });
    return a.category === 'military' ? 'fastjet' : a.category === 'jet' ? 'bizjet' : a.category === 'private' ? 'light' : 'airliner';
  }

  /** which airframes carry a model right now: the focus, plus the nearest few when the camera is low */
  private scanModels(now: number) {
    const cam = this.viewer.camera.positionCartographic;
    const want = new Set<string>();
    if (this.focusId && this.byId.has(this.focusId)) want.add(this.focusId);
    if (Number.isFinite(cam.height) && cam.height < MODEL_MAX_ALT_M) {
      const lat = this.Cesium.Math.toDegrees(cam.latitude), lng = this.Cesium.Math.toDegrees(cam.longitude);
      const cosLat = Math.cos((lat * Math.PI) / 180);
      const near: { id: string; d2: number }[] = [];
      for (const { a } of this.byId.values()) {
        if (!this.visibleFor(a.category)) continue;
        const dLat = (a.contact.lat - lat) * 111_320, dLng = (a.contact.lng - lng) * 111_320 * cosLat;
        const d2 = dLat * dLat + dLng * dLng;
        if (d2 <= MODEL_RADIUS_M * MODEL_RADIUS_M) near.push({ id: a.id, d2 });
      }
      near.sort((x, y) => x.d2 - y.d2);
      for (const n of near) { if (want.size >= MODEL_CAP) break; want.add(n.id); }
    }
    for (const [id, m] of this.models) if (!want.has(id)) this.dropModel(id, m);
    for (const id of want) if (!this.models.has(id)) this.loadModel(id, now);
  }

  private loadModel(id: string, now: number) {
    const entry = this.byId.get(id);
    if (!entry) return;
    const cls = this.classOf(entry.a);
    const spec = modelFor(cls);
    const m: ModelEntry = { model: null, cls, dead: false, groundH: null };
    this.models.set(id, m);
    const pos = this.motion.positionAt(id, now);
    const start = pos ?? { lat: entry.a.contact.lat, lng: entry.a.contact.lng, alt: entry.a.contact.alt, heading: 0 };
    this.Cesium.Model.fromGltfAsync({ url: spec.url, modelMatrix: this.matrixFor(start.lng, start.lat, start.alt, start.heading, spec.headingOffsetDeg), scale: spec.scale, minimumPixelSize: MODEL_MIN_PIXELS, maximumScale: 40, id: { layer: 'flights', id }, allowPicking: true })
      .then((model) => {
        if (m.dead) { model.destroy(); return; }
        m.model = model;
        this.modelPrims.add(model);
        if (!this.credited) { this.credited = true; try { this.viewer.creditDisplay.addStaticCredit(new this.Cesium.Credit(MODEL_CREDIT, true)); } catch { /* credit display is decoration */ } }
        const e = this.byId.get(id);
        if (e) e.point.show = false;
      })
      .catch((err: unknown) => { console.warn('[theater] aircraft model failed to load', spec.url, err); this.models.delete(id); });
  }

  private dropModel(id: string, m: ModelEntry) {
    m.dead = true;
    if (m.model) { this.modelPrims.remove(m.model); m.model = null; }
    this.models.delete(id);
    const e = this.byId.get(id);
    if (e) e.point.show = !this.hidden.has(id) && this.visibleFor(e.a.category);
  }

  private matrixFor(lng: number, lat: number, alt: number, headingDeg: number, offsetDeg: number, result?: CesiumNS.Matrix4) {
    const { Cesium } = this;
    const position = Cesium.Cartesian3.fromDegrees(lng, lat, alt);
    const hpr = new Cesium.HeadingPitchRoll(Cesium.Math.toRadians(headingDeg + offsetDeg), 0, 0);
    return Cesium.Transforms.headingPitchRollToFixedFrame(position, hpr, Cesium.Ellipsoid.WGS84, undefined, result);
  }

  private visibleFor(c: Category) {
    return c === 'military' ? this.showMilitary : this.showCivil;
  }

  update(payload: unknown, now: number) {
    const p = (payload || {}) as Record<string, unknown[]>;
    const buckets: [Category, unknown[]][] = [
      ['commercial', p.commercial_flights || []],
      ['private', p.private_flights || []],
      ['jet', p.private_jets || []],
      ['military', p.military_flights || []],
    ];
    for (const [category, list] of buckets) {
      for (const raw of list as Record<string, unknown>[]) {
        const id = String(raw.icao24 || raw.callsign || '').toLowerCase();
        const lat = raw.lat as number, lng = raw.lng as number;
        if (!id || typeof lat !== 'number' || typeof lng !== 'number') continue;
        const alt = typeof raw.alt === 'number' ? raw.alt : 0;
        const heading = typeof raw.heading === 'number' ? raw.heading : 0;
        const speedMps = typeof raw.speed_knots === 'number' ? raw.speed_knots * KNOTS_TO_MPS : 0;
        // The feed re-serves an unchanged snapshot for minutes at a time (OpenSky's anonymous
        // interval is 15 min). Only a CHANGED report is a new fix; otherwise the motion model
        // would see a "fresh" fix every poll and freeze the aircraft on a stale position.
        const report = `${lat.toFixed(5)},${lng.toFixed(5)},${Math.round(alt)},${Math.round(heading)}`;
        const known = this.byId.get(id);
        if (!known || known.a.lastReport !== report) this.motion.addFix(id, { lat, lng, alt, heading, speedMps, t: now });
        const callsign = String(raw.callsign || '').trim() || id.toUpperCase();
        let entry = this.byId.get(id);
        if (!entry) {
          const point = this.points.add({
            position: this.Cesium.Cartesian3.fromDegrees(lng, lat, alt),
            pixelSize: category === 'military' ? 7 : 5,
            color: this.colors[category],
            outlineColor: this.Cesium.Color.BLACK.withAlpha(0.6),
            outlineWidth: 1,
            scaleByDistance: new this.Cesium.NearFarScalar(2.0e5, 1.4, 8.0e6, 0.5),
            id: { layer: 'flights', id },
          });
          entry = { a: { id, category, callsign, model: '', registration: '', grounded: false, lastReport: report, contact: { layer: 'flights', id, name: callsign, lat, lng, alt, kind: category } }, point };
          this.byId.set(id, entry);
        }
        const a = entry.a;
        a.lastReport = report;
        a.category = category;
        a.callsign = callsign;
        a.model = String(raw.model || '');
        a.registration = String(raw.registration || '');
        a.grounded = !!raw.grounded;
        const notable = raw.notable && typeof raw.notable === 'object' ? (raw.notable as { label: string; pack: string; reg: string }) : undefined;
        a.notable = notable;
        a.contact.name = callsign;
        a.contact.kind = category;
        a.contact.detail = `${a.model && a.model !== 'Unknown' ? a.model + ' · ' : ''}${Math.round(alt * 3.28084).toLocaleString()} ft · ${Math.round(speedMps / KNOTS_TO_MPS)} kt`;
        // A watched airframe: larger, amber-red, and always labelled so it cannot be missed.
        entry.point.color = notable ? this.Cesium.Color.fromCssColorString('#FF5A36') : this.colors[category];
        entry.point.pixelSize = notable ? 10 : category === 'military' ? 7 : 5;
        entry.point.outlineColor = notable ? this.Cesium.Color.fromCssColorString('#FFD8CC').withAlpha(0.9) : this.Cesium.Color.BLACK.withAlpha(0.6);
        entry.point.outlineWidth = notable ? 2 : 1;
        this.syncNotableLabel(a, notable ? `★ ${notable.label}${callsign && callsign !== notable.label ? ` · ${callsign}` : ''}` : null);
        entry.point.show = !this.hidden.has(id) && this.visibleFor(category);
      }
    }
    // airframes that stopped reporting
    for (const [id, entry] of this.byId) {
      if (!this.motion.has(id)) { const m = this.models.get(id); if (m) this.dropModel(id, m); this.points.remove(entry.point); this.syncNotableLabel(entry.a, null); this.byId.delete(id); }
    }
    this.motion.prune(now, AIRCRAFT_MAX_AGE_MS);
    for (const [id, entry] of this.byId) {
      if (!this.motion.has(id)) { this.points.remove(entry.point); this.syncNotableLabel(entry.a, null); this.byId.delete(id); }
    }
  }

  tick(now: number) {
    // 4 Hz is plenty: a jet moves ~60 m between updates, invisible at any sane view height.
    if (now - this.lastTick < 250) return;
    this.lastTick = now;
    const scratch = scratchCartesian(this.Cesium);
    for (const { a, point } of this.byId.values()) {
      const pos = this.motion.positionAt(a.id, now);
      if (!pos) continue;
      this.Cesium.Cartesian3.fromDegrees(pos.lng, pos.lat, pos.alt, undefined, scratch);
      point.position = scratch;
      a.contact.lat = pos.lat; a.contact.lng = pos.lng; a.contact.alt = pos.alt;
      const nl = this.notableLabelById.get(a.id);
      if (nl) nl.position = scratch;
      const m = this.models.get(a.id);
      if (m?.model) {
        const spec = modelFor(m.cls);
        let alt = pos.alt;
        if (a.grounded) {
          if (m.groundH === null) { try { const h = this.viewer.scene.sampleHeight(this.Cesium.Cartographic.fromDegrees(pos.lng, pos.lat)); m.groundH = typeof h === 'number' && Number.isFinite(h) ? h : 0; } catch { m.groundH = 0; } }
          alt = m.groundH + spec.bellyM;
        }
        this.matrixFor(pos.lng, pos.lat, alt, pos.heading, spec.headingOffsetDeg, m.model.modelMatrix);
        m.model.show = !this.hidden.has(a.id) && this.visibleFor(a.category);
        if (point.show) point.show = false;
      }
      // a position that is only a guess by now reads dimmer than a fresh one
      const alpha = pos.coasting ? 0.35 : 1;
      if (point.color.alpha !== alpha) point.color = (a.notable ? this.Cesium.Color.fromCssColorString('#FF5A36') : this.colors[a.category]).withAlpha(alpha);
    }
    if (this.labelAround && Math.floor(now / 1000) !== Math.floor((now - 250) / 1000)) this.refreshLabels(now);
    if (now - this.lastModelScan > 1000) { this.lastModelScan = now; this.scanModels(now); }
  }

  private hidden = new Set<string>();
  private labels: CesiumNS.LabelCollection | null = null;
  private notableLabels: CesiumNS.LabelCollection | null = null;
  private notableLabelById = new Map<string, CesiumNS.Label>();

  /** Watched airframes keep a label whatever the follow state; null removes it. */
  private syncNotableLabel(a: Aircraft, text: string | null) {
    const existing = this.notableLabelById.get(a.id);
    if (!text) { if (existing) { this.notableLabels?.remove(existing); this.notableLabelById.delete(a.id); } return; }
    const coll = this.notableLabels ?? (this.notableLabels = this.viewer.scene.primitives.add(new this.Cesium.LabelCollection()));
    if (existing) { existing.text = text; return; }
    this.notableLabelById.set(a.id, coll.add({
      position: this.Cesium.Cartesian3.fromDegrees(a.contact.lng, a.contact.lat, a.contact.alt),
      text, font: '600 11px "JetBrains Mono", ui-monospace, Menlo, monospace', fillColor: this.Cesium.Color.fromCssColorString('#FFE3DB'),
      showBackground: true, backgroundColor: this.Cesium.Color.fromCssColorString('#7A1F10').withAlpha(0.85), backgroundPadding: new this.Cesium.Cartesian2(8, 5),
      style: this.Cesium.LabelStyle.FILL, pixelOffset: new this.Cesium.Cartesian2(0, -18), disableDepthTestDistance: Number.POSITIVE_INFINITY,
    }));
  }
  private labelAround: string | null = null;

  /** In cockpit view the followed airframe's own dot would sit on the lens. */
  setPointHidden(id: string, hidden: boolean) {
    if (hidden) this.hidden.add(id); else this.hidden.delete(id);
    const entry = this.byId.get(id);
    if (entry) entry.point.show = !hidden && this.visibleFor(entry.a.category);
  }

  /** Callsign + flight level over every aircraft within 80 km of `id` — the cockpit's contacts in the sky. */
  setLabelsAround(id: string | null) {
    this.labelAround = id;
    if (!id && this.labels) { this.labels.removeAll(); }
  }

  private refreshLabels(now: number) {
    if (!this.labelAround) return;
    const me = this.motion.positionAt(this.labelAround, now);
    if (!me) return;
    const labels: CesiumNS.LabelCollection = this.labels ?? (this.labels = this.viewer.scene.primitives.add(new this.Cesium.LabelCollection()));
    labels.removeAll();
    const cosLat = Math.cos((me.lat * Math.PI) / 180);
    let n = 0;
    for (const { a, point } of this.byId.values()) {
      if (a.id === this.labelAround || !point.show || n >= 60) continue;
      const dLat = (a.contact.lat - me.lat) * 111.32, dLng = (a.contact.lng - me.lng) * 111.32 * cosLat;
      if (dLat * dLat + dLng * dLng > 80 * 80) continue;
      n++;
      labels.add({
        position: this.Cesium.Cartesian3.fromDegrees(a.contact.lng, a.contact.lat, a.contact.alt),
        text: `${a.callsign}  FL${String(Math.round((a.contact.alt * 3.28084) / 100)).padStart(3, '0')}`,
        // Boxed chip, the God's Eye label language: mono on a glass tile, no outline.
        font: '600 10px "JetBrains Mono", ui-monospace, Menlo, monospace',
        fillColor: this.colors[a.category],
        showBackground: true,
        backgroundColor: new this.Cesium.Color(0.04, 0.07, 0.1, 0.78),
        backgroundPadding: new this.Cesium.Cartesian2(7, 4),
        style: this.Cesium.LabelStyle.FILL,
        pixelOffset: new this.Cesium.Cartesian2(0, -16),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new this.Cesium.NearFarScalar(5.0e3, 1.0, 1.5e5, 0.55),
      });
    }
  }

  /** current dead-reckoned state, for the follow camera */
  state(id: string, now: number) {
    return this.motion.positionAt(id, now);
  }

  contact(id: string) {
    return this.byId.get(id)?.a.contact;
  }

  *contacts(): Iterable<TheaterContact> {
    for (const { a, point } of this.byId.values()) if (point.show) yield a.contact;
  }

  count() {
    let n = 0;
    for (const { point } of this.byId.values()) if (point.show) n++;
    return n;
  }

  dispose() {
    for (const [id, m] of this.models) this.dropModel(id, m);
    this.viewer.scene.primitives.remove(this.modelPrims);
    this.viewer.scene.primitives.remove(this.points);
    if (this.labels) this.viewer.scene.primitives.remove(this.labels);
    if (this.notableLabels) this.viewer.scene.primitives.remove(this.notableLabels);
    this.byId.clear();
  }
}
