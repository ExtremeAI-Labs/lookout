import { describe, it, expect } from 'vitest';
import {
  validateSceneDocument,
  runScene,
  seekShot,
  newSceneDocument,
  captureShot,
  type SceneDocument,
  type SceneAdapter,
  type SceneShotCamera,
} from './director';

const CAMERA: SceneShotCamera = { lat: 34.0522, lng: -118.2437, alt: 1800, heading: 10, pitch: -35 };

function goodDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    id: 'scene-1',
    title: 'Downtown flyover',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    shots: [
      { id: 'shot-1', camera: CAMERA, durationSec: 4, holdSec: 1 },
      { id: 'shot-2', camera: { ...CAMERA, lat: 34.06 }, durationSec: 3, holdSec: 2, style: 'thermal', layers: { hud: true } },
    ],
    ...overrides,
  };
}

describe('validateSceneDocument', () => {
  it('accepts a well-formed document', () => {
    const result = validateSceneDocument(goodDoc());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.doc.shots).toHaveLength(2);
    expect(result.doc.shots[1].style).toBe('thermal');
    expect(result.doc.shots[1].layers).toEqual({ hud: true });
  });

  it('drops unknown top-level and shot fields instead of rejecting them', () => {
    const doc = goodDoc({ somethingUnknown: 'ignored' });
    (doc.shots as Record<string, unknown>[])[0].extra = 'ignored';
    const result = validateSceneDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.doc).not.toHaveProperty('somethingUnknown');
    expect(result.doc.shots[0]).not.toHaveProperty('extra');
  });

  it('normalises heading into 0..360 rather than rejecting it', () => {
    const doc = goodDoc();
    (doc.shots as Record<string, unknown>[])[0].camera = { ...CAMERA, heading: 400 };
    (doc.shots as Record<string, unknown>[])[1].camera = { ...CAMERA, heading: -10 };
    const result = validateSceneDocument(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.doc.shots[0].camera.heading).toBe(40);
    expect(result.doc.shots[1].camera.heading).toBe(350);
  });

  it('rejects more than 200 shots', () => {
    const shots = Array.from({ length: 201 }, (_, i) => ({ id: `shot-${i}`, camera: CAMERA, durationSec: 1, holdSec: 1 }));
    const result = validateSceneDocument(goodDoc({ shots }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected errors');
    expect(result.errors.some((e) => e.includes('shots'))).toBe(true);
  });

  it('rejects a title over 120 characters', () => {
    const result = validateSceneDocument(goodDoc({ title: 'x'.repeat(121) }));
    expect(result.ok).toBe(false);
  });

  it('rejects a label over 80 characters', () => {
    const doc = goodDoc();
    (doc.shots as Record<string, unknown>[])[0].label = 'x'.repeat(81);
    const result = validateSceneDocument(doc);
    expect(result.ok).toBe(false);
  });

  it('rejects out-of-range lat/lng', () => {
    const doc = goodDoc();
    (doc.shots as Record<string, unknown>[])[0].camera = { ...CAMERA, lat: 91 };
    expect(validateSceneDocument(doc).ok).toBe(false);
    const doc2 = goodDoc();
    (doc2.shots as Record<string, unknown>[])[0].camera = { ...CAMERA, lng: -181 };
    expect(validateSceneDocument(doc2).ok).toBe(false);
  });

  it('rejects altitude outside 50..40,000,000', () => {
    const tooLow = goodDoc();
    (tooLow.shots as Record<string, unknown>[])[0].camera = { ...CAMERA, alt: 49 };
    expect(validateSceneDocument(tooLow).ok).toBe(false);
    const tooHigh = goodDoc();
    (tooHigh.shots as Record<string, unknown>[])[0].camera = { ...CAMERA, alt: 40_000_001 };
    expect(validateSceneDocument(tooHigh).ok).toBe(false);
  });

  it('rejects pitch outside -90..0', () => {
    const doc = goodDoc();
    (doc.shots as Record<string, unknown>[])[0].camera = { ...CAMERA, pitch: 1 };
    expect(validateSceneDocument(doc).ok).toBe(false);
  });

  it('rejects durations outside 0..600 seconds', () => {
    const doc = goodDoc();
    (doc.shots as Record<string, unknown>[])[0].durationSec = 601;
    expect(validateSceneDocument(doc).ok).toBe(false);
    const doc2 = goodDoc();
    (doc2.shots as Record<string, unknown>[])[0].holdSec = -1;
    expect(validateSceneDocument(doc2).ok).toBe(false);
  });

  it('rejects a non-string style or label', () => {
    const doc = goodDoc();
    (doc.shots as Record<string, unknown>[])[0].style = 42;
    expect(validateSceneDocument(doc).ok).toBe(false);
    const doc2 = goodDoc();
    (doc2.shots as Record<string, unknown>[])[0].label = 42;
    expect(validateSceneDocument(doc2).ok).toBe(false);
  });

  it('rejects layers with more than 64 keys or non-boolean values', () => {
    const tooMany = goodDoc();
    const layers: Record<string, boolean> = {};
    for (let i = 0; i < 65; i++) layers[`layer-${i}`] = true;
    (tooMany.shots as Record<string, unknown>[])[0].layers = layers;
    expect(validateSceneDocument(tooMany).ok).toBe(false);

    const notBoolean = goodDoc();
    (notBoolean.shots as Record<string, unknown>[])[0].layers = { hud: 'yes' };
    expect(validateSceneDocument(notBoolean).ok).toBe(false);
  });

  it('never throws, even on garbage input', () => {
    expect(() => validateSceneDocument(null)).not.toThrow();
    expect(() => validateSceneDocument(undefined)).not.toThrow();
    expect(() => validateSceneDocument('nonsense')).not.toThrow();
    expect(() => validateSceneDocument(42)).not.toThrow();
    expect(() => validateSceneDocument([])).not.toThrow();
    expect(validateSceneDocument(null).ok).toBe(false);
  });
});

const PHASES = ['selectShot', 'applyVisual', 'applyLayers', 'travel', 'settle', 'hold'] as const;

function fakeAdapter(calls: string[], overrides: Partial<SceneAdapter> = {}): SceneAdapter {
  const base: SceneAdapter = {
    selectShot: (_shot, index) => {
      calls.push(`selectShot:${index}`);
    },
    applyVisual: (_style) => {
      calls.push('applyVisual');
    },
    applyLayers: (_layers) => {
      calls.push('applyLayers');
    },
    travel: async (_camera, durationSec) => {
      calls.push(`travel:${durationSec}`);
    },
    settle: async () => {
      calls.push('settle');
    },
    hold: async (seconds) => {
      calls.push(`hold:${seconds}`);
    },
    completeShot: (_shot, index) => {
      calls.push(`completeShot:${index}`);
    },
  };
  return { ...base, ...overrides };
}

function docWithShots(count: number): SceneDocument {
  const shots = Array.from({ length: count }, (_, i) => ({
    id: `shot-${i}`,
    camera: { ...CAMERA, lat: CAMERA.lat + i },
    durationSec: 4,
    holdSec: 2,
  }));
  const result = validateSceneDocument({
    version: 1,
    id: 'doc',
    title: 'Test scene',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    shots,
  });
  if (!result.ok) throw new Error('bad fixture');
  return result.doc;
}

describe('runScene', () => {
  it('runs every phase in order for every shot, then completes', async () => {
    const calls: string[] = [];
    const doc = docWithShots(2);
    const result = await runScene(doc, fakeAdapter(calls));
    expect(result).toBe('completed');
    expect(calls).toEqual([
      'selectShot:0', 'applyVisual', 'applyLayers', 'travel:4', 'settle', 'hold:2', 'completeShot:0',
      'selectShot:1', 'applyVisual', 'applyLayers', 'travel:4', 'settle', 'hold:2', 'completeShot:1',
    ]);
  });

  it('skips settle when the adapter does not implement it', async () => {
    const calls: string[] = [];
    const doc = docWithShots(1);
    const adapter = fakeAdapter(calls);
    delete adapter.settle;
    const result = await runScene(doc, adapter);
    expect(result).toBe('completed');
    expect(calls).toEqual(['selectShot:0', 'applyVisual', 'applyLayers', 'travel:4', 'hold:2', 'completeShot:0']);
  });

  it('speed shortens travel and hold durations', async () => {
    const calls: string[] = [];
    const doc = docWithShots(1);
    await runScene(doc, fakeAdapter(calls), { speed: 2 });
    expect(calls).toContain('travel:2');
    expect(calls).toContain('hold:1');
  });

  it('startAt skips earlier shots entirely', async () => {
    const calls: string[] = [];
    const doc = docWithShots(3);
    const result = await runScene(doc, fakeAdapter(calls), { startAt: 1 });
    expect(result).toBe('completed');
    expect(calls[0]).toBe('selectShot:1');
    expect(calls.some((c) => c.includes(':0'))).toBe(false);
  });

  it('aborting mid-hold resolves "cancelled" and calls no further shots', async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    const doc = docWithShots(2);
    const adapter = fakeAdapter(calls, {
      hold: (seconds, signal) =>
        new Promise<void>((resolve) => {
          calls.push(`hold:${seconds}`);
          // A real adapter observes the signal and resolves promptly on
          // abort rather than hanging or rejecting; this fake does the same.
          signal?.addEventListener('abort', () => resolve(), { once: true });
          queueMicrotask(() => controller.abort());
        }),
    });
    const result = await runScene(doc, adapter, { signal: controller.signal });
    expect(result).toBe('cancelled');
    expect(calls).toEqual(['selectShot:0', 'applyVisual', 'applyLayers', 'travel:4', 'settle', 'hold:2']);
    expect(calls).not.toContain('completeShot:0');
    expect(calls.some((c) => c.includes(':1'))).toBe(false);
  });

  it('an already-aborted signal cancels before the first shot starts', async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    controller.abort();
    const doc = docWithShots(2);
    const result = await runScene(doc, fakeAdapter(calls), { signal: controller.signal });
    expect(result).toBe('cancelled');
    expect(calls).toEqual([]);
  });

  it('treats an adapter that rejects travel/hold after abort as a clean cancellation', async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    const doc = docWithShots(1);
    const adapter = fakeAdapter(calls, {
      travel: (_camera, _durationSec, signal) =>
        new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
          queueMicrotask(() => controller.abort());
        }),
    });
    const result = await runScene(doc, adapter, { signal: controller.signal });
    expect(result).toBe('cancelled');
    expect(calls).not.toContain('hold:2');
  });

  it('propagates a failure that is unrelated to cancellation', async () => {
    const calls: string[] = [];
    const failure = new Error('adapter blew up');
    const doc = docWithShots(1);
    const adapter = fakeAdapter(calls, {
      applyVisual: () => {
        throw failure;
      },
    });
    await expect(runScene(doc, adapter)).rejects.toBe(failure);
  });
});

describe('seekShot', () => {
  it('returns the camera for the requested shot index', () => {
    const doc = docWithShots(3);
    expect(seekShot(doc, 1)).toEqual(doc.shots[1].camera);
  });

  it('clamps out-of-range indices to the nearest valid shot', () => {
    const doc = docWithShots(3);
    expect(seekShot(doc, -5)).toEqual(doc.shots[0].camera);
    expect(seekShot(doc, 99)).toEqual(doc.shots[2].camera);
  });

  it('throws for a document with no shots', () => {
    const doc = docWithShots(0);
    expect(() => seekShot(doc, 0)).toThrow();
  });
});

describe('newSceneDocument and captureShot', () => {
  it('creates an empty, valid document that captureShot can fill', () => {
    const doc = newSceneDocument('My tour');
    expect(doc.shots).toEqual([]);
    const shot = captureShot(CAMERA, { label: 'Opening', style: 'normal' });
    doc.shots.push(shot);
    const result = validateSceneDocument(doc);
    expect(result.ok).toBe(true);
  });

  it('gives each captured shot a stable, unique id', () => {
    const a = captureShot(CAMERA);
    const b = captureShot(CAMERA);
    expect(a.id).not.toBe(b.id);
    expect(typeof a.id).toBe('string');
    expect(a.id.length).toBeGreaterThan(0);
  });

  it('normalises heading on capture', () => {
    const shot = captureShot({ ...CAMERA, heading: 370 });
    expect(shot.camera.heading).toBe(10);
  });
});
