// Recorded tracks for a time window (≤ 6 h): GET /api/tracks?from=<ISO|ms>&to=<ISO|ms>[&hex=&bbox=w,s,e,n&limit=]
import { NextResponse } from 'next/server';
import { startRecorderFromEnv } from '@/lib/tracks/service';
import { groupTracks, MAX_WINDOW_MS } from '@/lib/tracks/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const parseTime = (v: string | null): number | null => {
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n) && n > 1e11) return n;
  const p = Date.parse(v);
  return Number.isFinite(p) ? p : null;
};

export async function GET(req: Request) {
  const url = new URL(req.url);
  const from = parseTime(url.searchParams.get('from')), to = parseTime(url.searchParams.get('to'));
  if (from === null || to === null) return NextResponse.json({ error: 'from and to are required (ISO date-time or ms since epoch)' }, { status: 400 });
  if (to <= from) return NextResponse.json({ error: 'to must be after from' }, { status: 400 });
  if (to - from > MAX_WINDOW_MS) return NextResponse.json({ error: `window is limited to ${MAX_WINDOW_MS / 3_600_000} hours` }, { status: 400 });
  const hexRaw = url.searchParams.get('hex');
  const hex = hexRaw ? hexRaw.trim().toLowerCase() : undefined;
  if (hex && !/^~?[0-9a-f]{6}$/.test(hex)) return NextResponse.json({ error: 'hex must be a 6-digit ICAO address' }, { status: 400 });
  let bbox: [number, number, number, number] | undefined;
  const bboxRaw = url.searchParams.get('bbox');
  if (bboxRaw) {
    const parts = bboxRaw.split(',').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n)) || parts[0] >= parts[2] || parts[1] >= parts[3]) return NextResponse.json({ error: 'bbox must be west,south,east,north' }, { status: 400 });
    bbox = parts as [number, number, number, number];
  }
  const limitRaw = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200_000) : undefined;
  try {
    const h = await startRecorderFromEnv();
    const w = await h.store.readWindow(from, to, { hex, bbox, limit });
    const tracks = groupTracks(w.fixes);
    return NextResponse.json({
      from: new Date(from).toISOString(), to: new Date(to).toISOString(),
      tracks, trackCount: tracks.length, fixCount: w.fixes.length, truncated: w.truncated,
      sealedLines: w.sealedLines, unsealedLines: w.unsealedLines, days: w.days,
      recorder: h.recorder ? { url: h.recorder.status().url } : { configured: false, reason: h.reason },
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    console.error('[tracks]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'could not read the track store' }, { status: 500 });
  }
}
