export type CatalogCamera = { id: string | number; [key: string]: unknown };

/** Partial retries must add cameras, not erase previously loaded regions. */
export function mergeCameraCatalog<T extends { id: string | number }>(previous: T[], incoming: T[]): T[] {
  const merged = new Map(previous.map(camera => [String(camera.id), camera]));
  for (const camera of incoming) merged.set(String(camera.id), camera);
  return [...merged.values()];
}

/**
 * Recover slow regions without downloading the entire worldwide list again.
 *
 * `opts.center` bounds the FIRST request to the region(s) around one point instead of the
 * whole world (`region=all` is ~39k cameras / ~17.5 MB raw) — the hosted showcase passes the
 * current view centre so a viewer's first toggle costs one region, not the planet. Any retries
 * (a region that came back empty or errored) still walk `pendingRegions` as concrete region
 * keys, exactly as the worldwide path always has — `center` only shapes the opening request.
 */
export function loadCameraCatalog(
  onBatch: (cameras: CatalogCamera[]) => void,
  onError: () => void,
  opts?: { liveOnly?: boolean; center?: { lat: number; lng: number; radius?: number } },
) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  const load = async (regions: string[], center?: { lat: number; lng: number; radius?: number }) => {
    attempts++;
    let remaining = regions;
    try {
      const query = center
        ? new URLSearchParams({ lat: String(center.lat), lng: String(center.lng), radius: String(center.radius ?? 500) })
        : new URLSearchParams({ region: regions.join(',') });
      /* 88% of the catalogue is snapshot stills; this narrows to feeds that actually stream. */
      if (opts?.liveOnly) query.set('live', '1');
      const response = await fetch(`/api/cctv?${query}`, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error(`Camera catalogue HTTP ${response.status}`);
      const data = await response.json();
      if (!Array.isArray(data.cameras)) throw new Error('Invalid camera catalogue');
      if (controller.signal.aborted) return;
      if (data.cameras.length) onBatch(data.cameras);
      remaining = Array.isArray(data.pendingRegions)
        ? data.pendingRegions.filter((region: unknown): region is string => typeof region === 'string' && /^[a-z-]+$/.test(region))
        : data.cameras.length ? [] : (center ? [] : regions);
    } catch {
      if (controller.signal.aborted) return;
      onError();
    }
    // Three attempts total, with backoff. No endless retries against dead feeds. A retry always
    // walks concrete region keys (never re-sends `center`) so it targets just what came back
    // pending, not the whole bounded area again.
    if (remaining.length && attempts < 3 && !controller.signal.aborted) {
      timer = setTimeout(() => void load(remaining), attempts * 15_000);
    }
  };
  void load(['all'], opts?.center);
  return () => { controller.abort(); clearTimeout(timer); };
}
