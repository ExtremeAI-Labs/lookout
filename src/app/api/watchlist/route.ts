// The aircraft watchlist: packs (resolved from the public registry), custom tail numbers, sightings.
//   GET  /api/watchlist                → packs + custom with last sightings, registry status
//   POST /api/watchlist {query,label,note} → add a tail number / hex to the custom list
//   PATCH /api/watchlist {pack,enabled} → switch a pack on/off
//   DELETE /api/watchlist?id=          → remove a custom entry
import { NextResponse } from 'next/server';
import { aircraftDb } from '@/lib/aircraft-db';
import { watchlist, type WatchPackId, PACKS } from '@/lib/watchlist';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const w = watchlist();
    const status = await w.status();
    const sightings = url.searchParams.get('sightings') === '1' ? await w.recentSightings(200) : undefined;
    return NextResponse.json({ ...status, ...(sightings ? { sightings } : {}) }, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    console.error('[watchlist]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'could not read the watchlist' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 }); }
  const query = typeof body.query === 'string' ? body.query : '';
  if (!query.trim()) return NextResponse.json({ error: 'query (tail number or hex) is required' }, { status: 400 });
  try {
    if (!(await aircraftDb().meta()).ready) return NextResponse.json({ error: 'the aircraft registry is still downloading — try again in a minute' }, { status: 503 });
    const r = await watchlist().addCustom(query, typeof body.label === 'string' ? body.label : undefined, typeof body.note === 'string' ? body.note : undefined);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
    console.info(`[watchlist] added ${r.item.reg || r.item.hex} (${r.item.label})`);
    return NextResponse.json(r.item, { status: 201 });
  } catch (e) {
    console.error('[watchlist] add', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'could not add to the watchlist' }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 }); }
  const pack = String(body.pack || '') as WatchPackId;
  if (!PACKS.some((p) => p.id === pack) || typeof body.enabled !== 'boolean') return NextResponse.json({ error: 'pack and enabled (boolean) are required' }, { status: 400 });
  await watchlist().setPackEnabled(pack, body.enabled);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get('id') || '';
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });
  const ok = await watchlist().remove(id);
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'not a custom watchlist entry' }, { status: 404 });
}
