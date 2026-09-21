// Export one aircraft's recorded track into a case: POST /api/tracks/export
// { caseId, hex, from, to, title? } → a hash-sealed Finding + an "observed" reconstruction item.
import { NextResponse } from 'next/server';
import { readCase, validId, writeCase } from '@/lib/cases';
import { RECON_MAX_ITEMS } from '@/lib/reconstruction';
import { applyTrackExport, buildTrackExport } from '@/lib/tracks/export';
import { startRecorderFromEnv } from '@/lib/tracks/service';
import { MAX_WINDOW_MS } from '@/lib/tracks/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 }); }
  const caseId = typeof body.caseId === 'string' ? body.caseId : '';
  const hex = typeof body.hex === 'string' ? body.hex.trim().toLowerCase() : '';
  const from = Date.parse(String(body.from ?? '')), to = Date.parse(String(body.to ?? ''));
  if (!validId(caseId)) return NextResponse.json({ error: 'caseId is invalid' }, { status: 400 });
  if (!/^~?[0-9a-f]{6}$/.test(hex)) return NextResponse.json({ error: 'hex must be a 6-digit ICAO address' }, { status: 400 });
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > MAX_WINDOW_MS) return NextResponse.json({ error: 'from/to must be ISO date-times spanning at most 6 hours' }, { status: 400 });
  const title = typeof body.title === 'string' ? body.title.slice(0, 160) : undefined;
  try {
    const c = await readCase(caseId);
    if (!c) return NextResponse.json({ error: 'case not found' }, { status: 404 });
    if ((c.reconstruction?.items.length ?? 0) >= RECON_MAX_ITEMS) return NextResponse.json({ error: `a reconstruction holds at most ${RECON_MAX_ITEMS} items` }, { status: 400 });
    const h = await startRecorderFromEnv();
    const w = await h.store.readWindow(from, to, { hex });
    const provenance = [];
    for (const day of w.days) provenance.push({ day, segments: (await h.store.readManifest(day)).segments });
    const built = buildTrackExport({ hex, fromMs: from, toMs: to, fixes: w.fixes, provenance, receiver: h.recorder?.status().url ?? 'receiver not configured', unsealedLines: w.unsealedLines, title });
    if ('error' in built) return NextResponse.json({ error: built.error }, { status: 404 });
    await writeCase(applyTrackExport(c, built));
    console.info(`[tracks/export] case=${caseId} hex=${hex} fixes=${(built.finding.data as { fixes: unknown[] }).fixes.length}`);
    return NextResponse.json({ ok: true, findingId: built.finding.id, sha256: built.finding.sha256, reconItemId: built.item.id, fixes: (built.finding.data as { fixes: unknown[] }).fixes.length, unsealedLines: w.unsealedLines }, { status: 201 });
  } catch (e) {
    console.error('[tracks/export]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'export failed' }, { status: 500 });
  }
}
