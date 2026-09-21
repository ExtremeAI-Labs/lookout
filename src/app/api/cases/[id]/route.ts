import { NextResponse } from 'next/server';
import { readCase, writeCase, deleteCase, newFinding, type Finding } from '@/lib/cases';
import { RECON_MAX_ITEMS, validateReconItem } from '@/lib/reconstruction';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const c = await readCase(id);
  if (!c) return NextResponse.json({ error: 'case not found' }, { status: 404 });
  return NextResponse.json(c);
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const c = await readCase(id);
  if (!c) return NextResponse.json({ error: 'case not found' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  if (typeof body?.name === 'string') c.name = body.name.slice(0, 120) || c.name;
  if (typeof body?.notes === 'string') c.notes = body.notes.slice(0, 20000);
  if (body?.addFinding) {
    const f = body.addFinding;
    const finding: Finding = newFinding({
      tool: String(f.tool || '').slice(0, 40),
      query: String(f.query || '').slice(0, 200),
      summary: f.summary ? String(f.summary).slice(0, 400) : undefined,
      analysis: f.analysis ? String(f.analysis).slice(0, 6000) : undefined,
      data: f.data ?? undefined,
    });
    c.findings = c.findings || [];
    c.findings.unshift(finding);   // newest first
  }
  if (typeof body?.deleteFindingId === 'string') {
    c.findings = (c.findings || []).filter((f) => f.id !== body.deleteFindingId);
  }
  // ── reconstruction items: validated, bounded, errors returned rather than guessed ──
  if (body?.addReconItem || body?.updateReconItem) {
    const recon = (c.reconstruction ??= { items: [] });
    const isUpdate = !!body.updateReconItem;
    const existing = isUpdate ? recon.items.find((i) => i.id === body.updateReconItem?.id) : undefined;
    if (isUpdate && !existing) return NextResponse.json({ error: 'reconstruction item not found' }, { status: 404 });
    if (!isUpdate && recon.items.length >= RECON_MAX_ITEMS) return NextResponse.json({ error: `a reconstruction holds at most ${RECON_MAX_ITEMS} items` }, { status: 400 });
    const v = validateReconItem(isUpdate ? body.updateReconItem : body.addReconItem, existing);
    if (!v.ok) return NextResponse.json({ error: 'invalid reconstruction item', details: v.errors }, { status: 400 });
    if (isUpdate) recon.items = recon.items.map((i) => (i.id === v.item.id ? v.item : i));
    else recon.items.push(v.item);
  }
  if (typeof body?.deleteReconItemId === 'string' && c.reconstruction) {
    c.reconstruction.items = c.reconstruction.items.filter((i) => i.id !== body.deleteReconItemId);
  }
  if (body?.reconAnchor && typeof body.reconAnchor === 'object') {
    const lat = Number(body.reconAnchor.lat), lng = Number(body.reconAnchor.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) (c.reconstruction ??= { items: [] }).anchor = { lat, lng };
  }
  await writeCase(c);
  return NextResponse.json(c);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ok = await deleteCase(id);
  return NextResponse.json({ ok }, { status: ok ? 200 : 404 });
}
