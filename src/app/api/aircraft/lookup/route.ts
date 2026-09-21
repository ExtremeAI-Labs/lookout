// Who is that aircraft? GET /api/aircraft/lookup?hex=ADFDF8 | ?reg=N757AF — the public registry
// record (registration, type, owner, military / PIA / LADD flags) plus this console's last
// sighting. (The sibling /api/aircraft route serves ADS-B traces for the flat map's flight watch.)
import { NextResponse } from 'next/server';
import { aircraftDb } from '@/lib/aircraft-db';
import { watchlist } from '@/lib/watchlist';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const hex = (url.searchParams.get('hex') || '').trim();
  const reg = (url.searchParams.get('reg') || '').trim();
  if (!hex && !reg) return NextResponse.json({ error: 'hex or reg is required' }, { status: 400 });
  if (hex && !/^[0-9A-Fa-f]{6}$/.test(hex)) return NextResponse.json({ error: 'hex must be 6 hex digits' }, { status: 400 });
  if (reg && reg.length > 12) return NextResponse.json({ error: 'reg is too long' }, { status: 400 });
  try {
    const db = aircraftDb();
    const meta = await db.meta();
    if (!meta.ready) return NextResponse.json({ error: 'the aircraft registry is still downloading', registry: meta }, { status: 503 });
    const record = hex ? await db.lookupHex(hex) : await db.lookupReg(reg);
    if (!record) return NextResponse.json({ found: false, registry: meta }, { status: 404 });
    const sighting = watchlist().sighting(record.hex) ?? null;
    return NextResponse.json({ found: true, record, sighting, registry: meta }, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    console.error('[aircraft/lookup]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'lookup failed' }, { status: 500 });
  }
}
