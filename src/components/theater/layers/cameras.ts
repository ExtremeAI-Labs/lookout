// Cameras and canvass devices in the theater. Public cameras are pins (the catalogue has
// no bearings). Canvass devices — the OSM/DeFlock survey — get a view cone on the ground
// when a bearing is mapped, drawn as the sector the tag describes. Where nothing is mapped
// nothing is drawn: an invented cone would be a false statement about what a camera sees.
import type * as CesiumNS from 'cesium';
import { distanceKm, type TheaterContact, type TheaterLayerId } from '@/lib/theater/layers';
import type { CesiumGlobal, TheaterLayer } from './base';

type Cam = { id: string; contact: TheaterContact; raw: Record<string, unknown> };

const CAMERA_COLOR = '#00E676';
const DEVICE_COLORS: Record<string, string> = { ALPR: '#FF4FA3', camera: '#FFB300', gunshot: '#9AA0B4' };
const CONE_LENGTH_M = 60;
const CONE_HALF_ANGLE_DEG = 30;

function sector(Cesium: CesiumGlobal, lat: number, lng: number, bearing: number, lengthM: number, halfAngle: number): CesiumNS.Cartesian3[] {
  const pts: number[] = [lng, lat];
  const dLat = (m: number) => m / 111_320;
  const dLng = (m: number) => m / (111_320 * Math.cos((lat * Math.PI) / 180));
  for (let a = bearing - halfAngle; a <= bearing + halfAngle; a += 10) {
    const r = (a * Math.PI) / 180;
    pts.push(lng + dLng(lengthM * Math.sin(r)), lat + dLat(lengthM * Math.cos(r)));
  }
  return Cesium.Cartesian3.fromDegreesArray(pts);
}

abstract class PointLayer implements TheaterLayer {
  abstract readonly id: TheaterLayerId;
  protected points: CesiumNS.PointPrimitiveCollection;
  protected byId = new Map<string, { c: Cam; point: CesiumNS.PointPrimitive }>();
  protected visible = true;

  constructor(protected Cesium: CesiumGlobal, protected viewer: CesiumNS.Viewer) {
    this.points = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    this.points.show = visible;
  }

  protected upsert(id: string, lat: number, lng: number, color: string, size: number, contact: TheaterContact, raw: Record<string, unknown>) {
    let entry = this.byId.get(id);
    if (!entry) {
      const point = this.points.add({
        position: this.Cesium.Cartesian3.fromDegrees(lng, lat, 2),
        pixelSize: size,
        color: this.Cesium.Color.fromCssColorString(color),
        outlineColor: this.Cesium.Color.BLACK.withAlpha(0.7),
        outlineWidth: 1,
        scaleByDistance: new this.Cesium.NearFarScalar(5.0e3, 1.3, 2.0e6, 0.4),
        // pins sit on the ground; do not let a 3D building in front swallow them
        disableDepthTestDistance: 2000,
        id: { layer: this.id, id },
      });
      entry = { c: { id, contact, raw }, point };
      this.byId.set(id, entry);
    } else {
      entry.c.contact = contact;
      entry.c.raw = raw;
    }
    return entry;
  }

  tick(_now: number) {}

  contact(id: string) {
    return this.byId.get(id)?.c.contact;
  }

  rawOf(id: string) {
    return this.byId.get(id)?.c.raw;
  }

  *contacts(): Iterable<TheaterContact> {
    if (!this.visible) return;
    for (const { c } of this.byId.values()) yield c.contact;
  }

  count() {
    return this.byId.size;
  }

  dispose() {
    this.viewer.scene.primitives.remove(this.points);
    this.byId.clear();
  }

  abstract update(payload: unknown, now: number): void;
}

/** Staging: below this height, snapshot cameras near the view show their latest frame in the scene. */
const STAGE_MAX_ALT_M = 6000;
const STAGE_RADIUS_M = 3500;
const STAGE_CAP = 18;
const STAGE_REFRESH_MS = 60_000;
const STAGE_CONCURRENCY = 4;
const STAGE_HEIGHT_M = 34;
const CARD_W = 176, CARD_H = 118, CARD_IMG_H = 99;

type Staged = { id: string; billboard: CesiumNS.Billboard; stem: CesiumNS.Polyline; lastLoad: number; loading: boolean; failures: number; loaded: boolean };

/** A frame drawn as a little card: 2 px frame, the image, a caption strip with the camera's name. */
function frameCard(img: HTMLImageElement | null, name: string, note?: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = CARD_W; c.height = CARD_H;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(8, 12, 18, 0.92)'; g.fillRect(0, 0, CARD_W, CARD_H);
  if (img) { try { g.drawImage(img, 2, 2, CARD_W - 4, CARD_IMG_H - 2); } catch { /* tainted or broken image: keep the dark card */ } }
  else { g.fillStyle = 'rgba(255,255,255,0.06)'; g.fillRect(2, 2, CARD_W - 4, CARD_IMG_H - 2); g.fillStyle = 'rgba(232,234,237,0.55)'; g.font = '600 10px "JetBrains Mono", ui-monospace, Menlo, monospace'; g.textAlign = 'center'; g.fillText(note || 'loading frame…', CARD_W / 2, CARD_IMG_H / 2 + 4); g.textAlign = 'left'; }
  g.strokeStyle = 'rgba(0, 230, 118, 0.9)'; g.lineWidth = 2; g.strokeRect(1, 1, CARD_W - 2, CARD_H - 2);
  g.fillStyle = '#e8eaed'; g.font = '600 9.5px "JetBrains Mono", ui-monospace, Menlo, monospace';
  let text = name.toUpperCase();
  while (text.length > 4 && g.measureText(text).width > CARD_W - 12) text = text.slice(0, -2);
  if (text !== name.toUpperCase()) text += '…';
  g.fillText(text, 6, CARD_H - 7);
  return c;
}

export class CamerasLayer extends PointLayer {
  readonly id: TheaterLayerId = 'cctv';
  private billboards: CesiumNS.BillboardCollection;
  private stems: CesiumNS.PolylineCollection;
  private staged = new Map<string, Staged>();
  private lastStageScan = 0;
  private inflight = 0;

  constructor(Cesium: CesiumGlobal, viewer: CesiumNS.Viewer) {
    super(Cesium, viewer);
    this.billboards = viewer.scene.primitives.add(new Cesium.BillboardCollection({ scene: viewer.scene }));
    this.stems = viewer.scene.primitives.add(new Cesium.PolylineCollection());
  }

  setVisible(visible: boolean) {
    super.setVisible(visible);
    this.billboards.show = visible; this.stems.show = visible;
    if (!visible) this.unstageAll();
  }

  /** frames currently staged in the scene (and how many have a picture) */
  stagedCount(): { staged: number; loaded: number } {
    let loaded = 0;
    for (const s of this.staged.values()) if (s.loaded) loaded++;
    return { staged: this.staged.size, loaded };
  }

  /** nearest camera to a point regardless of the layer's visibility (for the NEAREST hand-off) */
  nearestTo(lat: number, lng: number): { contact: TheaterContact; raw: Record<string, unknown>; distanceKm: number } | null {
    let best: { contact: TheaterContact; raw: Record<string, unknown>; distanceKm: number } | null = null;
    for (const { c } of this.byId.values()) {
      const d = distanceKm(lat, lng, c.contact.lat, c.contact.lng);
      if (!best || d < best.distanceKm) best = { contact: c.contact, raw: c.raw, distanceKm: d };
    }
    return best;
  }

  tick(now: number) {
    if (!this.visible || now - this.lastStageScan < 2000) return;
    this.lastStageScan = now;
    const cam = this.viewer.camera.positionCartographic;
    const alt = cam.height;
    if (!Number.isFinite(alt) || alt > STAGE_MAX_ALT_M) { if (this.staged.size) this.unstageAll(); return; }
    const lat = this.Cesium.Math.toDegrees(cam.latitude), lng = this.Cesium.Math.toDegrees(cam.longitude);
    // snapshot cameras within the radius, nearest first
    const near: { id: string; d: number }[] = [];
    for (const [id, { c }] of this.byId) {
      if (c.raw.stream_type !== 'jpg' || !c.raw.feed_url) continue;
      const dLat = Math.abs(c.contact.lat - lat) * 111_320;
      if (dLat > STAGE_RADIUS_M) continue;
      const d = distanceKm(lat, lng, c.contact.lat, c.contact.lng) * 1000;
      if (d <= STAGE_RADIUS_M) near.push({ id, d });
    }
    near.sort((a, b) => a.d - b.d);
    const keep = new Set(near.slice(0, STAGE_CAP).map((n) => n.id));
    for (const id of [...this.staged.keys()]) if (!keep.has(id)) this.unstage(id);
    for (const id of keep) if (!this.staged.has(id)) this.stage(id);
    for (const s of this.staged.values()) {
      if (this.inflight >= STAGE_CONCURRENCY) break;
      if (!s.loading && s.failures < 3 && now - s.lastLoad > (s.loaded ? STAGE_REFRESH_MS : 0)) this.loadFrame(s, now);
    }
  }

  private stage(id: string) {
    const e = this.byId.get(id);
    if (!e) return;
    const { Cesium } = this;
    const { lat, lng, name } = e.c.contact;
    const top = Cesium.Cartesian3.fromDegrees(lng, lat, STAGE_HEIGHT_M);
    const billboard = this.billboards.add({
      position: top, image: frameCard(null, name), verticalOrigin: Cesium.VerticalOrigin.BOTTOM, pixelOffset: new Cesium.Cartesian2(0, -4),
      scale: 0.85, scaleByDistance: new Cesium.NearFarScalar(600, 1.0, STAGE_MAX_ALT_M, 0.3), disableDepthTestDistance: 2500, id: { layer: 'cctv', id },
    });
    const stem = this.stems.add({ positions: [Cesium.Cartesian3.fromDegrees(lng, lat, 2), top], width: 1.5, material: Cesium.Material.fromType('Color', { color: Cesium.Color.fromCssColorString(CAMERA_COLOR).withAlpha(0.75) }) });
    this.staged.set(id, { id, billboard, stem, lastLoad: 0, loading: false, failures: 0, loaded: false });
  }

  private loadFrame(s: Staged, now: number) {
    const e = this.byId.get(s.id);
    if (!e) return;
    const feed = String(e.c.raw.feed_url || '');
    s.loading = true; s.lastLoad = now; this.inflight++;
    const img = new Image();
    const done = () => { s.loading = false; this.inflight = Math.max(0, this.inflight - 1); };
    img.onload = () => { done(); if (!this.staged.has(s.id)) return; s.loaded = true; s.failures = 0; s.billboard.setImage(`cam:${s.id}:${now}`, frameCard(img, e.c.contact.name)); };
    img.onerror = () => { done(); if (!this.staged.has(s.id)) return; s.failures++; if (!s.loaded) s.billboard.setImage(`cam:${s.id}:fail${s.failures}`, frameCard(null, e.c.contact.name, s.failures >= 3 ? 'no frame' : 'retrying…')); };
    img.src = `/api/cctv/proxy?url=${encodeURIComponent(feed)}&t=${Math.floor(now / STAGE_REFRESH_MS)}`;
  }

  private unstage(id: string) {
    const s = this.staged.get(id);
    if (!s) return;
    this.billboards.remove(s.billboard); this.stems.remove(s.stem);
    this.staged.delete(id);
  }
  private unstageAll() { for (const id of [...this.staged.keys()]) this.unstage(id); }

  dispose() {
    this.unstageAll();
    this.viewer.scene.primitives.remove(this.billboards);
    this.viewer.scene.primitives.remove(this.stems);
    super.dispose();
  }

  /** payload = a batch of catalogue cameras (loadCameraCatalog delivers several) */
  update(payload: unknown) {
    const list = (Array.isArray(payload) ? payload : (payload as { cameras?: unknown[] })?.cameras || []) as Record<string, unknown>[];
    for (const raw of list) {
      const id = String(raw.id || '');
      const lat = raw.lat as number, lng = raw.lng as number;
      if (!id || typeof lat !== 'number' || typeof lng !== 'number') continue;
      const name = String(raw.name || raw.city || id);
      const live = raw.stream_type && raw.stream_type !== 'jpg';
      this.upsert(id, lat, lng, CAMERA_COLOR, 6, {
        layer: 'cctv', id, name, lat, lng, alt: 0, kind: live ? 'live camera' : 'camera',
        detail: [raw.source, raw.city].filter(Boolean).join(' · '),
      }, raw);
    }
  }
}

export class CanvassLayer extends PointLayer {
  readonly id: TheaterLayerId = 'canvass';
  private cones = new Map<string, CesiumNS.Entity>();

  /** payload = /api/canvass around the view; replaces what was there (it is a ring, not a stream) */
  update(payload: unknown) {
    const list = ((payload as { cameras?: unknown[] })?.cameras || []) as Record<string, unknown>[];
    const keep = new Set<string>();
    for (const raw of list) {
      const id = String(raw.id || '');
      const lat = raw.lat as number, lng = raw.lng as number;
      if (!id || typeof lat !== 'number' || typeof lng !== 'number') continue;
      keep.add(id);
      const type = String(raw.type || 'camera');
      const color = DEVICE_COLORS[type] || DEVICE_COLORS.camera;
      const label = type === 'ALPR' ? 'plate reader' : type === 'gunshot' ? 'gunshot sensor' : 'camera';
      const operator = String(raw.operator || '');
      this.upsert(id, lat, lng, color, 7, {
        layer: 'canvass', id, name: operator ? `${operator} ${label}` : label, lat, lng, alt: 0, kind: label,
        detail: [raw.zone, raw.mount, raw.cameraType].filter((x) => x && x !== 'fixed').join(' · '),
      }, raw);
      const direction = typeof raw.direction === 'number' ? raw.direction : Number.NaN;
      if (Number.isFinite(direction) && !this.cones.has(id)) {
        this.cones.set(id, this.viewer.entities.add({
          polygon: {
            hierarchy: new this.Cesium.PolygonHierarchy(sector(this.Cesium, lat, lng, direction, CONE_LENGTH_M, CONE_HALF_ANGLE_DEG)),
            material: this.Cesium.Color.fromCssColorString(color).withAlpha(0.22),
            outline: false,
            classificationType: this.Cesium.ClassificationType.BOTH,
          },
          show: this.visible,
        }));
      }
    }
    for (const [id, entry] of this.byId) {
      if (!keep.has(id)) {
        this.points.remove(entry.point); this.byId.delete(id);
        const cone = this.cones.get(id);
        if (cone) { this.viewer.entities.remove(cone); this.cones.delete(id); }
      }
    }
  }

  setVisible(visible: boolean) {
    super.setVisible(visible);
    for (const cone of this.cones.values()) cone.show = visible;
  }

  dispose() {
    for (const cone of this.cones.values()) this.viewer.entities.remove(cone);
    this.cones.clear();
    super.dispose();
  }
}
