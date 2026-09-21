// Annotations drawn into the scene: pins, labels, outlines (polygon + edge + area), measured
// lines (with length). A draft is drawn dashed while the operator is still clicking points.
// Heights: a clicked point carries the height it was picked at; a point handed in without one
// is sampled against whatever is loaded (3D tiles or terrain) so it sits on the surface.
import type * as CesiumNS from 'cesium';
import { centroid, measureOf, type Annotation, type AnnotationKind, type AnnotationPoint } from '@/lib/theater/annotations';
import type { CesiumGlobal } from './base';

const DEFAULT_COLOR = '#00d4ff';
/** the current skin's accent, read from the theater root so marks match the chrome */
function accent(): string {
  try { const v = getComputedStyle(document.querySelector('.theater') as Element).getPropertyValue('--accent').trim(); return v || DEFAULT_COLOR; } catch { return DEFAULT_COLOR; }
}
const FONT = '600 11px "JetBrains Mono", ui-monospace, Menlo, monospace';

export class AnnotationsLayer {
  private ds: CesiumNS.CustomDataSource;
  private draftIds: CesiumNS.Entity[] = [];

  constructor(private Cesium: CesiumGlobal, private viewer: CesiumNS.Viewer) {
    this.ds = new Cesium.CustomDataSource('annotations');
    void viewer.dataSources.add(this.ds);
  }

  private alt(p: AnnotationPoint): number {
    if (typeof p.alt === 'number') return p.alt + 1.5;
    try {
      const h = this.viewer.scene.sampleHeight(this.Cesium.Cartographic.fromDegrees(p.lng, p.lat));
      return (typeof h === 'number' && Number.isFinite(h) ? h : 0) + 1.5;
    } catch { return 1.5; }
  }
  private pos(p: AnnotationPoint) { return this.Cesium.Cartesian3.fromDegrees(p.lng, p.lat, this.alt(p)); }

  private labelEntity(at: AnnotationPoint, text: string, css: string, id: string, offsetY = -16) {
    const { Cesium } = this;
    return this.ds.entities.add({ id, position: this.pos(at), label: { text, font: FONT, fillColor: Cesium.Color.fromCssColorString('#f4fbff'), showBackground: true, backgroundColor: Cesium.Color.fromCssColorString(css).withAlpha(0.55), backgroundPadding: new Cesium.Cartesian2(8, 5), style: Cesium.LabelStyle.FILL, pixelOffset: new Cesium.Cartesian2(0, offsetY), disableDepthTestDistance: Number.POSITIVE_INFINITY, verticalOrigin: Cesium.VerticalOrigin.BOTTOM } });
  }

  private draw(a: Annotation, draft: boolean): CesiumNS.Entity[] {
    const { Cesium } = this;
    const css = a.color ?? accent();
    const color = Cesium.Color.fromCssColorString(css);
    const out: CesiumNS.Entity[] = [];
    const idp = `${draft ? 'draft' : a.id}`;
    const m = measureOf(a);
    const positions = a.points.map((p) => this.pos(p));
    if (a.kind === 'pin' || a.kind === 'label') {
      const p = a.points[0];
      if (a.kind === 'pin') out.push(this.ds.entities.add({ id: `${idp}:pt`, position: positions[0], point: { pixelSize: 11, color, outlineColor: Cesium.Color.BLACK.withAlpha(0.8), outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY } }));
      if (a.label) out.push(this.labelEntity(p, a.label, css, `${idp}:lbl`, a.kind === 'pin' ? -18 : 0));
      return out;
    }
    const dashed = draft ? new Cesium.PolylineDashMaterialProperty({ color: color.withAlpha(0.9), dashLength: 12 }) : new Cesium.ColorMaterialProperty(color);
    if (a.kind === 'measure') {
      if (positions.length > 1) out.push(this.ds.entities.add({ id: `${idp}:ln`, polyline: { positions, width: 3, material: dashed, arcType: Cesium.ArcType.GEODESIC } }));
      a.points.forEach((p, i) => out.push(this.ds.entities.add({ id: `${idp}:v${i}`, position: positions[i], point: { pixelSize: 7, color: Cesium.Color.WHITE, outlineColor: color, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY } })));
      if (m && a.points.length > 1) out.push(this.labelEntity(a.points[Math.floor((a.points.length - 1) / 2)], `${a.label ? a.label + ' · ' : ''}${m.text}`, css, `${idp}:lbl`));
      return out;
    }
    // outline
    if (positions.length >= 3 && !draft) out.push(this.ds.entities.add({ id: `${idp}:poly`, polygon: { hierarchy: new Cesium.PolygonHierarchy(positions), material: color.withAlpha(0.18), perPositionHeight: true } }));
    if (positions.length > 1) out.push(this.ds.entities.add({ id: `${idp}:edge`, polyline: { positions: draft ? positions : [...positions, positions[0]], width: 2.5, material: dashed, arcType: Cesium.ArcType.GEODESIC } }));
    a.points.forEach((p, i) => out.push(this.ds.entities.add({ id: `${idp}:v${i}`, position: positions[i], point: { pixelSize: 6, color, outlineColor: Cesium.Color.BLACK.withAlpha(0.7), outlineWidth: 1, disableDepthTestDistance: Number.POSITIVE_INFINITY } })));
    if (!draft && m) out.push(this.labelEntity(centroid(a.points), `${a.label ? a.label + ' · ' : ''}${m.text}`, css, `${idp}:lbl`, 0));
    return out;
  }

  /** Redraw everything from the list (cheap at these counts). */
  set(items: Annotation[]) {
    const keep = new Set(this.draftIds);
    for (const e of [...this.ds.entities.values]) if (!keep.has(e)) this.ds.entities.remove(e);
    for (const a of items) this.draw(a, false);
  }

  /** The annotation being drawn right now (dashed); pass null to clear. */
  draft(kind: AnnotationKind | null, points: AnnotationPoint[], label?: string) {
    for (const e of this.draftIds) this.ds.entities.remove(e);
    this.draftIds = [];
    if (!kind || !points.length) return;
    this.draftIds = this.draw({ id: 'draft', kind, points, label, createdAt: '' }, true);
  }

  setVisible(v: boolean) { this.ds.show = v; }
  dispose() { void this.viewer.dataSources.remove(this.ds, true); }
}
