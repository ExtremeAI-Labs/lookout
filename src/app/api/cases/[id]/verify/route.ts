import { NextResponse } from 'next/server';
import { readCase, verifyCase } from '@/lib/cases';

export const dynamic = 'force-dynamic';

/** Re-hash each finding's stored data and report whether the record is unaltered since collection. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const c = await readCase(id);
  if (!c) return NextResponse.json({ error: 'case not found' }, { status: 404 });
  const results = verifyCase(c);
  const tampered = results.filter((r) => !r.ok);
  return NextResponse.json({
    id: c.id, name: c.name, checked: results.length,
    intact: tampered.length === 0, tampered, results,
    verified_at: new Date().toISOString(),
  });
}
