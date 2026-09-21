/**
 * Lookout — scenes (3D theater shot lists). GET lists them; POST creates one, either
 * from a title or from a full document (an import). Local files under the data root (LOOKOUT_DATA_DIR).
 */
import { NextResponse } from 'next/server';
import { createScene, listScenes, writeScene } from '@/lib/scenes';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json({ scenes: await listScenes() });
  } catch (e) {
    console.error('[scenes] list failed:', e);
    return NextResponse.json({ error: 'could not read the scene store' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 }); }
  const b = body as { title?: unknown; document?: unknown };
  try {
    if (b?.document !== undefined) {
      const r = await writeScene(b.document);
      if (!r.ok) return NextResponse.json({ error: 'invalid scene document', details: r.errors }, { status: 400 });
      return NextResponse.json({ scene: r.doc }, { status: 201 });
    }
    if (typeof b?.title !== 'string' || !b.title.trim()) return NextResponse.json({ error: 'title is required' }, { status: 400 });
    return NextResponse.json({ scene: await createScene(b.title) }, { status: 201 });
  } catch (e) {
    console.error('[scenes] create failed:', e);
    return NextResponse.json({ error: 'could not save the scene' }, { status: 500 });
  }
}
