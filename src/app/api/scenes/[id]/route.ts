import { NextResponse } from 'next/server';
import { deleteScene, readScene, validSceneId, writeScene } from '@/lib/scenes';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!validSceneId(id)) return NextResponse.json({ error: 'bad id' }, { status: 400 });
  const scene = await readScene(id);
  return scene ? NextResponse.json({ scene }) : NextResponse.json({ error: 'not found' }, { status: 404 });
}

export async function PUT(req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!validSceneId(id)) return NextResponse.json({ error: 'bad id' }, { status: 400 });
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 }); }
  const doc = (body as { document?: unknown })?.document ?? body;
  if (!doc || typeof doc !== 'object' || (doc as { id?: unknown }).id !== id) return NextResponse.json({ error: 'document id must match the URL' }, { status: 400 });
  try {
    const r = await writeScene(doc);
    if (!r.ok) return NextResponse.json({ error: 'invalid scene document', details: r.errors }, { status: 400 });
    return NextResponse.json({ scene: r.doc });
  } catch (e) {
    console.error('[scenes] save failed:', e);
    return NextResponse.json({ error: 'could not save the scene' }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!validSceneId(id)) return NextResponse.json({ error: 'bad id' }, { status: 400 });
  return (await deleteScene(id)) ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'not found' }, { status: 404 });
}
