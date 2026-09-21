// Annotations — the operator's own marks on the 3D scene: a pin, a label, an outline (polygon)
// or a measured line. They are assertions by the person drawing them, never observations, and
// they say so when filed into a case. Pure model + geometry here; drawing lives in the theater.

export type AnnotationKind = 'pin' | 'label' | 'outline' | 'measure';
export type AnnotationPoint = { lat: number; lng: number; alt?: number };
export type Annotation = {
  id: string;
  kind: AnnotationKind;
  label?: string;
  points: AnnotationPoint[];
  color?: string;
  createdAt: string;
};

export const ANNOTATION_KINDS: AnnotationKind[] = ['pin', 'label', 'outline', 'measure'];
export const ANNOTATION_MAX = 200;
export const ANNOTATION_MAX_POINTS = 500;
const MIN_POINTS: Record<AnnotationKind, number> = { pin: 1, label: 1, outline: 3, measure: 2 };
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function newAnnotationId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ? `an-${uuid.slice(0, 8)}` : `an-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Bounded, never throws; returns errors instead of guessing. */
export function validateAnnotation(input: unknown, existing?: Annotation): { ok: true; item: Annotation } | { ok: false; errors: string[] } {
  const e: string[] = [];
  const x = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const kind = String(x.kind ?? '') as AnnotationKind;
  if (!ANNOTATION_KINDS.includes(kind)) e.push(`kind must be one of ${ANNOTATION_KINDS.join(', ')}`);
  const label = typeof x.label === 'string' ? x.label.trim().slice(0, 80) : '';
  if (kind === 'label' && !label) e.push('a label annotation needs text');
  const raw = Array.isArray(x.points) ? x.points : [];
  const points: AnnotationPoint[] = [];
  for (const p of raw.slice(0, ANNOTATION_MAX_POINTS)) {
    const q = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
    const lat = Number(q.lat), lng = Number(q.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) { e.push('every point needs lat/lng in range'); break; }
    const pt: AnnotationPoint = { lat, lng };
    const alt = Number(q.alt);
    if (q.alt !== undefined && q.alt !== null && Number.isFinite(alt)) pt.alt = alt;
    points.push(pt);
  }
  if (kind && MIN_POINTS[kind] && points.length < MIN_POINTS[kind]) e.push(`${kind} needs at least ${MIN_POINTS[kind]} point${MIN_POINTS[kind] > 1 ? 's' : ''}`);
  if (raw.length > ANNOTATION_MAX_POINTS) e.push(`at most ${ANNOTATION_MAX_POINTS} points`);
  const color = typeof x.color === 'string' && COLOR_RE.test(x.color) ? x.color : undefined;
  if (typeof x.color === 'string' && !color) e.push('color must be #rrggbb');
  if (e.length) return { ok: false, errors: [...new Set(e)] };
  return { ok: true, item: { id: existing?.id ?? (typeof x.id === 'string' && /^[A-Za-z0-9_-]{2,40}$/.test(x.id) ? x.id : newAnnotationId()), kind, points, createdAt: existing?.createdAt ?? new Date().toISOString(), ...(label ? { label } : {}), ...(color ? { color } : {}) } };
}

const R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversineM(a: AnnotationPoint, b: AnnotationPoint): number {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Sum of great-circle legs, metres. */
export function pathLengthM(points: AnnotationPoint[]): number {
  let m = 0;
  for (let i = 1; i < points.length; i++) m += haversineM(points[i - 1], points[i]);
  return m;
}

/** Polygon area in m² — planar (equirectangular about the centroid), fine for the sizes people outline. */
export function polygonAreaM2(points: AnnotationPoint[]): number {
  if (points.length < 3) return 0;
  const lat0 = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const k = Math.cos(rad(lat0));
  const xy = points.map((p) => [rad(p.lng) * R * k, rad(p.lat) * R]);
  let a = 0;
  for (let i = 0; i < xy.length; i++) { const [x1, y1] = xy[i], [x2, y2] = xy[(i + 1) % xy.length]; a += x1 * y2 - x2 * y1; }
  return Math.abs(a) / 2;
}

export function centroid(points: AnnotationPoint[]): AnnotationPoint {
  const n = Math.max(1, points.length);
  return { lat: points.reduce((s, p) => s + p.lat, 0) / n, lng: points.reduce((s, p) => s + p.lng, 0) / n, alt: points.reduce((s, p) => s + (p.alt ?? 0), 0) / n };
}

const FT = 3.28084, MI = 1609.344, NMI = 1852;
export function formatDistance(m: number): string {
  if (m < 1000) return `${Math.round(m)} m · ${Math.round(m * FT).toLocaleString()} ft`;
  return `${(m / 1000).toFixed(m < 10_000 ? 2 : 1)} km · ${(m / MI).toFixed(2)} mi · ${(m / NMI).toFixed(2)} nmi`;
}
export function formatArea(m2: number): string {
  if (m2 < 10_000) return `${Math.round(m2).toLocaleString()} m² · ${Math.round(m2 * FT * FT).toLocaleString()} ft²`;
  const acres = m2 / 4046.856;
  return `${(m2 / 1e6).toFixed(m2 < 1e6 ? 3 : 2)} km² · ${acres.toFixed(acres < 10 ? 2 : 1)} acres`;
}

/** The measure worth reading back for a given annotation, or null. */
export function measureOf(a: Annotation): { kind: 'length' | 'area'; value: number; text: string } | null {
  if (a.kind === 'measure') { const v = pathLengthM(a.points); return { kind: 'length', value: v, text: formatDistance(v) }; }
  if (a.kind === 'outline') { const v = polygonAreaM2(a.points); return { kind: 'area', value: v, text: formatArea(v) }; }
  return null;
}
