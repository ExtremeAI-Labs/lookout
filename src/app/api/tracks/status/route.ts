// Recorder + store status: is anything being recorded, from where, how much is on disk, and
// whether the latest sealed hours verify.
import { NextResponse } from 'next/server';
import { startRecorderFromEnv } from '@/lib/tracks/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const h = await startRecorderFromEnv();
    const days = await h.store.listDays();
    const totalBytes = days.reduce((n, d) => n + d.bytes, 0);
    const today = days[days.length - 1];
    const verify = today ? await h.store.verifyDay(today.day).catch(() => null) : null;
    return NextResponse.json({
      recorder: h.recorder ? h.recorder.status() : { configured: false, reason: h.reason },
      store: { dir: h.store.dir, days, totalBytes },
      latestDay: verify ? { day: verify.day, ok: verify.ok, sealedHours: verify.segments.length, unsealedBytes: verify.unsealedBytes } : null,
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    console.error('[tracks/status]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'could not read the track store' }, { status: 500 });
  }
}
