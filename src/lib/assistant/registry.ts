// The actuator registry — how Scout (the assistant dock, mounted once in the app shell) reaches
// whichever page is on screen. A page registers what it can do while mounted; the dock's tool
// runner looks the handlers up at call time and reports "not available on this page" honestly
// when a handler is missing. A module-level singleton is enough: the dock and every page live in
// one client bundle. No DOM at module scope, so the server can import the types.

export type AssistantPage = 'map' | 'theater' | 'console' | 'reconstruction' | 'other';

export type ViewState = {
  page: AssistantPage;
  path: string;
  camera?: { lat: number; lng: number; zoom?: number; altitudeM?: number; heading?: number; pitch?: number };
  /** layer ids currently on */
  layersOn?: string[];
  style?: string;
  selected?: { layer: string; id: string; name: string } | null;
  follow?: 'chase' | 'cockpit' | null;
  /** live object counts per layer, when the page knows them */
  counts?: Record<string, number>;
  /** recorded-history replay state (theater), when a window is loaded */
  history?: { from: string; to: string; tracks: number; fixes: number; playhead: string; playing: boolean } | null;
  /** the operator's annotations currently drawn in the theater */
  annotations?: { id: string; kind: string; label?: string; points: number; measure?: string }[];
  /** the flown-path trace currently drawn in the theater */
  trace?: { icao24: string; label: string; points: number; from: string | null; to: string | null; distanceKm: number } | null;
};

export type ActuatorResult = { ok: boolean; note?: string } & Record<string, unknown>;

export type ContactSummary = { layer: string; id: string; name: string; lat: number; lng: number; distanceKm?: number; bearingDeg?: number };

export type FlyTarget = { lat: number; lng: number; zoom?: number; altitudeM?: number; heading?: number; pitch?: number };

export type Actuators = {
  view: () => ViewState;
  flyTo?: (t: FlyTarget) => ActuatorResult;
  setLayer?: (id: string, on: boolean) => ActuatorResult;
  listLayers?: () => { id: string; on: boolean }[];
  setStyle?: (name: string) => ActuatorResult;
  follow?: (mode: 'chase' | 'cockpit' | 'off') => ActuatorResult;
  selectContact?: (query: string) => ActuatorResult & { selected?: ContactSummary };
  nearby?: (radiusKm: number, limit: number) => ContactSummary[];
  playScene?: (id: string) => ActuatorResult;
  /** load a recorded-track window into the theater's HISTORY panel */
  loadHistory?: (fromMs: number, toMs: number) => Promise<ActuatorResult>;
  /** draw annotations (pin/label/outline/measure) from coordinates; replace clears first */
  annotate?: (items: unknown[], replace: boolean) => ActuatorResult;
  clearAnnotations?: () => ActuatorResult;
  /** draw the last 24 h flown path of an aircraft (hex or callsign on screen) in the theater */
  showTrace?: (query: string) => Promise<ActuatorResult>;
  clearTrace?: () => ActuatorResult;
  /** run the operator's on-device YOLO tracker on a camera (the selected one when no query) */
  detectVehicles?: (query?: string) => Promise<ActuatorResult>;
};

let current: Actuators | null = null;
const listeners = new Set<() => void>();

/** Register a page's handlers; returns the unregister function for the effect cleanup. */
export function registerActuators(a: Actuators): () => void {
  current = a;
  listeners.forEach((l) => l());
  return () => {
    if (current === a) { current = null; listeners.forEach((l) => l()); }
  };
}

export function getActuators(): Actuators | null { return current; }

export function onActuatorsChange(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function pageFromPath(path: string): AssistantPage {
  if (path === '/' || path.startsWith('/?')) return 'map';
  if (path.startsWith('/theater')) return 'theater';
  if (path.startsWith('/console')) return 'console';
  if (path.startsWith('/reconstruction')) return 'reconstruction';
  return 'other';
}

/** The view the model sees: the page's own handler when there is one, else what the path says. */
export function currentView(path: string): ViewState {
  const a = current;
  if (a) {
    try { return a.view(); } catch { /* fall through to the path-derived view */ }
  }
  return { page: pageFromPath(path), path };
}
