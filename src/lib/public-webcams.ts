/**
 * Lookout — curated PUBLIC live webcams (operator-intends-public: beaches, piers, harbors, streets,
 * rail lines, airports, ski areas). This is the lawful "non-governmental public cameras" lane:
 * owner-published live streams embedded via YouTube's own player, NOT unsecured private security
 * cameras (those stay out — no lawful purpose) and not restreamers of other people's feeds.
 *
 * Every entry is verified at fetch time: YouTube oEmbed must answer 200 (exists + embeddable) AND
 * the player metadata must say the broadcast is live right now. A stream that ends or disables
 * embedding simply drops off the map instead of showing a dead pin; a transient network failure
 * on the live check keeps the pin (availability over strictness — the player shows the truth).
 *
 * Curated 2026-09-13 from a California-wide sweep: each id was checked live + embeddable, its
 * channel confirmed as the camera's operator, and its live thumbnail eyeballed. Coordinates are
 * landmark-level (the pin marks the view, not the mount). Grow the list with any owner-published
 * live cam: add {name, city, country, lat, lng, youtube}.
 */
import { createPool } from './fetch-pool';

export interface PublicWebcam { name: string; city: string; country: string; lat: number; lng: number; youtube: string; operator_url?: string }

export const PUBLIC_WEBCAMS: PublicWebcam[] = [
  // ── Los Angeles County ──
  // Published by the Aquarium's broadcast partner; location from Explore's operator metadata.
  { name: 'Aquarium of the Pacific — Tropical Reef', city: 'Long Beach', country: 'US', lat: 33.76216, lng: -118.19692, youtube: 'DHUnz4dyb54', operator_url: 'https://explore.org/livecams/aquarium-of-the-pacific/pacific-aquarium-tropical-reef-camera' },
  { name: 'Aquarium of the Pacific — Coral Predators', city: 'Long Beach', country: 'US', lat: 33.76216, lng: -118.19692, youtube: 'h0F818upkgI', operator_url: 'https://explore.org/livecams/aquarium-of-the-pacific/pacific-aquarium-tropical-reef-habitat-cam' },
  { name: 'Aquarium of the Pacific — Shark Lagoon', city: 'Long Beach', country: 'US', lat: 33.76216, lng: -118.19692, youtube: 'YT7lH6U68S4', operator_url: 'https://explore.org/livecams/aquarium-of-the-pacific/shark-lagoon-cam' },
  { name: 'Aquarium of the Pacific — Blue Cavern', city: 'Long Beach', country: 'US', lat: 33.76216, lng: -118.19692, youtube: 'H59B9Uoewwg', operator_url: 'https://explore.org/livecams/aquarium-of-the-pacific/aquarium-pacific-live-cam-2' },
  { name: 'Aquarium of the Pacific — Penguin Beach', city: 'Long Beach', country: 'US', lat: 33.76216, lng: -118.19692, youtube: 'GSxpCbXsvtI', operator_url: 'https://explore.org/livecams/penguins/live-penguin-cam-2' },
  { name: 'Aquarium of the Pacific — Penguins Underwater', city: 'Long Beach', country: 'US', lat: 33.76216, lng: -118.19692, youtube: 'KlVMg-8SIlw', operator_url: 'https://explore.org/livecams/penguins/live-penguin-cam' },
  { name: 'Venice Beach — Venice V Hotel (Teleport.camera)', city: 'Los Angeles', country: 'US', lat: 33.9850, lng: -118.4695, youtube: 'EO_1LWqsCNE' },
  { name: 'Venice Beach — North Boardwalk', city: 'Los Angeles', country: 'US', lat: 33.9905, lng: -118.4780, youtube: '98jOtUeM3m8' },
  { name: 'Venice Beach — South Boardwalk', city: 'Los Angeles', country: 'US', lat: 33.9855, lng: -118.4725, youtube: 'D33ZD6sRvnA' },
  { name: 'Venice Beach — Boardwalk (Venice Vive)', city: 'Los Angeles', country: 'US', lat: 33.9875, lng: -118.4750, youtube: 'Hk9Mzv7H_RY' },
  { name: 'Venice Beach — Surf cam (Venice Vive)', city: 'Los Angeles', country: 'US', lat: 33.9865, lng: -118.4770, youtube: 'Qsa3YF28D4o' },
  { name: 'Santa Monica Beach & Pier (explore.org)', city: 'Santa Monica', country: 'US', lat: 34.0086, lng: -118.4980, youtube: 'v97JpT3ZA0w' },
  { name: 'Malibu Beach — PCH (LA Times)', city: 'Malibu', country: 'US', lat: 34.0367, lng: -118.6780, youtube: 'E0TZTmTK-Ws' },
  { name: 'Hollywood Blvd — TCL Chinese Theatre (LA Times)', city: 'Los Angeles', country: 'US', lat: 34.1020, lng: -118.3410, youtube: 'YHWJd_DNgKY' },
  { name: 'Manhattan Beach Pier (The Surfers View)', city: 'Manhattan Beach', country: 'US', lat: 33.8840, lng: -118.4109, youtube: 'tBEIYdw1HeM' },
  { name: 'Redondo Beach Pier (City of Redondo Beach)', city: 'Redondo Beach', country: 'US', lat: 33.8390, lng: -118.3905, youtube: 'TuVOKRP7IBA' },
  { name: 'Redondo Beach Harbor (City of Redondo Beach)', city: 'Redondo Beach', country: 'US', lat: 33.8450, lng: -118.3960, youtube: 'Ni7v-aIa3bw' },
  { name: 'LAX — Runways 24L/24R (AirlineVideosLive)', city: 'Los Angeles', country: 'US', lat: 33.9500, lng: -118.4010, youtube: 'n4I0d44oBEs' },
  { name: 'LAX — Runways 25L/25R (AirlineVideosLive)', city: 'Los Angeles', country: 'US', lat: 33.9340, lng: -118.4010, youtube: 'KzsNnyN8D_Q' },
  // ── Orange County ──
  { name: 'Seal Beach — Harbor & Marina (CODE 20)', city: 'Seal Beach', country: 'US', lat: 33.7420, lng: -118.1120, youtube: 'i_DmmMyIvwg' },
  { name: 'Huntington Beach Pier (City of Huntington Beach)', city: 'Huntington Beach', country: 'US', lat: 33.6553, lng: -118.0036, youtube: 'mhQjsLBfOoY' },
  { name: 'The Wedge — Newport Beach (Josh Pomer)', city: 'Newport Beach', country: 'US', lat: 33.5930, lng: -117.8810, youtube: 'YTHMolT2PTM' },
  { name: 'Orange Plaza — Old Towne (City of Orange)', city: 'Orange', country: 'US', lat: 33.7877, lng: -117.8531, youtube: 'AShvF9ILGkc' },
  { name: 'Fullerton Station — BNSF mainline (Railstream)', city: 'Fullerton', country: 'US', lat: 33.8710, lng: -117.9230, youtube: 'bzqVcwY04GA' },
  { name: 'San Juan Capistrano Depot (Virtual Railfan)', city: 'San Juan Capistrano', country: 'US', lat: 33.5010, lng: -117.6630, youtube: '-g1qAvXyIyQ' },
  // ── San Diego County & islands ──
  { name: 'Oceanside Pier — Rooftop Bar wide (San Diego Web Cam)', city: 'Oceanside', country: 'US', lat: 33.1935, lng: -117.3840, youtube: 'OYqo4dqYjh0' },
  { name: 'Oceanside Pier — Rooftop Bar PTZ (San Diego Web Cam)', city: 'Oceanside', country: 'US', lat: 33.1940, lng: -117.3835, youtube: 'cvP_F-c2Upw' },
  { name: 'Oceanside Harbor (Americas Boating Club)', city: 'Oceanside', country: 'US', lat: 33.2060, lng: -117.3930, youtube: 'isQSAV9rJvQ' },
  { name: 'San Diego Web Cam — rotating multi-cam feed', city: 'San Diego', country: 'US', lat: 32.7157, lng: -117.1611, youtube: 'edz0ux7JClE' },
  { name: 'Shelter Island North (San Diego Web Cam)', city: 'San Diego', country: 'US', lat: 32.7140, lng: -117.2290, youtube: 'ct7IRmzDggk' },
  { name: 'Harbor Island (San Diego Web Cam)', city: 'San Diego', country: 'US', lat: 32.7260, lng: -117.2000, youtube: 'iaBfYxbmwXA' },
  { name: 'Harbor Island South (San Diego Web Cam)', city: 'San Diego', country: 'US', lat: 32.7240, lng: -117.2050, youtube: 'fc58f5x18-w' },
  { name: 'San Diego Bay East (San Diego Web Cam)', city: 'San Diego', country: 'US', lat: 32.7000, lng: -117.1550, youtube: 'OAk3giBu5_k' },
  { name: 'Lower Otay Lake (San Diego Web Cam)', city: 'Chula Vista', country: 'US', lat: 32.6200, lng: -116.9330, youtube: 'zScdt7Z839s' },
  { name: 'San Diego Trolley & Coaster line (SubAquaImaging)', city: 'San Diego', country: 'US', lat: 32.7200, lng: -117.1650, youtube: 'sOOPey_HCWo' },
  { name: 'Santa Fe Depot (San Diego Railcam)', city: 'San Diego', country: 'US', lat: 32.7165, lng: -117.1700, youtube: 'LUYo8zX2cLU' },
  { name: 'Anacapa Island Cove Lookout (explore.org)', city: 'Channel Islands', country: 'US', lat: 34.0165, lng: -119.3660, youtube: 'fAS2TFePbQk' },
  { name: 'Catalina Island West End Overlook (explore.org)', city: 'Catalina Island', country: 'US', lat: 33.4780, lng: -118.5960, youtube: 'TCGyi19a6J4' },
  // ── Central Coast ──
  { name: 'Campus Point Surf Cam — UCSB (GRIT)', city: 'Santa Barbara', country: 'US', lat: 34.4060, lng: -119.8430, youtube: '-Q20DkjKgpM' },
  { name: 'San Luis Obispo — weather view (Mustang Media)', city: 'San Luis Obispo', country: 'US', lat: 35.3000, lng: -120.6600, youtube: 'o6gd6aYGCik' },
  { name: 'San Luis Obispo Amtrak — UP Santa Barbara Sub (SouthWest RailCams)', city: 'San Luis Obispo', country: 'US', lat: 35.2760, lng: -120.6545, youtube: 'S2YHshIN0F8' },
  { name: 'Morro Bay Rock & Harbor (805 Webcams)', city: 'Morro Bay', country: 'US', lat: 35.3700, lng: -120.8570, youtube: 'gCB67grPzvA' },
  { name: 'Morro Bay Yacht Club (SeeCam)', city: 'Morro Bay', country: 'US', lat: 35.3640, lng: -120.8530, youtube: 'jpTWh9bKULw' },
  { name: 'Monterey Bay Cam (Monterey Bay Aquarium)', city: 'Monterey', country: 'US', lat: 36.6183, lng: -121.9016, youtube: 'fVa6-zCBR7A' },
  { name: 'Morgan Hill — Santa Clara Valley (PTZtv)', city: 'Morgan Hill', country: 'US', lat: 37.1305, lng: -121.6544, youtube: 'mU0nL6JvwbM' },
  // ── Bay Area ──
  { name: 'KGO Rooftop — Bay Bridge view (ABC7)', city: 'San Francisco', country: 'US', lat: 37.7950, lng: -122.3950, youtube: 'G8RIAgPxaMc' },
  { name: 'Treasure Island — Alcatraz view (ABC7)', city: 'San Francisco', country: 'US', lat: 37.8235, lng: -122.3705, youtube: '_VqvVJfmyfs' },
  { name: 'Bay Bridge Cam (ABC7)', city: 'San Francisco', country: 'US', lat: 37.7980, lng: -122.3775, youtube: 'CXYr04BWvmc' },
  { name: 'Emeryville Cam (ABC7)', city: 'Emeryville', country: 'US', lat: 37.8400, lng: -122.3000, youtube: 'CHh_xNESvUg' },
  { name: 'Vollmer Peak — Berkeley Hills (ABC7)', city: 'Berkeley', country: 'US', lat: 37.8850, lng: -122.2190, youtube: 'FLoSUN_Vrz4' },
  { name: 'Mersea Restaurant — Treasure Island skyline view (Teleport.camera)', city: 'San Francisco', country: 'US', lat: 37.8180, lng: -122.3700, youtube: 'BSWhGNXxT9A' },
  { name: 'Pier 23 Cafe — Embarcadero (StreamTime Live)', city: 'San Francisco', country: 'US', lat: 37.8020, lng: -122.3990, youtube: 'a5IW4I-z2rs' },
  { name: 'Castro Street Cam 1', city: 'San Francisco', country: 'US', lat: 37.7609, lng: -122.4350, youtube: 'pKKaof5b_gE' },
  { name: 'Ayala Cove — Angel Island', city: 'Tiburon', country: 'US', lat: 37.8680, lng: -122.4350, youtube: 'OIyy1ZmRryM' },
  { name: 'Farallon Islands (California Academy of Sciences)', city: 'Farallon Islands', country: 'US', lat: 37.6990, lng: -123.0030, youtube: 'fHb0eB9RUgA' },
  // NPS identifies this as Santa Cruz Island's peak, not the mountain near Danville.
  { name: 'Mount Diablo — Santa Cruz Island (explore.org)', city: 'Channel Islands', country: 'US', lat: 34.0292, lng: -119.7844, youtube: 'f5Rjm5tiEkU', operator_url: 'https://www.nps.gov/chis/learn/photosmultimedia/mount-diablo-webcam.htm' },
  { name: 'Pacifica Pier — closeup (Chamberlin Nature)', city: 'Pacifica', country: 'US', lat: 37.6335, lng: -122.4945, youtube: 'BrUaOjjXgZM' },
  { name: 'Pacifica Pier & Beach (Chamberlin Nature)', city: 'Pacifica', country: 'US', lat: 37.6330, lng: -122.4935, youtube: 'QYRIc4LcvqQ' },
  { name: 'Sharp Park Beach (Chamberlin Nature)', city: 'Pacifica', country: 'US', lat: 37.6290, lng: -122.4950, youtube: 'lmec_rcEIL4' },
  { name: 'Mori Point (Chamberlin Nature)', city: 'Pacifica', country: 'US', lat: 37.6190, lng: -122.4990, youtube: 'q0Z7tv_7n-0' },
  { name: 'Green Valley Road flood cam (Sonoma County Public Infrastructure)', city: 'Graton', country: 'US', lat: 38.4360, lng: -122.8690, youtube: 'mcQJUHnWAVA' },
  // ── Central Valley, Sierra & North ──
  { name: 'Stockton Diamond — BNSF/UP (SouthWest RailCams)', city: 'Stockton', country: 'US', lat: 37.9500, lng: -121.2800, youtube: 'Fbc8zmqrhn8' },
  { name: 'Marysville — UP Valley Sub (SouthWest RailCams)', city: 'Marysville', country: 'US', lat: 39.1457, lng: -121.5914, youtube: 'JUf1rHtQAEc' },
  { name: 'Redding — UP Valley Sub (SouthWest RailCams)', city: 'Redding', country: 'US', lat: 40.5865, lng: -122.3917, youtube: 'fKakDFoyBeM' },
  { name: 'Colfax — UP Roseville Sub (SouthWest RailCams)', city: 'Colfax', country: 'US', lat: 39.1000, lng: -120.9530, youtube: '8zRCgdkn_e8' },
  { name: 'Auburn Airport KAUN (Andy SixPilot)', city: 'Auburn', country: 'US', lat: 38.9548, lng: -121.0820, youtube: 't0J6D3XAVh8' },
  { name: 'Truckee Railroad Museum (RRphotographer)', city: 'Truckee', country: 'US', lat: 39.3270, lng: -120.1840, youtube: 'EXz2iX_jDeA' },
  { name: 'Palisades Tahoe — Alpine Lodge base', city: 'Olympic Valley', country: 'US', lat: 39.1650, lng: -120.2380, youtube: 'xJjrP9DmA1k' },
  { name: 'Palisades Tahoe — Palisades base (Funitel)', city: 'Olympic Valley', country: 'US', lat: 39.1970, lng: -120.2350, youtube: 'f6utX07SR7s' },
  { name: 'South Lake Tahoe Airport — South (SeeTahoe)', city: 'South Lake Tahoe', country: 'US', lat: 38.8938, lng: -119.9953, youtube: 'Gq1kM9PqNg4' },
  { name: 'South Lake Tahoe Airport — North (SeeTahoe)', city: 'South Lake Tahoe', country: 'US', lat: 38.8960, lng: -119.9960, youtube: '_li9Rpd3Y40' },
  { name: 'Johnson Meadow — Tahoe Paradise (SeeTahoe)', city: 'Meyers', country: 'US', lat: 38.8600, lng: -120.0100, youtube: '0m_laVpVw0k' },
  { name: 'Sierra-at-Tahoe — Grandview', city: 'Twin Bridges', country: 'US', lat: 38.8000, lng: -120.0800, youtube: 'adxDs4z-y34' },
  { name: 'Mammoth Mountain — Main Lodge', city: 'Mammoth Lakes', country: 'US', lat: 37.6390, lng: -119.0370, youtube: 'AXyxIFY3JaA' },
  { name: 'Mammoth Mountain — Summit', city: 'Mammoth Lakes', country: 'US', lat: 37.6300, lng: -119.0330, youtube: 'awxz_oIlJE0' },
  { name: 'Mammoth Mountain — The Village', city: 'Mammoth Lakes', country: 'US', lat: 37.6510, lng: -118.9830, youtube: 'MwHWDokyUhw' },
  // ── Inland Empire, mountains & desert ──
  { name: 'Snow Summit — beginner area (Big Bear Mountain Resort)', city: 'Big Bear Lake', country: 'US', lat: 34.2300, lng: -116.8900, youtube: 'Kn4IAs67hNo' },
  { name: 'Snow Summit — slopeside (Big Bear Mountain Resort)', city: 'Big Bear Lake', country: 'US', lat: 34.2290, lng: -116.8880, youtube: 'SOo3NBmvJQI' },
  { name: 'Goldmine Mountain — Big Bear (Socalmountains)', city: 'Big Bear Lake', country: 'US', lat: 34.2280, lng: -116.8590, youtube: 'GgQXgMJeHiA' },
  { name: 'Big Bear Lake — Village (Big Bear Live Stream)', city: 'Big Bear Lake', country: 'US', lat: 34.2439, lng: -116.9114, youtube: 'zfIRoGngFSc' },
  { name: 'Mountain High — West Base', city: 'Wrightwood', country: 'US', lat: 34.3770, lng: -117.6900, youtube: 'YcQT1a6K1Mo' },
  { name: 'San Bernardino Mountains view (Bensweather, approx.)', city: 'Redlands', country: 'US', lat: 34.0700, lng: -117.1800, youtube: 'VXMe-WsgZFs' },
  { name: 'Tehachapi rail — Edison / Giumarra Vineyards', city: 'Edison', country: 'US', lat: 35.3470, lng: -118.8710, youtube: 'K0dU05muXdE' },
  { name: 'Tehachapi Loop', city: 'Keene', country: 'US', lat: 35.2030, lng: -118.5360, youtube: 'vJftSXhdcbc' },
  { name: 'Tehachapi Depot Railroad Museum', city: 'Tehachapi', country: 'US', lat: 35.1320, lng: -118.4490, youtube: 'yVfFVNmE0LE' },
  { name: 'Tehachapi rail — West Cable', city: 'Tehachapi', country: 'US', lat: 35.1500, lng: -118.5000, youtube: 'Bzd0z0YqTEw' },
  { name: 'Mojave — Gardner Realty (Tehachapi Live Train Cams)', city: 'Mojave', country: 'US', lat: 35.0530, lng: -118.1740, youtube: 'PH-jf0kdsf8' },
  { name: 'Barstow — BNSF Needles Sub MP 744 (SouthWest RailCams)', city: 'Barstow', country: 'US', lat: 34.8958, lng: -117.0173, youtube: 'Hsh-46qLpQE' },
  { name: 'Barstow — BNSF yard (Virtual Railfan)', city: 'Barstow', country: 'US', lat: 34.8900, lng: -117.0300, youtube: '_DUQnPjPC_8' },
  { name: 'Daggett — BNSF Needles Sub (SouthWest RailCams)', city: 'Daggett', country: 'US', lat: 34.8630, lng: -116.8880, youtube: 'ECfBCFozPlM' },
  { name: 'Needles — BNSF Needles Sub PTZ (SouthWest RailCams)', city: 'Needles', country: 'US', lat: 34.8480, lng: -114.6140, youtube: 'sg3kp4pn9fU' },
  { name: 'Needles — BNSF Needles Sub East (SouthWest RailCams)', city: 'Needles', country: 'US', lat: 34.8485, lng: -114.6130, youtube: 'Veng2vw-Hfo' },
  { name: 'Indio — UP Yuma Sub (SouthWest RailCams)', city: 'Indio', country: 'US', lat: 33.7206, lng: -116.2156, youtube: 'Ed34e7YLqoM' },
];

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/**
 * Reads "is this broadcast live right now" out of a YouTube player response.
 *   true  — videoDetails.isLive is set (only present while a broadcast is on air)
 *   false — a well-formed player response without it (ended stream, VOD, removed)
 *   null  — not a player response at all (caller treats as unknown, not as dead)
 */
export function parsePlayerLive(json: unknown): boolean | null {
  if (!json || typeof json !== 'object') return null;
  const o = json as { videoDetails?: { isLive?: unknown }; playabilityStatus?: { status?: unknown } };
  if (!o.videoDetails && !o.playabilityStatus) return null;
  return o.videoDetails?.isLive === true;
}

/** Pulls YouTube's public web-client key out of a page — it ships in every page's config JSON. */
export function extractInnertubeKey(html: string): string | null {
  const m = html.match(/"INNERTUBE_API_KEY":"([A-Za-z0-9_-]{20,})"/);
  return m ? m[1] : null;
}

// The player endpoint wants the key the web client ships with; it is public config (not a secret)
// and changes rarely, so learn it once per process and re-learn on a 4xx.
let innertubeKey: string | null = null;
async function getInnertubeKey(): Promise<string | null> {
  if (innertubeKey) return innertubeKey;
  try {
    const r = await fetch(`https://www.youtube.com/embed/${PUBLIC_WEBCAMS[0].youtube}`,
      { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    innertubeKey = extractInnertubeKey(await r.text());
  } catch { innertubeKey = null; }
  return innertubeKey;
}

async function isEmbeddable(videoId: string): Promise<boolean> {
  try {
    const r = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
      { signal: AbortSignal.timeout(8000) });
    return r.ok;   // oEmbed 200 ⇒ the video exists and is embeddable
  } catch { return false; }
}

/** ~13 KB per check via the player endpoint, versus ~1.2 MB to scrape the watch page. */
async function isLiveNow(videoId: string): Promise<boolean | null> {
  const key = await getInnertubeKey();
  if (!key) return null;
  try {
    const r = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId, context: { client: { clientName: 'WEB', clientVersion: '2.20240101.00.00' } } }),
      signal: AbortSignal.timeout(8000),
    });
    if (r.status >= 400 && r.status < 500) innertubeKey = null;   // key rotated — re-learn next time
    if (!r.ok) return null;
    return parsePlayerLive(await r.json());
  } catch { return null; }
}

const pool = createPool(8);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function livePublicWebcams(): Promise<any[]> {
  const checked = await Promise.all(PUBLIC_WEBCAMS.map((w) => pool.run(async () => {
    if (!(await isEmbeddable(w.youtube))) return { w, ok: false };
    const live = await isLiveNow(w.youtube);
    return { w, ok: live !== false };      // unknown (null) keeps the pin; a definite "not live" drops it
  })));
  return checked.filter((c) => c.ok).map(({ w }) => ({
    id: `pubcam-${w.youtube}`,
    lat: w.lat, lng: w.lng,
    name: w.name, city: w.city, country: w.country,
    stream_url: `https://www.youtube.com/embed/${w.youtube}?autoplay=1&mute=1&playsinline=1`,
    stream_type: 'iframe',
    external_url: w.operator_url || `https://www.youtube.com/watch?v=${w.youtube}`,
    source: 'Public Webcam',
  }));
}
