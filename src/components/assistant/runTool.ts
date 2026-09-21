// Scout's tool runner — every tool executes here, in the browser, against the page on screen
// (registry actuators), Lookout's own APIs (same session the operator has), or the DOM (kit
// actuators). Two rules are enforced at this seam, not in the prompt:
//   · sensitive tools hand the model only {ok, shown_on_screen, count?} — the data goes to a
//     local card the dock renders and never sends anywhere;
//   · confirm-gated tools wait for the operator's tap before doing anything outward.
import { currentView, getActuators, onActuatorsChange, pageFromPath, type ViewState } from '@/lib/assistant/registry';
import { LOOKUP_KINDS, SENSOR_STYLE_NAMES, TOOL_BY_NAME, isAllowedRoute, sensitiveResultForModel } from '@/lib/assistant/tools';
import { clickByText, highlight } from '@/lib/assistant/kit/actuators';

export type ToolCard = { title: string; lines: string[] };
export type ToolOutcome = { ok: boolean; note?: string; forModel: string; card?: ToolCard };
export type ToolDeps = {
  navigate: (path: string) => void;
  confirm: (summary: string) => Promise<boolean>;
  path: () => string;
};

type Result = { ok: boolean; note?: string } & Record<string, unknown>;
const fail = (note: string, extra: Record<string, unknown> = {}): Result => ({ ok: false, note, ...extra });
const THREE_D_ONLY = '3D only — navigate to /theater (or open_in_3d), then retry';

async function fetchJson<T = unknown>(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; json: T | null; error?: string }> {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json', ...(init?.headers ?? {}) } });
    const json = (await r.json().catch(() => null)) as T | null;
    const err = json && typeof json === 'object' && 'error' in (json as object) ? String((json as unknown as { error: unknown }).error) : undefined;
    return { ok: r.ok, status: r.status, json, error: r.ok ? undefined : err ?? `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, status: 0, json: null, error: e instanceof Error ? e.message : 'network error' };
  }
}

/** After navigate(), the destination page registers its actuators asynchronously; wait for them briefly. */
function waitForPage(page: ViewState['page'], ms = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    const check = () => { const a = getActuators(); if (a && a.view().page === page) { cleanup(); resolve(true); } };
    const off = onActuatorsChange(check);
    const timer = setTimeout(() => { cleanup(); resolve(false); }, ms);
    const cleanup = () => { off(); clearTimeout(timer); };
    check();
  });
}

const finite = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const latLng = (a: Record<string, unknown>): { lat: number; lng: number } | null => {
  const lat = finite(a.lat), lng = finite(a.lng);
  return lat !== undefined && lng !== undefined && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
};
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

type CaseRow = { id: string; name: string };
async function findCase(fragment: string): Promise<{ hit?: CaseRow; result?: Result; card?: ToolCard; rows: CaseRow[] }> {
  const r = await fetchJson<{ cases?: CaseRow[] }>('/api/cases');
  const rows = r.json?.cases ?? [];
  if (!r.ok) return { result: fail(`could not read cases: ${r.error}`), rows };
  const q = fragment.toLowerCase();
  const exact = rows.filter((c) => c.name.toLowerCase() === q);
  const partial = exact.length ? exact : rows.filter((c) => c.name.toLowerCase().includes(q));
  if (partial.length === 1) return { hit: partial[0], rows };
  if (partial.length === 0) return { result: fail('no case matches that name', { count: 0 }), rows };
  return { result: fail('several cases match; the list is on screen — be more specific', { count: partial.length }), card: { title: 'Cases matching', lines: partial.map((c) => c.name) }, rows };
}

export async function executeTool(name: string, rawArgs: string, deps: ToolDeps): Promise<ToolOutcome> {
  const def = TOOL_BY_NAME.get(name);
  const finish = (r: Result, card?: ToolCard): ToolOutcome => ({
    ok: r.ok, note: r.note, card,
    forModel: def?.tier === 'sensitive' ? sensitiveResultForModel(JSON.stringify(r)) : JSON.stringify(r),
  });
  if (!def) return finish(fail(`unknown tool ${name}`));
  let a: Record<string, unknown> = {};
  try { const p = JSON.parse(rawArgs || '{}'); if (p && typeof p === 'object') a = p as Record<string, unknown>; } catch { return finish(fail('arguments were not valid JSON')); }
  const act = getActuators();
  const view = currentView(deps.path());

  try {
    switch (name) {
      case 'get_view_state':
        return finish({ ok: true, ...view });

      case 'navigate': {
        const path = text(a.path, 400);
        if (!isAllowedRoute(path)) return finish(fail('not an in-app route; allowed: /, /theater, /console, /reconstruction/<caseId>, /fisherman'));
        deps.navigate(path);
        const page = pageFromPath(path);
        const ready = page === 'map' || page === 'theater' ? await waitForPage(page) : true;
        return finish({ ok: true, path, note: ready ? 'page ready' : 'navigated; the page is still loading — call get_view_state again in a moment' });
      }

      case 'search_place': {
        const q = text(a.query, 200);
        if (!q) return finish(fail('query is required'));
        const r = await fetchJson<{ results?: { name: string; context?: string; lat: number; lng: number; kind?: string }[] }>(`/api/geosearch?q=${encodeURIComponent(q)}`);
        if (!r.ok) return finish(fail(`place search failed: ${r.error}`));
        const results = (r.json?.results ?? []).slice(0, 5).map((p) => ({ name: p.name, context: p.context ?? '', lat: p.lat, lng: p.lng, kind: p.kind }));
        return finish({ ok: true, count: results.length, results });
      }

      case 'fly_to': {
        const ll = latLng(a);
        if (!ll) return finish(fail('lat/lng out of range'));
        if (!act?.flyTo) return finish(fail('no camera on this page — navigate to / or /theater first'));
        return finish(act.flyTo({ ...ll, zoom: finite(a.zoom), altitudeM: finite(a.altitude_m), heading: finite(a.heading), pitch: finite(a.pitch) }));
      }

      case 'list_layers':
        if (!act?.listLayers) return finish(fail('no layer control on this page'));
        return finish({ ok: true, page: view.page, layers: act.listLayers() });

      case 'set_layer': {
        const id = text(a.layer, 60);
        if (!id || typeof a.on !== 'boolean') return finish(fail('layer (id) and on (boolean) are required'));
        if (!act?.setLayer) return finish(fail('no layer control on this page'));
        return finish(act.setLayer(id, a.on));
      }

      case 'set_sensor_style': {
        const s = text(a.style, 20);
        if (!(SENSOR_STYLE_NAMES as readonly string[]).includes(s)) return finish(fail(`style must be one of ${SENSOR_STYLE_NAMES.join(', ')}`));
        if (!act?.setStyle) return finish(fail(THREE_D_ONLY));
        return finish(act.setStyle(s));
      }

      case 'nearby_contacts': {
        if (!act?.nearby) return finish(fail(THREE_D_ONLY));
        const radius = Math.min(2000, Math.max(1, finite(a.radius_km) ?? 50));
        const limit = Math.min(40, Math.max(1, Math.round(finite(a.limit) ?? 15)));
        const rows = act.nearby(radius, limit);
        const scope = view.selected ? `within ${radius} km of ${view.selected.name}` : `within ${radius} km of the view centre`;
        return finish({ ok: true, scope, count: rows.length, contacts: rows.map((c) => ({ layer: c.layer, name: c.name, distance_km: c.distanceKm !== undefined ? Math.round(c.distanceKm * 10) / 10 : undefined, bearing_deg: c.bearingDeg !== undefined ? Math.round(c.bearingDeg) : undefined })) });
      }

      case 'select_contact': {
        const q = text(a.query, 80);
        if (!q) return finish(fail('query is required'));
        if (!act?.selectContact) return finish(fail(THREE_D_ONLY));
        return finish(act.selectContact(q));
      }

      case 'follow_aircraft': {
        const mode = text(a.mode, 10);
        if (mode !== 'chase' && mode !== 'cockpit' && mode !== 'off') return finish(fail('mode must be chase, cockpit or off'));
        if (!act?.follow) return finish(fail(THREE_D_ONLY));
        return finish(act.follow(mode));
      }

      case 'canvass_here': {
        const point = latLng(a) ?? (view.camera ? { lat: view.camera.lat, lng: view.camera.lng } : null);
        if (!point) return finish(fail('no point: give lat/lng or move the map first'));
        let target = act;
        if (!target?.setLayer || !target.flyTo) {
          deps.navigate(`/?lat=${point.lat.toFixed(5)}&lon=${point.lng.toFixed(5)}&zoom=15`);
          if (!(await waitForPage('map'))) return finish(fail('the map did not come up in time — retry in a moment'));
          target = getActuators();
        }
        if (!target?.setLayer || !target.flyTo) return finish(fail('no canvass control on this page'));
        const on = target.setLayer('canvass', true);
        if (!on.ok) return finish(on);
        const moved = target.flyTo(view.page === 'theater' ? { ...point, altitudeM: 1500, pitch: -45 } : { ...point, zoom: 15 });
        return finish({ ...moved, note: 'canvass layer on; mapped cameras load around the view as it settles' });
      }

      case 'open_in_3d': {
        const point = latLng(a) ?? (view.camera ? { lat: view.camera.lat, lng: view.camera.lng } : null);
        if (!point) return finish(fail('no point: give lat/lng or move the map first'));
        const alt = Math.min(5e6, Math.max(100, finite(a.altitude_m) ?? 900));
        deps.navigate(`/theater?lat=${point.lat.toFixed(5)}&lng=${point.lng.toFixed(5)}&alt=${Math.round(alt)}&pitch=-35`);
        const ready = await waitForPage('theater', 8000);
        return finish({ ok: true, note: ready ? 'theater ready' : 'theater is still loading the engine' });
      }

      case 'list_scenes': {
        const r = await fetchJson<{ scenes?: { id: string; title: string; shots: number }[] }>('/api/scenes');
        if (!r.ok) return finish(fail(`could not list scenes: ${r.error}`));
        const scenes = (r.json?.scenes ?? []).map((s) => ({ id: s.id, title: s.title, shots: s.shots }));
        return finish({ ok: true, count: scenes.length, scenes });
      }

      case 'play_scene': {
        const q = text(a.scene, 120);
        if (!q) return finish(fail('scene is required'));
        const r = await fetchJson<{ scenes?: { id: string; title: string }[] }>('/api/scenes');
        if (!r.ok) return finish(fail(`could not list scenes: ${r.error}`));
        const rows = r.json?.scenes ?? [];
        const hit = rows.find((s) => s.id === q) ?? rows.find((s) => s.title.toLowerCase() === q.toLowerCase()) ?? rows.find((s) => s.title.toLowerCase().includes(q.toLowerCase()));
        if (!hit) return finish(fail('no scene matches', { count: rows.length, scenes: rows.map((s) => s.title) }));
        if (act?.playScene) return finish({ ...act.playScene(hit.id), scene: hit.title });
        deps.navigate(`/theater?scene=${encodeURIComponent(hit.id)}&play=1`);
        return finish({ ok: true, scene: hit.title, note: 'opening the theater and playing' });
      }

      case 'click_by_text': {
        const t = text(a.text, 120);
        if (!t) return finish(fail('text is required'));
        return finish(clickByText(t, Math.max(1, Math.round(finite(a.nth) ?? 1))) as Result);
      }

      case 'highlight': {
        const sel = text(a.selector, 200);
        if (!sel) return finish(fail('selector is required'));
        return finish(highlight(sel) as Result);
      }

      case 'recorder_status': {
        const r = await fetchJson<{ recorder: Record<string, unknown>; store: { days: { day: string; bytes: number }[]; totalBytes: number }; latestDay: { day: string; ok: boolean; sealedHours: number } | null }>('/api/tracks/status');
        if (!r.ok || !r.json) return finish(fail(`status unavailable: ${r.error}`));
        const rec = r.json.recorder;
        return finish({ ok: true, recording: rec.configured === true && rec.running === true, reason: rec.reason, receiver: rec.url, aircraft_in_range: rec.aircraftInRange, fixes_this_run: rec.fixesRecorded, last_error: rec.lastError, days_on_disk: r.json.store.days.length, bytes_on_disk: r.json.store.totalBytes, latest_day: r.json.latestDay });
      }

      case 'replay_tracks': {
        const from = Date.parse(text(a.from, 40)), to = Date.parse(text(a.to, 40));
        if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return finish(fail('from and to must be ISO date-times, to after from'));
        if (to - from > 6 * 3_600_000) return finish(fail('windows are limited to 6 hours'));
        let target = act;
        if (!target?.loadHistory) {
          deps.navigate(`/theater?history=${new Date(from).toISOString()}~${new Date(to).toISOString()}`);
          if (!(await waitForPage('theater', 8000))) return finish(fail('the theater did not come up in time — retry in a moment'));
          target = getActuators();
        }
        if (!target?.loadHistory) return finish(fail('no history control on this page'));
        return finish(await target.loadHistory(from, to));
      }

      case 'annotate': {
        const items = Array.isArray(a.annotations) ? a.annotations : [];
        if (!items.length) return finish(fail('annotations (array) is required'));
        if (!act?.annotate) return finish(fail(THREE_D_ONLY));
        return finish(act.annotate(items, a.replace === true));
      }

      case 'clear_annotations':
        if (!act?.clearAnnotations) return finish(fail(THREE_D_ONLY));
        return finish(act.clearAnnotations());

      case 'trace_history': {
        const q = String(a.aircraft || '').trim();
        if (!q) return finish(fail('aircraft (hex or callsign) is required'));
        if (!act?.showTrace) return finish(fail(THREE_D_ONLY));
        return finish(await act.showTrace(q));
      }

      case 'clear_trace':
        if (!act?.clearTrace) return finish(fail(THREE_D_ONLY));
        return finish(act.clearTrace());

      case 'detect_vehicles':
        if (!act?.detectVehicles) return finish(fail(THREE_D_ONLY));
        return finish(await act.detectVehicles(a.camera ? String(a.camera) : undefined));

      case 'find_aircraft': {
        const q = text(a.query, 12).toUpperCase().replace(/\s+/g, '');
        if (!q) return finish(fail('query is required'));
        const r = await fetchJson<{ found?: boolean; record?: Record<string, unknown>; sighting?: Record<string, unknown> | null; registry?: { ready: boolean; rows: number } }>(/^[0-9A-F]{6}$/.test(q) ? `/api/aircraft/lookup?hex=${q}` : `/api/aircraft/lookup?reg=${encodeURIComponent(q)}`);
        if (r.status === 404) return finish({ ok: true, found: false, note: 'not in the registry', registry_rows: r.json?.registry?.rows });
        if (!r.ok || !r.json) return finish(fail(`lookup failed: ${r.error}`));
        return finish({ ok: true, found: true, record: r.json.record, last_sighting: r.json.sighting ?? null });
      }

      case 'watchlist_status': {
        const r = await fetchJson<{ packs: { id: string; label: string; enabled: boolean; items: { label: string; reg: string; airborne: boolean; sighting: { lastSeenAt: number; callsign: string } | null }[] }[]; custom: { label: string; reg: string; airborne: boolean; sighting: { lastSeenAt: number; callsign: string } | null }[]; db: { ready: boolean }; alerts: boolean }>('/api/watchlist');
        if (!r.ok || !r.json) return finish(fail(`watchlist unavailable: ${r.error}`));
        const summarize = (items: { label: string; reg: string; airborne: boolean; sighting: { lastSeenAt: number; callsign: string } | null }[]) => items.map((i) => ({ label: i.label, reg: i.reg, airborne: i.airborne, callsign: i.sighting?.callsign || null, last_seen: i.sighting ? new Date(i.sighting.lastSeenAt).toISOString() : null }));
        return finish({ ok: true, registry_ready: r.json.db.ready, alerts: r.json.alerts, packs: r.json.packs.map((p) => ({ id: p.id, label: p.label, enabled: p.enabled, airborne_now: p.items.filter((i) => i.airborne).length, items: summarize(p.items) })), custom: summarize(r.json.custom) });
      }

      case 'watch_aircraft': {
        const q = text(a.query, 12);
        if (!q) return finish(fail('query is required'));
        const r = await fetchJson<{ reg?: string; hex?: string; desc?: string; owner?: string; label?: string }>('/api/watchlist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: q, label: text(a.label, 80) || undefined }) });
        if (!r.ok) return finish(fail(`could not add: ${r.error}`));
        return finish({ ok: true, watching: { reg: r.json?.reg, hex: r.json?.hex, desc: r.json?.desc, owner: r.json?.owner, label: r.json?.label } });
      }

      // ── sensitive ──
      case 'list_cases': {
        const r = await fetchJson<{ cases?: CaseRow[] }>('/api/cases');
        if (!r.ok) return finish(fail(`could not read cases: ${r.error}`));
        const rows = r.json?.cases ?? [];
        return finish({ ok: true, count: rows.length }, { title: rows.length ? 'Your cases' : 'No cases yet', lines: rows.map((c) => c.name) });
      }

      case 'open_case': {
        const f = await findCase(text(a.name, 120));
        if (!f.hit) return finish(f.result ?? fail('no match'), f.card);
        deps.navigate(`/console?case=${encodeURIComponent(f.hit.id)}`);
        return finish({ ok: true }, { title: 'Opened case', lines: [f.hit.name] });
      }

      case 'open_reconstruction': {
        const f = await findCase(text(a.name, 120));
        if (!f.hit) return finish(f.result ?? fail('no match'), f.card);
        deps.navigate(`/reconstruction/${encodeURIComponent(f.hit.id)}`);
        return finish({ ok: true }, { title: 'Opened reconstruction', lines: [f.hit.name] });
      }

      case 'run_lookup': {
        const kind = text(a.tool, 20);
        const q = text(a.query, 300);
        if (!(LOOKUP_KINDS as readonly string[]).includes(kind) || !q) return finish(fail('tool (kind) and query are required'));
        const confirmed = await deps.confirm(`Run a ${kind} lookup for “${q}”? This queries outside services.`);
        if (!confirmed) return finish({ ok: false, confirmed: false, note: 'the operator declined' });
        deps.navigate(`/console?tool=${encodeURIComponent(kind)}&q=${encodeURIComponent(q)}&run=1`);
        return finish({ ok: true, confirmed: true }, { title: 'Lookup running in the console', lines: [`${kind}: ${q}`] });
      }

      case 'save_note_to_case': {
        const note = text(a.note, 4000);
        if (!note) return finish(fail('note is required'));
        const f = await findCase(text(a.case_name, 120));
        if (!f.hit) return finish(f.result ?? fail('no match'), f.card);
        const confirmed = await deps.confirm(`Save this note to case “${f.hit.name}”?\n\n${note}`);
        if (!confirmed) return finish({ ok: false, confirmed: false, note: 'the operator declined' });
        const r = await fetchJson(`/api/cases/${encodeURIComponent(f.hit.id)}`, {
          method: 'PATCH', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ addFinding: { tool: 'assistant', query: note.slice(0, 120), summary: note, data: { via: 'scout', savedAt: new Date().toISOString() } } }),
        });
        if (!r.ok) return finish(fail(`save failed: ${r.error}`, { confirmed: true }));
        return finish({ ok: true, confirmed: true }, { title: `Saved to ${f.hit.name}`, lines: [note] });
      }

      case 'export_track_to_case': {
        const hex = text(a.hex, 8).toLowerCase();
        const from = Date.parse(text(a.from, 40)), to = Date.parse(text(a.to, 40));
        if (!/^~?[0-9a-f]{6}$/.test(hex) || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) return finish(fail('hex (6 hex digits), from and to (ISO) are required'));
        const f = await findCase(text(a.case_name, 120));
        if (!f.hit) return finish(f.result ?? fail('no match'), f.card);
        const confirmed = await deps.confirm(`File the recorded track of ${hex.toUpperCase()} (${new Date(from).toISOString().slice(11, 16)}–${new Date(to).toISOString().slice(11, 16)} UTC) into case “${f.hit.name}”?`);
        if (!confirmed) return finish({ ok: false, confirmed: false, note: 'the operator declined' });
        const r = await fetchJson<{ fixes?: number; sha256?: string }>('/api/tracks/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ caseId: f.hit.id, hex, from: new Date(from).toISOString(), to: new Date(to).toISOString() }) });
        if (!r.ok) return finish(fail(`export failed: ${r.error}`, { confirmed: true }));
        return finish({ ok: true, confirmed: true, count: r.json?.fixes ?? 0 }, { title: `Filed to ${f.hit.name}`, lines: [`${hex.toUpperCase()}: ${r.json?.fixes ?? 0} fixes, sha256 ${r.json?.sha256?.slice(0, 12) ?? '?'}…`] });
      }

      default:
        return finish(fail(`tool ${name} has no runner`));
    }
  } catch (e) {
    return finish(fail(`tool crashed: ${e instanceof Error ? e.message : String(e)}`));
  }
}
