import { describe, expect, it, vi } from 'vitest';
import { CALTRANS_LAYER, WSDOT_LAYER, fetchCameraFeatures, fetchCaltransCameras, fetchWSDOTCameras, mergeDistrictSeven } from './us-traffic';

const feature = (id: number, extra: Record<string, unknown> = {}) => ({
  attributes: { OBJECTID: id, latitude: 34.05, longitude: -118.24, locationName: 'I-110', currentImageURL: 'https://cwwp2.dot.ca.gov/la.jpg', ...extra },
});

describe('official traffic catalogs', () => {
  it('adds missing LA cameras from the wholesale list, preserves ids, and removes reported offline cameras', () => {
    const base = [
      { id: 'cal-10', lat: 34, lng: -118, name: 'Old title', city: 'LA', country: 'US', source: 'Caltrans', feed_url: 'https://cwwp2.dot.ca.gov/data/d7/cctv/old.jpg' },
      { id: 'cal-11', lat: 37, lng: -122, name: 'Bay Area', city: 'SF', country: 'US', source: 'Caltrans', feed_url: 'https://cwwp2.dot.ca.gov/data/d4/cctv/sf.jpg' },
    ];
    const row = (filename: string, inService = 'true') => ({ cctv: { inService,
      location: { district: '7', latitude: '34', longitude: '-118', locationName: 'LA current title' },
      imageData: { static: { currentImageURL: `https://cwwp2.dot.ca.gov/data/d7/cctv/${filename}.jpg` } },
    } });
    const data = { data: [row('old'), row('new'), row('offline', 'false'), row('new')] };
    const merged = mergeDistrictSeven(base, data);
    expect(merged).toHaveLength(3);
    expect(merged.find(c => c.id === 'cal-10')?.name).toBe('LA current title');
    expect(merged.find(c => c.id.startsWith('cal-d7-'))?.feed_url).toContain('/new.jpg');
    expect(mergeDistrictSeven(merged, data)).toEqual(merged); // stable ids and no duplicates on refresh
    expect(mergeDistrictSeven(base, { data: [] })).toEqual(base);
    expect(mergeDistrictSeven(base, { data: [{ nonsense: true }] })).toEqual(base);
  });
  it('loads later pages, preserving ids and requesting deterministic WGS84 results', async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ features: [feature(1), feature(2)], exceededTransferLimit: true }))
      .mockResolvedValueOnce(Response.json({ features: [feature(2001)], exceededTransferLimit: false }));
    const cameras = await fetchCaltransCameras(request);
    expect(cameras.map(c => c.id)).toEqual(['cal-1', 'cal-2', 'cal-2001']);
    const next = new URL(String(request.mock.calls[1][0]));
    expect(next.origin + next.pathname).toBe(`${CALTRANS_LAYER}/query`);
    expect(next.searchParams.get('resultOffset')).toBe('2');
    expect(next.searchParams.get('orderByFields')).toBe('OBJECTID ASC');
    expect(next.searchParams.get('outSR')).toBe('4326');
    expect(cameras.every(c => c.stream_type === 'jpg' && !c.stream_url)).toBe(true);
    expect(request.mock.calls[0][1]?.headers).toEqual({ Accept: 'application/json' });
  });

  it('does not replace a complete catalog with a partial refresh after a later page fails', async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ features: [feature(1)], exceededTransferLimit: true }))
      .mockResolvedValueOnce(new Response('', { status: 503 }));
    await expect(fetchCaltransCameras(request)).rejects.toThrow('HTTP 503');
  });

  it('rejects ArcGIS errors, empty first pages and a server that ignores pagination', async () => {
    for (const data of [{ error: { code: 400 } }, { features: [] }, { features: null }]) {
      await expect(fetchCaltransCameras(vi.fn().mockResolvedValue(Response.json(data)))).rejects.toThrow();
    }
    const request = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ features: [feature(1)], exceededTransferLimit: true }));
    await expect(fetchCaltransCameras(request)).rejects.toThrow('repeated');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('bounds pagination when a malfunctioning service never signals completion', async () => {
    let id = 0;
    const request = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ features: [feature(++id)], exceededTransferLimit: true }));
    await expect(fetchCameraFeatures(CALTRANS_LAYER, '*', request)).rejects.toThrow('pagination limit');
    expect(request).toHaveBeenCalledTimes(20);
  });

  it('rejects invalid coordinates and non-public URL formats while retaining signed query strings', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ features: [
      feature(1), feature(2, { latitude: null }), feature(3, { latitude: 'bad' }),
      feature(4, { longitude: 0 }), feature(5, { currentImageURL: 'file:///tmp/a.jpg' }),
      feature(6, { currentImageURL: 'https://user:secret@example.com/a.jpg' }),
      feature(7, { currentImageURL: 'https://cwwp2.dot.ca.gov/a.jpg?version=2' }),
    ] }));
    const cameras = await fetchCaltransCameras(request);
    expect(cameras.map(c => c.id)).toEqual(['cal-1', 'cal-7']);
    expect(cameras[1].feed_url).toContain('?version=2');
  });

  it('restores WSDOT using geometry from its new official layer and filters out-of-state points', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ features: [
      { attributes: { OBJECTID: 1001, CameraTitle: 'I-5 Seattle', ImageURL: 'https://images.wsdot.wa.gov/a.jpg' }, geometry: { x: -122.33, y: 47.61 } },
      { attributes: { OBJECTID: 1002, ImageURL: 'https://images.wsdot.wa.gov/b.jpg' }, geometry: { x: 0, y: 0 } },
    ] }));
    expect(await fetchWSDOTCameras(request)).toEqual([expect.objectContaining({
      id: 'wsdot-1001', name: 'I-5 Seattle', lat: 47.61, lng: -122.33, stream_type: 'jpg', source: 'WSDOT',
    })]);
    expect(String(request.mock.calls[0][0])).toContain(WSDOT_LAYER);
  });
});
