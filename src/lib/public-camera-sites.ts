import type { CctvCamera } from '../app/api/cctv/types';

/** Public operator pages with cameras that we do not have permission to re-embed.
 * These are map shortcuts, NEVER playable/live-feed claims. Coordinates identify the venue
 * approximately, not a camera mount. Terminal sources are linked by the Port itself at
 * https://portoflosangeles.org/business/terminals/container/gates (checked 2026-09-13).
 */
export const PUBLIC_CAMERA_SITES: CctvCamera[] = [
  { id: 'site-port-la-waterfront', name: 'Port of Los Angeles — San Pedro & Wilmington cameras', city: 'Los Angeles', lat: 33.742, lng: -118.277, external_url: 'https://portoflosangeles.org/news/livestream' },
  { id: 'site-pacific-park', name: 'Pacific Park — Santa Monica Pier cameras', city: 'Santa Monica', lat: 34.009, lng: -118.498, external_url: 'https://pacpark.com/santa-monica-pier-live-cams/' },
  { id: 'site-trapac-la', name: 'TraPac Los Angeles — public gate cameras', city: 'Wilmington', lat: 33.770, lng: -118.266, external_url: 'https://losangeles.trapac.com/cameras/' },
  { id: 'site-wbct', name: 'West Basin Container Terminal — public gate cameras', city: 'San Pedro', lat: 33.754, lng: -118.280, external_url: 'https://wbctlivecam.portsamerica.com/' },
  { id: 'site-yusen', name: 'Yusen Terminals — public gate cameras', city: 'Terminal Island', lat: 33.750, lng: -118.253, external_url: 'https://yti.com/terminal-cameras/' },
  { id: 'site-fenix', name: 'Fenix Marine Services — public terminal cameras', city: 'Terminal Island', lat: 33.731, lng: -118.250, external_url: 'https://fenixmarineservices.com/terminal/' },
  { id: 'site-everport', name: 'Everport Los Angeles — public gate image', city: 'Terminal Island', lat: 33.748, lng: -118.263, external_url: 'https://gate.etslax.com/GateImages/LAInGate.jpg' },
  { id: 'site-poppy-reserve', name: 'Antelope Valley Poppy Reserve — public camera', city: 'Lancaster', lat: 34.724, lng: -118.397, external_url: 'https://www.parks.ca.gov/?page_id=31189' },
].map(site => ({ ...site, country: 'US', source: 'Public Camera Site', access_mode: 'operator-page' as const }));
