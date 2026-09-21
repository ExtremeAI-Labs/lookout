import { NextResponse } from 'next/server';
import { listCases, createCase } from '@/lib/cases';

export const dynamic = 'force-dynamic';

export async function GET() {
  try { return NextResponse.json({ cases: await listCases() }); }
  catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : String(e), cases: [] }, { status: 500 }); }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const name = String(body?.name || '').slice(0, 120);
    const c = await createCase(name);
    return NextResponse.json(c, { status: 201 });
  } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 }); }
}
