// Case Reconstruction — the evidence in a case placed where and when it happened, so a
// clock can replay it. Two clocks and a basis label are mandatory data, not decoration:
//   eventTime     when it happened (may be unknown, may be a range)
//   collectedTime when it entered the case — always known
//   basis         reported (someone said so) · observed (a sensor/witness saw it) ·
//                 derived (we inferred it) — and "derived" must never render like "observed".
// The gap between the two clocks is what cross-examination goes after; the basis is what
// stops a convincing picture standing in for corroboration.

export type ReconKind = 'clip' | 'photo' | 'camera_hit' | 'track' | 'note' | 'imagery';
export type ReconBasis = 'reported' | 'observed' | 'derived';

export type ReconItem = {
  id: string;
  /** links to a hash-sealed Finding when there is one */
  findingId?: string;
  kind: ReconKind;
  title: string;
  at?: { lat: number; lng: number; headingDeg?: number };
  /** ISO instant, or a range; null = unknown */
  eventTime: { start: string; end?: string } | null;
  /** ISO instant */
  collectedTime: string;
  basis: ReconBasis;
  source: { label: string; url?: string; sha256?: string };
  /** an image / video / page the item points at */
  mediaUrl?: string;
  note?: string;
};

export type Reconstruction = { items: ReconItem[]; anchor?: { lat: number; lng: number } };

export const RECON_KINDS: ReconKind[] = ['clip', 'photo', 'camera_hit', 'track', 'note', 'imagery'];
export const RECON_BASES: ReconBasis[] = ['reported', 'observed', 'derived'];
export const RECON_MAX_ITEMS = 500;

const isIso = (s: unknown): s is string => typeof s === 'string' && s.length >= 10 && !Number.isNaN(Date.parse(s));
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const url = (v: unknown) => {
  const s = str(v, 2000);
  if (!s) return undefined;
  try { const u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : undefined; } catch { return undefined; }
};

export function newReconId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ? `ri-${uuid}` : `ri-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Bounded, never throws; unknown fields dropped; returns errors instead of guessing. */
export function validateReconItem(input: unknown, existing?: ReconItem): { ok: true; item: ReconItem } | { ok: false; errors: string[] } {
  const e: string[] = [];
  const x = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const kind = str(x.kind, 20) as ReconKind;
  if (!RECON_KINDS.includes(kind)) e.push(`kind must be one of ${RECON_KINDS.join(', ')}`);
  const basis = str(x.basis, 20) as ReconBasis;
  if (!RECON_BASES.includes(basis)) e.push(`basis must be one of ${RECON_BASES.join(', ')}`);
  const title = str(x.title, 160);
  if (!title) e.push('title is required');

  let at: ReconItem['at'];
  if (x.at !== undefined && x.at !== null) {
    const a = x.at as Record<string, unknown>;
    const lat = Number(a.lat), lng = Number(a.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) e.push('at.lat / at.lng out of range');
    else {
      at = { lat, lng };
      const h = Number(a.headingDeg);
      if (a.headingDeg !== undefined && a.headingDeg !== null && a.headingDeg !== '') {
        if (Number.isFinite(h)) at.headingDeg = ((h % 360) + 360) % 360; else e.push('at.headingDeg must be a number');
      }
    }
  }

  let eventTime: ReconItem['eventTime'] = null;
  if (x.eventTime !== undefined && x.eventTime !== null && x.eventTime !== '') {
    const t = typeof x.eventTime === 'string' ? { start: x.eventTime } : (x.eventTime as Record<string, unknown>);
    if (!isIso(t.start)) e.push('eventTime.start must be an ISO date-time');
    else {
      eventTime = { start: new Date(t.start).toISOString() };
      if (t.end !== undefined && t.end !== null && t.end !== '') {
        if (!isIso(t.end)) e.push('eventTime.end must be an ISO date-time');
        else if (Date.parse(t.end) < Date.parse(t.start)) e.push('eventTime.end is before start');
        else eventTime.end = new Date(t.end).toISOString();
      }
    }
  }

  const src = (x.source && typeof x.source === 'object' ? x.source : {}) as Record<string, unknown>;
  const sourceLabel = str(src.label, 200);
  if (!sourceLabel) e.push('source.label is required — where did this come from?');
  const sourceUrl = url(src.url);
  if (src.url && !sourceUrl) e.push('source.url must be an http(s) URL');
  const sha = str(src.sha256, 64);
  if (sha && !/^[0-9a-f]{64}$/.test(sha)) e.push('source.sha256 must be 64 hex characters');
  const mediaUrl = url(x.mediaUrl);
  if (x.mediaUrl && !mediaUrl) e.push('mediaUrl must be an http(s) URL');

  if (e.length) return { ok: false, errors: e };
  const item: ReconItem = {
    id: existing?.id ?? (str(x.id, 64) || newReconId()),
    kind, title, basis, eventTime,
    collectedTime: existing?.collectedTime ?? (isIso(x.collectedTime) ? new Date(x.collectedTime as string).toISOString() : new Date().toISOString()),
    source: { label: sourceLabel, ...(sourceUrl ? { url: sourceUrl } : {}), ...(sha ? { sha256: sha } : {}) },
  };
  const findingId = str(x.findingId, 64);
  if (findingId) item.findingId = findingId;
  if (at) item.at = at;
  if (mediaUrl) item.mediaUrl = mediaUrl;
  const note = str(x.note, 4000);
  if (note) item.note = note;
  return { ok: true, item };
}

export const eventStartMs = (i: ReconItem): number | null => (i.eventTime ? Date.parse(i.eventTime.start) : null);
export const eventEndMs = (i: ReconItem): number | null => (i.eventTime ? Date.parse(i.eventTime.end ?? i.eventTime.start) : null);

/** Known times first in order; unknown times last, in the order they were collected. */
export function sortByEvent(items: ReconItem[]): ReconItem[] {
  return [...items].sort((a, b) => {
    const ta = eventStartMs(a), tb = eventStartMs(b);
    if (ta === null && tb === null) return a.collectedTime < b.collectedTime ? -1 : 1;
    if (ta === null) return 1;
    if (tb === null) return -1;
    return ta - tb;
  });
}

export function timelineBounds(items: ReconItem[]): { start: number; end: number } | null {
  let start = Infinity, end = -Infinity;
  for (const i of items) {
    const s = eventStartMs(i), e = eventEndMs(i);
    if (s !== null) { start = Math.min(start, s); end = Math.max(end, e ?? s); }
  }
  return Number.isFinite(start) ? { start, end: Math.max(end, start + 60_000) } : null;
}

/** What has "happened" by a given moment: items whose event has started, plus items with no time at all (they are never hidden, only flagged). */
export function visibleAt(items: ReconItem[], playheadMs: number): ReconItem[] {
  return items.filter((i) => { const s = eventStartMs(i); return s === null || s <= playheadMs; });
}

/** Minutes between collection and event — the number opposing counsel will ask about. */
export function collectionLagMinutes(i: ReconItem): number | null {
  const s = eventStartMs(i);
  return s === null ? null : Math.round((Date.parse(i.collectedTime) - s) / 60_000);
}

/** The reconstruction as a 3D shot list: one shot per placed item, in event order. */
export function sceneShotsFromReconstruction(items: ReconItem[]): { camera: { lat: number; lng: number; alt: number; heading: number; pitch: number }; label: string; durationSec: number; holdSec: number; layers: Record<string, boolean> }[] {
  return sortByEvent(items)
    .filter((i) => i.at)
    .map((i) => ({
      camera: { lat: i.at!.lat, lng: i.at!.lng, alt: 450, heading: i.at!.headingDeg ?? 0, pitch: -50 },
      label: `${i.basis.toUpperCase()} · ${i.title}`.slice(0, 80),
      durationSec: 3,
      holdSec: 4,
      layers: { cctv: true, canvass: true },
    }));
}
