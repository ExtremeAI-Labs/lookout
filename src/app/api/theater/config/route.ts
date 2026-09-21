/**
 * Lookout — 3D theater configuration.
 *
 * Hands the browser what it needs to start the Cesium view. The one secret-shaped
 * thing here is the Google Map Tiles key, and it is deliberately browser-visible:
 * photorealistic 3D tiles are fetched by the browser straight from Google, exactly
 * like a Maps JavaScript key, so it cannot stay server-side. It is kept out of the
 * bundle (runtime env, loaded by run-console.sh from the Keychain-backed secrets
 * file) so rotating it never needs a rebuild. What protects it is on Google's side:
 * restrict the key to the Map Tiles API, restrict its HTTP referrers to this
 * console's origins, and set a hard daily quota. Do that before setting it.
 *
 * No key is a supported state, not an error: the theater falls back to keyless
 * Esri imagery on a smooth globe and says so.
 */
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export type TheaterConfig = {
  /** null = no Google key */
  googleTilesKey: string | null;
  /** a Cesium ion token (free tier) also reaches Google's photoreal tiles, through ion; null = none */
  ionToken: string | null;
};

export async function GET() {
  const key = (process.env.GOOGLE_MAP_TILES_KEY || '').trim();
  const ion = (process.env.CESIUM_ION_TOKEN || '').trim();
  const body: TheaterConfig = { googleTilesKey: key || null, ionToken: ion || null };
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
}
