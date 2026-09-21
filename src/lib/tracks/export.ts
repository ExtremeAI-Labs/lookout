// Exporting a recorded track into a case: a hash-sealed Finding carrying the fixes and the
// store's segment hashes for that window (so the finding can be tied back to the sealed
// recording), plus a Reconstruction item with basis "observed" — the receiver saw it.
import { newFinding, type CaseFile, type Finding } from '@/lib/cases';
import { validateReconItem, type ReconItem } from '@/lib/reconstruction';
import { groupTracks, type Segment, type StoredFix } from './store';

export type TrackExportInput = {
  hex: string;
  fromMs: number;
  toMs: number;
  fixes: StoredFix[];
  /** sealed segments covering the window, per day */
  provenance: { day: string; segments: Segment[] }[];
  receiver: string;
  /** how many of the fixes came from the unsealed tail */
  unsealedLines: number;
  title?: string;
};

export function buildTrackExport(input: TrackExportInput): { finding: Finding; item: ReconItem } | { error: string } {
  const track = groupTracks(input.fixes).find((t) => t.hex === input.hex.toLowerCase());
  if (!track || !track.fixes.length) return { error: 'no fixes for that aircraft in the window' };
  const first = track.fixes[0], last = track.fixes[track.fixes.length - 1];
  const name = track.callsign || track.hex.toUpperCase();
  const startIso = new Date(first[0]).toISOString(), endIso = new Date(last[0]).toISOString();
  const finding = newFinding({
    tool: 'track',
    query: `${track.hex} ${startIso} → ${endIso}`,
    summary: `${name}: ${track.fixes.length} recorded fixes from the operator's receiver (${input.receiver}), ${startIso.slice(11, 19)}–${endIso.slice(11, 19)} UTC${input.unsealedLines ? ` · ${input.unsealedLines} fixes from the still-open hour` : ' · all from sealed hours'}`,
    data: {
      hex: track.hex, callsign: track.callsign || null, military: track.military,
      window: { from: new Date(input.fromMs).toISOString(), to: new Date(input.toMs).toISOString() },
      format: '[t_ms, hex, lat, lng, alt_ft, track_deg, gs_kt, callsign, flags, nac_p]',
      fixes: track.fixes,
      source: { kind: 'own-receiver', receiver: input.receiver, provenance: input.provenance, unsealedLines: input.unsealedLines },
    },
  });
  const v = validateReconItem({
    kind: 'track',
    basis: 'observed',
    title: (input.title?.trim() || `Track ${name}`).slice(0, 160),
    findingId: finding.id,
    at: { lat: first[2], lng: first[3], headingDeg: first[5] ?? undefined },
    eventTime: { start: startIso, end: endIso },
    source: { label: `Own receiver · ${input.receiver}`, sha256: finding.sha256 },
    note: `${track.fixes.length} fixes; alt ${first[4] ?? '?'}→${last[4] ?? '?'} ft. Finding ${finding.id} carries the fixes and the sealed-hour hashes.`,
  });
  if (!v.ok) return { error: v.errors.join('; ') };
  return { finding, item: v.item };
}

export function applyTrackExport(c: CaseFile, built: { finding: Finding; item: ReconItem }): CaseFile {
  c.findings = c.findings || [];
  c.findings.unshift(built.finding);
  c.reconstruction = c.reconstruction ?? { items: [] };
  c.reconstruction.items.push(built.item);
  return c;
}
