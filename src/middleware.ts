import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { ALLOW_LAN, DEMO_MODE, classifyHost, isBlockedDemoPath, isSafeMethod, readAccessConfig, verifyAccessJwt } from '@/lib/access-guard';

// Who may talk to this install, decided per request (src/lib/access-guard.ts):
//   hosted demo (LOOKOUT_DEMO=1): read-only, denylist — a showcase, nothing to log in to;
//   self-hosted: loopback always; the LAN when LOOKOUT_ALLOW_LAN=1; a public hostname only behind
//   Cloudflare Access with a verified token. No analytics of any kind run here.

function refuse(request: NextRequest, status: 401 | 403 | 404, message: string, reason: string) {
  console.warn(`[access] refused ${request.method} ${request.nextUrl.pathname} host=${request.headers.get('host') || '-'}: ${reason}`);
  return request.nextUrl.pathname.startsWith('/api/')
    ? NextResponse.json({ error: message }, { status })
    : new NextResponse(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (DEMO_MODE) {
    if (isBlockedDemoPath(pathname)) return refuse(request, 404, 'not available in this public demo', 'demo denylist');
    if (!isSafeMethod(request.method)) return refuse(request, 404, 'not available in this public demo', `method ${request.method} is disabled — the demo is read-only`);
    return NextResponse.next();
  }
  const access = readAccessConfig(process.env);
  const kind = classifyHost(request.headers.get('host'), access.publicHost);
  if (kind === 'other' && !ALLOW_LAN) return refuse(request, 403, 'Lookout is not served on this address (set LOOKOUT_ALLOW_LAN=1 to admit your network).', 'not loopback and not the public hostname');
  if (kind === 'public') {
    const token = request.headers.get('cf-access-jwt-assertion') || request.cookies.get('CF_Authorization')?.value;
    const verdict = await verifyAccessJwt(token, access);
    if (!verdict.ok) return refuse(request, 401, 'Sign in through Cloudflare Access to use Lookout.', verdict.reason);
  }
  return NextResponse.next();
}

export const config = {
  // Everything except Next's own static chunks — the guard has to see page views, API calls and vendor assets.
  matcher: ['/((?!_next/static|_next/image).*)'],
};
