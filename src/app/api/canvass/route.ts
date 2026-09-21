/**
 * Lookout — camera canvass.
 *   GET /api/canvass?lat=&lng=&radius=   → mapped cameras within radius (m, default 250, max 1500), nearest first
 *   GET /api/canvass?all=1               → every California camera, trimmed for the map layer
 *   GET /api/canvass                     → snapshot status
 */
import { NextResponse } from 'next/server';
import { californiaCameras, camerasNear, compass, SnapshotWarming } from '@/lib/osm-cameras';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;   // a cold snapshot is minutes of Overpass

const ATTRIBUTION = '© OpenStreetMap contributors (ODbL) — camera positions as mapped by volunteers; verify on site';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  let snap;
  try { snap = await californiaCameras(); }
  catch (e) {
    const warming = e instanceof SnapshotWarming;
    return NextResponse.json({ error: warming ? 'warming' : 'Camera snapshot unavailable', detail: e instanceof Error ? e.message : String(e) },
      { status: 503, headers: warming ? { 'Retry-After': '120' } : {} });
  }

  if (searchParams.get('all') === '1') {
    return NextResponse.json({
      fetched: snap.fetched, count: snap.cameras.length, attribution: ATTRIBUTION,
      cameras: snap.cameras.map((c) => ({ id: c.id, lat: c.lat, lng: c.lng, type: c.type, zone: c.zone, scope: c.scope, direction: c.direction, operator: c.operator })),
    }, { headers: { 'Cache-Control': 'private, max-age=3600' } });
  }

  const latS = searchParams.get('lat'), lngS = searchParams.get('lng');
  if (latS === null && lngS === null) {
    return NextResponse.json({ fetched: snap.fetched, count: snap.cameras.length, boxesFailed: snap.boxesFailed, attribution: ATTRIBUTION });
  }
  const lat = Number(latS), lng = Number(lngS);
  const radius = Math.min(1500, Math.max(25, Number(searchParams.get('radius') || 250)));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return NextResponse.json({ error: 'lat/lng must be valid coordinates' }, { status: 400 });
  }
  const near = camerasNear(snap.cameras, lat, lng, radius).slice(0, 200)
    .map((c) => ({ ...c, distanceM: Math.round(c.distanceM), bearing: compass(c.bearingDeg), bearingDeg: Math.round(c.bearingDeg) }));
  return NextResponse.json({ lat, lng, radius, count: near.length, cameras: near, fetched: snap.fetched, attribution: ATTRIBUTION });
}
