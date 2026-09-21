'use client';
// Feeds the theater's layers from Lookout's /api routes: one poller per active layer,
// on the cadence the registry declares, aborted the moment a layer is switched off.
// Every failure is kept and shown ("feed error", with the time of the last good data) —
// an empty sky must never be mistaken for a quiet one.
import { useCallback, useEffect, useRef, useState } from 'react';
import { loadCameraCatalog } from '@/lib/camera-catalog';
import { CANVASS_MAX_ALT_M, THEATER_LAYERS, fetchCanvassQuery, type TheaterLayerId } from '@/lib/theater/layers';
import type { TheaterLayer } from './layers/base';

export type FeedStatus = { count: number; updatedAt: number | null; error: string | null; loading: boolean; note?: string };

export type ViewCenter = { lat: number; lng: number; alt: number };

const idle = (): FeedStatus => ({ count: 0, updatedAt: null, error: null, loading: false });

export function useTheaterFeeds(active: Set<TheaterLayerId>, layers: Map<TheaterLayerId, TheaterLayer> | null, getViewCenter: () => ViewCenter | null) {
  const [status, setStatus] = useState<Record<TheaterLayerId, FeedStatus>>(() => Object.fromEntries(THEATER_LAYERS.map((l) => [l.id, idle()])) as Record<TheaterLayerId, FeedStatus>);
  const layersRef = useRef(layers);
  layersRef.current = layers;

  const patch = useCallback((id: TheaterLayerId, s: Partial<FeedStatus>) => setStatus((prev) => ({ ...prev, [id]: { ...prev[id], ...s } })), []);

  const deliver = useCallback((id: TheaterLayerId, payload: unknown) => {
    const layer = layersRef.current?.get(id);
    if (!layer) return;
    layer.update(payload, Date.now());
    const vesselsNote = id === 'vessels' && !((payload as { total_ships?: number })?.total_ships) ? 'no AIS key — ports & chokepoints only' : undefined;
    patch(id, { count: layer.count(), updatedAt: Date.now(), error: null, loading: false, note: vesselsNote });
  }, [patch]);

  // Aircraft: one route serves two toggles.
  const flightsOn = active.has('flights') || active.has('military');
  useEffect(() => {
    if (!flightsOn || !layers) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const def = THEATER_LAYERS.find((l) => l.id === 'flights')!;
    const poll = async () => {
      patch('flights', { loading: true }); patch('military', { loading: true });
      try {
        const res = await fetch(def.endpoint, { signal: controller.signal, cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const layer = layersRef.current?.get('flights');
        layer?.update(json, Date.now());
        const mil = (json.military_flights || []).length, civil = layer ? layer.count() - (active.has('military') ? mil : 0) : 0;
        const providers = json.providers || {};
        const note = providers.opensky ? `OpenSky snapshot ${providers.opensky_age_s ?? '?'} s old` : 'adsb.fi only';
        patch('flights', { count: Math.max(0, civil), updatedAt: Date.now(), error: null, loading: false, note });
        patch('military', { count: mil, updatedAt: Date.now(), error: null, loading: false });
      } catch (e) {
        if (controller.signal.aborted) return;
        const error = e instanceof Error ? e.message : String(e);
        patch('flights', { error, loading: false }); patch('military', { error, loading: false });
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, def.refreshMs);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flightsOn, layers]);

  usePlainPoller('vessels', active.has('vessels'), layers, deliver, patch);
  usePlainPoller('satellites', active.has('satellites'), layers, deliver, patch);
  usePlainPoller('earthquakes', active.has('earthquakes'), layers, deliver, patch);

  // Cameras: the catalogue loader already knows how to fetch region by region and retry.
  useEffect(() => {
    if (!active.has('cctv') || !layers) return;
    patch('cctv', { loading: true, error: null });
    const stop = loadCameraCatalog(
      (batch) => deliver('cctv', batch),
      () => patch('cctv', { error: 'some camera regions failed to load', loading: false }),
    );
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.has('cctv'), layers]);

  // Canvass: a 1.5 km ring around wherever the camera is looking, refreshed on demand.
  const canvassController = useRef<AbortController | null>(null);
  const refreshCanvass = useCallback(async () => {
    if (!active.has('canvass') || !layersRef.current) return;
    const center = getViewCenter();
    if (!center) return;
    if (center.alt > CANVASS_MAX_ALT_M) { patch('canvass', { note: 'zoom in below 6 km to load devices', loading: false }); return; }
    canvassController.current?.abort();
    const controller = new AbortController();
    canvassController.current = controller;
    patch('canvass', { loading: true, note: undefined });
    try {
      const res = await fetch(fetchCanvassQuery(center.lat, center.lng), { signal: controller.signal, cache: 'no-store' });
      if (res.status === 503) { patch('canvass', { error: 'device index still warming up', loading: false }); return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      deliver('canvass', await res.json());
    } catch (e) {
      if (controller.signal.aborted) return;
      patch('canvass', { error: e instanceof Error ? e.message : String(e), loading: false });
    }
  }, [active, getViewCenter, deliver, patch]);

  useEffect(() => {
    if (active.has('canvass')) void refreshCanvass();
    else canvassController.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.has('canvass'), layers]);

  return { status, refreshCanvass };
}

/** Fetch a layer's endpoint on its cadence while it is on; stop the moment it is off. */
function usePlainPoller(id: TheaterLayerId, enabled: boolean, layers: Map<TheaterLayerId, TheaterLayer> | null,
  deliver: (id: TheaterLayerId, payload: unknown) => void, patch: (id: TheaterLayerId, s: Partial<FeedStatus>) => void) {
  useEffect(() => {
    if (!enabled || !layers) return;
    const def = THEATER_LAYERS.find((l) => l.id === id)!;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      patch(id, { loading: true });
      try {
        const res = await fetch(def.endpoint, { signal: controller.signal, cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        deliver(id, await res.json());
      } catch (e) {
        if (controller.signal.aborted) return;
        patch(id, { error: e instanceof Error ? e.message : String(e), loading: false });
      }
      if (!controller.signal.aborted && def.refreshMs) timer = setTimeout(poll, def.refreshMs);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [id, enabled, layers, deliver, patch]);
}
