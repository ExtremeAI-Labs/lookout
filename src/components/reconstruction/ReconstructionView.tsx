'use client';
// Case Reconstruction: a clock, a map, and the evidence. Every item shows two clocks
// (event vs. collected) and a basis (reported / observed / derived); derived items never
// look like observed ones. Nothing here is uploaded anywhere — the case file on disk is
// the only store, and the printable dossier picks the same rows up.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CaseFile } from '@/lib/cases';
import { RECON_BASES, RECON_KINDS, collectionLagMinutes, eventStartMs, sceneShotsFromReconstruction, sortByEvent, timelineBounds, visibleAt, type ReconBasis, type ReconItem, type ReconKind } from '@/lib/reconstruction';
import { captureShot, newSceneDocument } from '@/lib/theater/director';
import type { GeoJSONSource, Map as MLMap, MapMouseEvent } from 'maplibre-gl';

const BASIS_COLOR: Record<ReconBasis, string> = { reported: '#FFB300', observed: '#00E676', derived: '#B388FF' };
const BASIS_EXPLAIN: Record<ReconBasis, string> = {
  reported: 'Someone said so — a caller, a witness, a post. Not verified by a sensor or an investigator.',
  observed: 'A sensor, camera or witness recorded it at the time. Still check the source and its clock.',
  derived: 'An inference by the investigator — a path drawn between points, an estimate. Not an observation.',
};
const KIND_LABEL: Record<ReconKind, string> = { clip: 'CLIP', photo: 'PHOTO', camera_hit: 'CAMERA HIT', track: 'TRACK', note: 'NOTE', imagery: 'IMAGERY' };
const SPEEDS = [1, 10, 60, 600];

const fmt = (iso: string | null | undefined) => (iso ? new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + 'Z' : 'unknown');
const localInput = (iso?: string) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');

type Draft = { id?: string; kind: ReconKind; basis: ReconBasis; title: string; lat: string; lng: string; headingDeg: string; start: string; end: string; sourceLabel: string; sourceUrl: string; mediaUrl: string; note: string };
const emptyDraft = (): Draft => ({ kind: 'camera_hit', basis: 'observed', title: '', lat: '', lng: '', headingDeg: '', start: '', end: '', sourceLabel: '', sourceUrl: '', mediaUrl: '', note: '' });
const draftFrom = (i: ReconItem): Draft => ({ id: i.id, kind: i.kind, basis: i.basis, title: i.title, lat: i.at ? String(i.at.lat) : '', lng: i.at ? String(i.at.lng) : '', headingDeg: i.at?.headingDeg !== undefined ? String(i.at.headingDeg) : '', start: localInput(i.eventTime?.start), end: localInput(i.eventTime?.end), sourceLabel: i.source.label, sourceUrl: i.source.url || '', mediaUrl: i.mediaUrl || '', note: i.note || '' });

export default function ReconstructionView({ caseId }: { caseId: string }) {
  const [c, setCase] = useState<CaseFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [playhead, setPlayhead] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(60);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [imagery, setImagery] = useState<{ loading: boolean; scenes: { datetime: string; thumbnail: string | null; preview: string | null; id: string }[]; error: string | null } | null>(null);
  const [saving, setSaving] = useState(false);

  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const mapReady = useRef(false);
  const pickingRef = useRef(false);
  pickingRef.current = picking;
  const rafRef = useRef<number | null>(null);
  const framed = useRef(false);

  const items = useMemo(() => sortByEvent(c?.reconstruction?.items || []), [c]);
  const bounds = useMemo(() => timelineBounds(items), [items]);
  const current = items.find((i) => i.id === currentId) || null;
  const shown = useMemo(() => (playhead === null ? items : visibleAt(items, playhead)), [items, playhead]);

  // ── load ──
  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/cases/${encodeURIComponent(caseId)}`, { cache: 'no-store' });
      if (res.status === 404) { setError('That case does not exist.'); return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setCase(await res.json());
      setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [caseId]);
  useEffect(() => { void load(); }, [load]);

  const patch = useCallback(async (body: Record<string, unknown>): Promise<boolean> => {
    setSaving(true);
    try {
      const res = await fetch(`/api/cases/${encodeURIComponent(caseId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setFormError([json.error, ...(json.details || [])].filter(Boolean).join(' · ') || `HTTP ${res.status}`); return false; }
      setCase(json);
      setFormError(null);
      return true;
    } catch (e) { setFormError(e instanceof Error ? e.message : String(e)); return false; }
    finally { setSaving(false); }
  }, [caseId]);

  // ── map ──
  // Keyed on the case having loaded: until then the component renders its loading
  // branch and the map container does not exist, so a mount-only effect would find
  // nothing and never run again.
  const caseLoaded = !!c && !error;
  useEffect(() => {
    if (!caseLoaded || !mapEl.current || mapRef.current) return;
    let cancelled = false;
    (async () => {
      const maplibregl = await import('maplibre-gl');
      if (cancelled || !mapEl.current) return;
      maplibregl.setWorkerUrl(`/vendor/maplibre/${maplibregl.getVersion()}/maplibre-gl-worker.mjs`);
      const map = new maplibregl.Map({ container: mapEl.current, style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json', center: [-118.25, 34.05], zoom: 9, attributionControl: { compact: true } });
      mapRef.current = map;
      map.on('load', () => {
        map.addSource('recon-path', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        map.addSource('recon-items', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        // Recorded tracks (an exported finding's fixes) are OBSERVED: solid, in the observed colour.
        map.addSource('recon-tracks', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        map.addLayer({ id: 'recon-tracks', type: 'line', source: 'recon-tracks', paint: { 'line-color': BASIS_COLOR.observed, 'line-width': 2.5, 'line-opacity': 0.85 } });
        // The path between items is an inference — dashed and labelled DERIVED, never a solid "track".
        map.addLayer({ id: 'recon-path', type: 'line', source: 'recon-path', paint: { 'line-color': BASIS_COLOR.derived, 'line-width': 2, 'line-dasharray': [2, 2], 'line-opacity': 0.8 } });
        map.addLayer({ id: 'recon-halo', type: 'circle', source: 'recon-items', filter: ['==', ['get', 'current'], 1], paint: { 'circle-radius': 16, 'circle-color': '#D4AF37', 'circle-opacity': 0.25 } });
        map.addLayer({ id: 'recon-dots', type: 'circle', source: 'recon-items', paint: { 'circle-radius': 7, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#000', 'circle-stroke-width': 1.5, 'circle-opacity': ['case', ['==', ['get', 'future'], 1], 0.3, 1] } });
        map.addLayer({ id: 'recon-labels', type: 'symbol', source: 'recon-items', layout: { 'text-field': ['get', 'n'], 'text-size': 10, 'text-offset': [0, -1.6], 'text-allow-overlap': true }, paint: { 'text-color': '#fff', 'text-halo-color': '#000', 'text-halo-width': 1.2 } });
        map.on('click', 'recon-dots', (e: MapMouseEvent & { features?: { properties?: Record<string, unknown> }[] }) => { const id = e.features?.[0]?.properties?.id; if (id) setCurrentId(String(id)); });
        map.on('mouseenter', 'recon-dots', () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', 'recon-dots', () => { map.getCanvas().style.cursor = pickingRef.current ? 'crosshair' : ''; });
        map.on('click', (e: MapMouseEvent) => {
          if (!pickingRef.current) return;
          setDraft((d) => (d ? { ...d, lat: e.lngLat.lat.toFixed(6), lng: e.lngLat.lng.toFixed(6) } : d));
          setPicking(false);
          map.getCanvas().style.cursor = '';
        });
        mapReady.current = true;
      });
    })();
    return () => { cancelled = true; mapRef.current?.remove(); mapRef.current = null; mapReady.current = false; framed.current = false; };
  }, [caseLoaded]);

  // push items to the map whenever they, the playhead or the selection change
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const visible = new Set(shown.map((i) => i.id));
      const placed = items.filter((i) => i.at);
      const features = placed.map((i, n) => ({ type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [i.at!.lng, i.at!.lat] }, properties: { id: i.id, n: String(items.indexOf(i) + 1), color: BASIS_COLOR[i.basis], current: i.id === currentId ? 1 : 0, future: visible.has(i.id) ? 0 : 1 } }));
      (map.getSource('recon-items') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features });
      // A track item draws the fixes its linked finding carries (own-receiver recordings).
      const trackFeatures = items
        .filter((i) => i.kind === 'track' && i.findingId && visible.has(i.id))
        .map((i) => {
          const fixes = (c?.findings?.find((f) => f.id === i.findingId)?.data as { fixes?: unknown[] } | undefined)?.fixes;
          const coords = Array.isArray(fixes) ? fixes.filter((x): x is number[] => Array.isArray(x) && typeof x[2] === 'number' && typeof x[3] === 'number').map((x) => [x[3], x[2]]) : [];
          return coords.length > 1 ? { type: 'Feature' as const, geometry: { type: 'LineString' as const, coordinates: coords }, properties: { id: i.id } } : null;
        })
        .filter((f): f is NonNullable<typeof f> => f !== null);
      (map.getSource('recon-tracks') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: trackFeatures });
      const pathPts = placed.filter((i) => visible.has(i.id) && eventStartMs(i) !== null).map((i) => [i.at!.lng, i.at!.lat]);
      (map.getSource('recon-path') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: pathPts.length > 1 ? [{ type: 'Feature', geometry: { type: 'LineString', coordinates: pathPts }, properties: {} }] : [] });
    };
    if (mapReady.current) apply(); else map.once('load', apply);
  }, [items, shown, currentId, c]);

  // first load: frame the evidence
  useEffect(() => {
    const map = mapRef.current;
    if (!map || framed.current) return;
    const placed = items.filter((i) => i.at);
    if (!placed.length) return;
    const go = () => {
      framed.current = true;
      if (placed.length === 1) { map.jumpTo({ center: [placed[0].at!.lng, placed[0].at!.lat], zoom: 14 }); return; }
      const lngs = placed.map((i) => i.at!.lng), lats = placed.map((i) => i.at!.lat);
      map.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], { padding: 60, maxZoom: 15, duration: 0 });
    };
    if (mapReady.current) go(); else map.once('load', go);
  }, [items]);

  // ── playback ──
  useEffect(() => {
    if (!playing || !bounds) return;
    let last = performance.now();
    const step = (t: number) => {
      const dt = t - last; last = t;
      setPlayhead((p) => {
        const next = (p ?? bounds.start) + dt * speed;
        if (next >= bounds.end) { setPlaying(false); return bounds.end; }
        return next;
      });
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [playing, speed, bounds]);

  // the newest item that has happened by the playhead becomes current while playing
  useEffect(() => {
    if (playhead === null || !playing) return;
    const happened = items.filter((i) => { const s = eventStartMs(i); return s !== null && s <= playhead; });
    if (happened.length) setCurrentId(happened[happened.length - 1].id);
  }, [playhead, playing, items]);

  const flyToItem = useCallback((i: ReconItem) => {
    if (i.at) mapRef.current?.flyTo({ center: [i.at.lng, i.at.lat], zoom: Math.max(mapRef.current.getZoom(), 14), duration: 900 });
  }, []);

  // ── editing ──
  const submit = useCallback(async () => {
    if (!draft) return;
    const at = draft.lat.trim() || draft.lng.trim() ? { lat: Number(draft.lat), lng: Number(draft.lng), ...(draft.headingDeg.trim() ? { headingDeg: Number(draft.headingDeg) } : {}) } : undefined;
    const eventTime = draft.start ? { start: new Date(draft.start).toISOString(), ...(draft.end ? { end: new Date(draft.end).toISOString() } : {}) } : null;
    const payload = { id: draft.id, kind: draft.kind, basis: draft.basis, title: draft.title, at, eventTime, source: { label: draft.sourceLabel, url: draft.sourceUrl || undefined }, mediaUrl: draft.mediaUrl || undefined, note: draft.note || undefined };
    const ok = await patch(draft.id ? { updateReconItem: payload } : { addReconItem: payload });
    if (ok) { setDraft(null); setImagery(null); }
  }, [draft, patch]);

  const remove = useCallback(async (i: ReconItem) => {
    if (!window.confirm(`Remove “${i.title}” from the reconstruction? The finding it came from (if any) stays in the case.`)) return;
    await patch({ deleteReconItemId: i.id });
    if (currentId === i.id) setCurrentId(null);
  }, [patch, currentId]);

  const findImagery = useCallback(async () => {
    if (!draft || !draft.lat || !draft.lng) { setFormError('Set a position first (pick on map), then look for imagery there.'); return; }
    setImagery({ loading: true, scenes: [], error: null });
    try {
      const res = await fetch(`/api/sentinel?lat=${Number(draft.lat)}&lng=${Number(draft.lng)}&radius=0.3&days=120`, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setImagery({ loading: false, scenes: (json.scenes || []).slice(0, 12), error: (json.scenes || []).length ? null : 'No Sentinel scenes found there in the last 120 days.' });
    } catch (e) { setImagery({ loading: false, scenes: [], error: e instanceof Error ? e.message : String(e) }); }
  }, [draft]);

  const openIn3D = useCallback(async () => {
    const shots = sceneShotsFromReconstruction(items);
    if (!shots.length) return;
    const doc = newSceneDocument(`Reconstruction · ${c?.name || caseId}`);
    doc.shots = shots.map((s) => captureShot(s.camera, { label: s.label, durationSec: s.durationSec, holdSec: s.holdSec, layers: s.layers }));
    try {
      const res = await fetch('/api/scenes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ document: doc }) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      window.location.href = `/theater?scene=${encodeURIComponent(json.scene.id)}&play=1&layers=cctv,canvass`;
    } catch (e) { setError(`Could not build the 3D scene: ${e instanceof Error ? e.message : String(e)}`); }
  }, [items, c, caseId]);

  if (error) return <div className="recon"><div className="recon-veil" role="alert">{error}<br /><a className="recon-btn" href="/console">← CONSOLE</a></div></div>;
  if (!c) return <div className="recon"><div className="recon-veil" role="status">Loading case…</div></div>;

  const placedCount = items.filter((i) => i.at).length;

  return (
    <main className="recon">
      <header className="recon-bar">
        <a className="recon-btn" href="/console">← CONSOLE</a>
        <div className="recon-title">RECONSTRUCTION <span>· {c.name}</span></div>
        <div className="spacer" />
        <button className="recon-btn is-primary" onClick={() => { setDraft(emptyDraft()); setFormError(null); setImagery(null); }}>+ ADD ITEM</button>
        <button className="recon-btn" onClick={openIn3D} disabled={!placedCount} title={placedCount ? 'Replay the placed items as a 3D scene' : 'Place at least one item first'}>OPEN IN 3D</button>
        <a className="recon-btn" href={`/api/cases/${encodeURIComponent(c.id)}/dossier?print=1`} target="_blank" rel="noreferrer">⎙ DOSSIER</a>
        <a className="recon-btn" href={placedCount && items.find((i) => i.at) ? `/?lat=${items.find((i) => i.at)!.at!.lat.toFixed(5)}&lon=${items.find((i) => i.at)!.at!.lng.toFixed(5)}&zoom=14` : '/'}>MAP</a>
      </header>

      <section className="recon-list" aria-label="Evidence items">
        <div className="recon-list-head"><span>ITEMS · {items.length}</span><span>{saving ? 'saving…' : ''}</span></div>
        {items.length === 0 && !draft && <div className="recon-empty">Nothing placed yet. Add a camera hit, a clip, a photo, a note or an imagery scene — with where it happened, when it happened, and where it came from. Items with no time are kept but flagged.</div>}
        <ul className="recon-items">
          {items.map((i, n) => {
            const lag = collectionLagMinutes(i);
            const hidden = playhead !== null && !shown.includes(i);
            return (
              <li key={i.id} className={`recon-item ${i.id === currentId ? 'is-current' : ''} ${hidden ? 'is-future' : ''}`} style={{ ['--basis' as string]: BASIS_COLOR[i.basis] }} onClick={() => { setCurrentId(i.id); flyToItem(i); }}>
                <div className="bar" aria-hidden />
                <div>
                  <span className="kind">{n + 1} · {KIND_LABEL[i.kind]}</span><span className="basis">{i.basis.toUpperCase()}</span>
                  <div className="title">{i.title}</div>
                  <div className="clocks">event <b>{fmt(i.eventTime?.start)}</b>{i.eventTime?.end ? <> – <b>{fmt(i.eventTime.end)}</b></> : null}<br />collected <b>{fmt(i.collectedTime)}</b>{lag !== null && lag > 0 && <span className="lag"> (+{lag >= 60 ? `${Math.round(lag / 60)} h` : `${lag} min`})</span>}</div>
                  <div className="src">{i.source.label}{i.at ? '' : ' · no position'}</div>
                </div>
              </li>
            );
          })}
        </ul>

        {draft && (
          <form className="recon-form" onSubmit={(e) => { e.preventDefault(); void submit(); }} aria-label={draft.id ? 'Edit item' : 'Add item'}>
            <div className="row">
              <label>KIND<select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as ReconKind })}>{RECON_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select></label>
              <label>BASIS<select value={draft.basis} onChange={(e) => setDraft({ ...draft, basis: e.target.value as ReconBasis })}>{RECON_BASES.map((b) => <option key={b} value={b}>{b.toUpperCase()}</option>)}</select></label>
            </div>
            <label>TITLE<input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} required maxLength={160} placeholder="What is this item?" /></label>
            <div className="row3">
              <label>LAT<input value={draft.lat} onChange={(e) => setDraft({ ...draft, lat: e.target.value })} inputMode="decimal" placeholder="34.0160" /></label>
              <label>LNG<input value={draft.lng} onChange={(e) => setDraft({ ...draft, lng: e.target.value })} inputMode="decimal" placeholder="-118.4960" /></label>
              <button type="button" className={`recon-btn ${picking ? 'is-on' : ''}`} onClick={() => { setPicking((p) => !p); if (mapRef.current) mapRef.current.getCanvas().style.cursor = picking ? '' : 'crosshair'; }}>{picking ? 'CLICK MAP…' : 'PICK ON MAP'}</button>
            </div>
            <div className="row">
              <label>FACING (°, optional)<input value={draft.headingDeg} onChange={(e) => setDraft({ ...draft, headingDeg: e.target.value })} inputMode="numeric" placeholder="e.g. 270" /></label>
              <label>EVENT TIME<input type="datetime-local" value={draft.start} onChange={(e) => setDraft({ ...draft, start: e.target.value })} /></label>
            </div>
            <label>EVENT END (optional)<input type="datetime-local" value={draft.end} onChange={(e) => setDraft({ ...draft, end: e.target.value })} /></label>
            <div className="row">
              <label>SOURCE<input value={draft.sourceLabel} onChange={(e) => setDraft({ ...draft, sourceLabel: e.target.value })} required maxLength={200} placeholder="Caltrans D7 cam 4676 / witness J.R. / Sentinel-1" /></label>
              <label>SOURCE URL<input value={draft.sourceUrl} onChange={(e) => setDraft({ ...draft, sourceUrl: e.target.value })} inputMode="url" placeholder="https://…" /></label>
            </div>
            <label>MEDIA URL (image / video)<input value={draft.mediaUrl} onChange={(e) => setDraft({ ...draft, mediaUrl: e.target.value })} inputMode="url" placeholder="https://…" /></label>
            <label>NOTE<textarea value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} rows={3} maxLength={4000} /></label>
            {formError && <div className="recon-error" role="alert">{formError}</div>}
            <div className="actions">
              <button type="submit" className="recon-btn is-primary" disabled={saving}>{draft.id ? 'SAVE' : 'ADD'}</button>
              <button type="button" className="recon-btn" onClick={() => { setDraft(null); setPicking(false); setImagery(null); }}>CANCEL</button>
              <button type="button" className="recon-btn" onClick={findImagery} disabled={imagery?.loading}>{imagery?.loading ? 'SEARCHING…' : 'FIND SATELLITE IMAGERY'}</button>
            </div>
            {imagery && !imagery.loading && (
              <div className="recon-imagery">
                {imagery.error && <div className="recon-error">{imagery.error}</div>}
                {imagery.scenes.map((s) => (
                  <button type="button" key={s.id} onClick={() => setDraft({ ...draft, kind: 'imagery', basis: 'observed', title: draft.title || `Sentinel-1 scene ${fmt(s.datetime)}`, start: localInput(s.datetime), sourceLabel: 'Sentinel-1 (Copernicus) via STAC', sourceUrl: s.preview || s.thumbnail || '', mediaUrl: s.thumbnail || s.preview || '' })}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {s.thumbnail ? <img src={s.thumbnail} alt="" loading="lazy" /> : <span />}
                    <span>{fmt(s.datetime)}<br /><small>use this scene</small></span>
                  </button>
                ))}
              </div>
            )}
          </form>
        )}
      </section>

      <section className="recon-map" aria-label="Map">
        <div ref={mapEl} className="recon-map-canvas" />
        {picking && <div className="recon-map-hint">Click the map to set this item’s position</div>}
        {current && !draft && (
          <div className="recon-card" role="dialog" aria-label={current.title} style={{ ['--basis' as string]: BASIS_COLOR[current.basis] }}>
            <span className="basis-chip">{current.basis.toUpperCase()} · {KIND_LABEL[current.kind]}</span>
            <h3>{current.title}</h3>
            <p className="basis-explain">{BASIS_EXPLAIN[current.basis]}</p>
            {current.mediaUrl && /\.(mp4|webm|mov)(\?|$)/i.test(current.mediaUrl) ? <video src={current.mediaUrl} controls preload="metadata" /> : current.mediaUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={current.mediaUrl} alt={current.title} loading="lazy" />
            ) : null}
            <div className="clocks">event {fmt(current.eventTime?.start)}{current.eventTime?.end ? ` – ${fmt(current.eventTime.end)}` : ''}<br />collected {fmt(current.collectedTime)}<br />source {current.source.label}{current.source.sha256 ? <><br />sha256 {current.source.sha256.slice(0, 16)}…</> : null}</div>
            {current.note && <div className="note">{current.note}</div>}
            <div className="actions">
              <button className="recon-btn" onClick={() => { setDraft(draftFrom(current)); setFormError(null); }}>EDIT</button>
              {current.source.url && <a className="recon-btn" href={current.source.url} target="_blank" rel="noreferrer">SOURCE</a>}
              {current.at && <a className="recon-btn" href={`/theater?lat=${current.at.lat.toFixed(5)}&lng=${current.at.lng.toFixed(5)}&alt=450&heading=${Math.round(current.at.headingDeg ?? 0)}&pitch=-50&layers=cctv,canvass`}>3D</a>}
              <button className="recon-btn" onClick={() => remove(current)}>REMOVE</button>
              <button className="recon-btn" onClick={() => setCurrentId(null)}>CLOSE</button>
            </div>
          </div>
        )}
      </section>

      <footer className="recon-time" aria-label="Timeline">
        {bounds ? (
          <>
            <div className="recon-time-row">
              <button className="recon-btn" onClick={() => setPlaying((p) => !p)}>{playing ? '❚❚ PAUSE' : '▶ PLAY'}</button>
              <button className="recon-btn" onClick={() => { setPlaying(false); setPlayhead(null); }} disabled={playhead === null}>ALL</button>
              <span className="clock">{playhead === null ? 'showing everything' : fmt(new Date(playhead).toISOString())}</span>
              <input type="range" min={bounds.start} max={bounds.end} step={1000} value={playhead ?? bounds.end} onChange={(e) => { setPlaying(false); setPlayhead(Number(e.target.value)); }} aria-label="Time" />
              <div className="speed" role="radiogroup" aria-label="Playback speed">{SPEEDS.map((s) => <button key={s} role="radio" aria-checked={speed === s} className={`recon-btn ${speed === s ? 'is-on' : ''}`} onClick={() => setSpeed(s)}>{s}×</button>)}</div>
            </div>
            <div className="ticks" aria-hidden>
              {items.map((i) => { const s = eventStartMs(i); return s === null ? null : <span key={i.id} className="tick" style={{ left: `${((s - bounds.start) / (bounds.end - bounds.start)) * 100}%`, ['--basis' as string]: BASIS_COLOR[i.basis] }} />; })}
            </div>
          </>
        ) : (
          <div className="no-times">Give items an event time and the clock appears here.</div>
        )}
      </footer>
    </main>
  );
}
