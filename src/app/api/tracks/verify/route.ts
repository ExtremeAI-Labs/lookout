// Recompute a day's sealed-hour hashes and chain: GET /api/tracks/verify?day=YYYY-MM-DD
import { NextResponse } from 'next/server';
import { startRecorderFromEnv } from '@/lib/tracks/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const day = new URL(req.url).searchParams.get('day') || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return NextResponse.json({ error: 'day must be YYYY-MM-DD' }, { status: 400 });
  try {
    const h = await startRecorderFromEnv();
    return NextResponse.json(await h.store.verifyDay(day), { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    console.error('[tracks/verify]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'verification failed to run' }, { status: 500 });
  }
}
