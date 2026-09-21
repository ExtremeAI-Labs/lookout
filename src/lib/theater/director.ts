// Adapted from God's Eye View (github.com/bilawalsidhu/gods-eye-view), MIT © 2026 Bilawal Sidhu.

// A renderer-independent "scene director": plays a fixed list of camera shots
// through phases an engine adapter implements (selectShot -> applyVisual ->
// applyLayers -> travel -> settle -> hold -> completeShot). This module never
// touches Cesium or any other renderer directly — the adapter passed to
// runScene is what moves the actual camera, so the same shot list can be
// replayed by a live Cesium viewer, a headless test double, or a future
// engine without this file changing.

/** A camera pose the theater viewer understands. */
export interface SceneShotCamera {
  lat: number;
  lng: number;
  /** camera height above the ellipsoid, metres */
  alt: number;
  /** degrees clockwise from north, normalised to 0..360 */
  heading: number;
  /** degrees; -90 looks straight down, 0 looks at the horizon */
  pitch: number;
}

/** One beat of a scene: fly to `camera`, hold, then move on. */
export interface SceneShot {
  id: string;
  label?: string;
  camera: SceneShotCamera;
  /** seconds spent travelling to `camera` */
  durationSec: number;
  /** seconds spent holding once `camera` is reached */
  holdSec: number;
  /** sensor/visual style name the adapter applies for this shot */
  style?: string;
  /** flat layer-id -> on/off map the adapter applies for this shot */
  layers?: Record<string, boolean>;
}

/** A saved, authored shot list. */
export interface SceneDocument {
  version: 1;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  shots: SceneShot[];
}

export type SceneValidationResult =
  | { ok: true; doc: SceneDocument }
  | { ok: false; errors: string[] };

const MAX_SHOTS = 200;
const MAX_TITLE_LEN = 120;
const MAX_LABEL_LEN = 80;
const MAX_LAYER_KEYS = 64;
const MIN_ALT = 50;
const MAX_ALT = 40_000_000;
const MIN_DURATION_SEC = 0;
const MAX_DURATION_SEC = 600;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeHeading(deg: number): number {
  const wrapped = deg % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

function validateCamera(raw: unknown, path: string): { camera?: SceneShotCamera; errors: string[] } {
  if (!isRecord(raw)) return { errors: [`${path}: expected an object`] };
  const errors: string[] = [];

  const lat = finiteNumber(raw.lat);
  if (lat === undefined || lat < -90 || lat > 90) errors.push(`${path}.lat: expected a number from -90 to 90`);

  const lng = finiteNumber(raw.lng);
  if (lng === undefined || lng < -180 || lng > 180) errors.push(`${path}.lng: expected a number from -180 to 180`);

  const alt = finiteNumber(raw.alt);
  if (alt === undefined || alt < MIN_ALT || alt > MAX_ALT)
    errors.push(`${path}.alt: expected a number from ${MIN_ALT} to ${MAX_ALT}`);

  const pitch = finiteNumber(raw.pitch);
  if (pitch === undefined || pitch < -90 || pitch > 0) errors.push(`${path}.pitch: expected a number from -90 to 0`);

  // Heading is bounded by wrapping rather than rejecting: any finite compass
  // value has a normalised 0..360 equivalent, so there is no reason to fail
  // authoring over a shot saved as -10 or 400 degrees.
  const headingRaw = finiteNumber(raw.heading);
  if (headingRaw === undefined) errors.push(`${path}.heading: expected a number`);

  if (errors.length > 0 || lat === undefined || lng === undefined || alt === undefined || pitch === undefined || headingRaw === undefined)
    return { errors };

  return { camera: { lat, lng, alt, heading: normalizeHeading(headingRaw), pitch }, errors: [] };
}

function validateShot(raw: unknown, index: number): { shot?: SceneShot; errors: string[] } {
  const path = `shots[${index}]`;
  if (!isRecord(raw)) return { errors: [`${path}: expected an object`] };
  const errors: string[] = [];

  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id : undefined;
  if (!id) errors.push(`${path}.id: expected a nonempty string`);

  let label: string | undefined;
  if (raw.label !== undefined) {
    if (typeof raw.label !== 'string' || raw.label.length > MAX_LABEL_LEN)
      errors.push(`${path}.label: expected a string of at most ${MAX_LABEL_LEN} characters`);
    else label = raw.label;
  }

  const { camera, errors: cameraErrors } = validateCamera(raw.camera, `${path}.camera`);
  errors.push(...cameraErrors);

  const durationSec = finiteNumber(raw.durationSec);
  if (durationSec === undefined || durationSec < MIN_DURATION_SEC || durationSec > MAX_DURATION_SEC)
    errors.push(`${path}.durationSec: expected a number from ${MIN_DURATION_SEC} to ${MAX_DURATION_SEC}`);

  const holdSec = finiteNumber(raw.holdSec);
  if (holdSec === undefined || holdSec < MIN_DURATION_SEC || holdSec > MAX_DURATION_SEC)
    errors.push(`${path}.holdSec: expected a number from ${MIN_DURATION_SEC} to ${MAX_DURATION_SEC}`);

  let style: string | undefined;
  if (raw.style !== undefined) {
    if (typeof raw.style !== 'string') errors.push(`${path}.style: expected a string`);
    else style = raw.style;
  }

  let layers: Record<string, boolean> | undefined;
  if (raw.layers !== undefined) {
    if (!isRecord(raw.layers)) {
      errors.push(`${path}.layers: expected an object`);
    } else {
      const entries = Object.entries(raw.layers);
      if (entries.length > MAX_LAYER_KEYS) errors.push(`${path}.layers: expected at most ${MAX_LAYER_KEYS} keys`);
      else if (entries.some(([, value]) => typeof value !== 'boolean'))
        errors.push(`${path}.layers: expected a flat boolean map`);
      else layers = Object.fromEntries(entries) as Record<string, boolean>;
    }
  }

  if (errors.length > 0 || !id || !camera || durationSec === undefined || holdSec === undefined) return { errors };

  const shot: SceneShot = { id, camera, durationSec, holdSec };
  if (label !== undefined) shot.label = label;
  if (style !== undefined) shot.style = style;
  if (layers !== undefined) shot.layers = layers;
  return { shot, errors: [] };
}

/**
 * Bounded, defensive validation of an untrusted scene document (e.g. loaded
 * from a file or pasted JSON). Never throws: malformed input always comes
 * back as `{ ok: false, errors }`. Unknown top-level and per-shot fields are
 * silently dropped rather than rejected; heading is normalised rather than
 * rejected; everything else out of range fails validation.
 */
export function validateSceneDocument(input: unknown): SceneValidationResult {
  try {
    if (!isRecord(input)) return { ok: false, errors: ['expected an object'] };
    const errors: string[] = [];

    if (input.version !== 1) errors.push('version: must be 1');

    const id = typeof input.id === 'string' && input.id.trim() ? input.id : undefined;
    if (!id) errors.push('id: expected a nonempty string');

    const title = typeof input.title === 'string' ? input.title : undefined;
    if (title === undefined) errors.push('title: expected a string');
    else if (title.length > MAX_TITLE_LEN) errors.push(`title: expected at most ${MAX_TITLE_LEN} characters`);

    const createdAt = typeof input.createdAt === 'string' && input.createdAt ? input.createdAt : undefined;
    if (!createdAt) errors.push('createdAt: expected a nonempty string');

    const updatedAt = typeof input.updatedAt === 'string' && input.updatedAt ? input.updatedAt : undefined;
    if (!updatedAt) errors.push('updatedAt: expected a nonempty string');

    const rawShots = input.shots;
    const shots: SceneShot[] = [];
    if (!Array.isArray(rawShots)) {
      errors.push('shots: expected an array');
    } else {
      if (rawShots.length > MAX_SHOTS) errors.push(`shots: expected at most ${MAX_SHOTS} shots`);
      rawShots.slice(0, MAX_SHOTS).forEach((raw, index) => {
        const { shot, errors: shotErrors } = validateShot(raw, index);
        errors.push(...shotErrors);
        if (shot) shots.push(shot);
      });
    }

    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, doc: { version: 1, id: id!, title: title!, createdAt: createdAt!, updatedAt: updatedAt!, shots } };
  } catch {
    // Defensive: validation must never throw, even on inputs that trip an
    // assumption above (e.g. a getter that throws on property access).
    return { ok: false, errors: ['unexpected error validating scene document'] };
  }
}

/** The engine-facing side of playback. Nothing here imports a renderer; an
 *  adapter is how a Cesium viewer (or a test double) actually moves. */
export interface SceneAdapter {
  selectShot(shot: SceneShot, index: number): void | Promise<void>;
  applyVisual(style: string | undefined): void | Promise<void>;
  applyLayers(layers: Record<string, boolean> | undefined): void | Promise<void>;
  travel(camera: SceneShotCamera, durationSec: number, signal: AbortSignal | undefined): Promise<void>;
  settle?(): void | Promise<void>;
  hold(seconds: number, signal: AbortSignal | undefined): Promise<void>;
  completeShot(shot: SceneShot, index: number): void;
}

export interface RunSceneOptions {
  /** aborting stops playback promptly; travel/hold receive the same signal */
  signal?: AbortSignal;
  /** shot index to start from (default 0); earlier shots are never visited */
  startAt?: number;
  /** playback-rate multiplier; 2 halves travel/hold durations (default 1) */
  speed?: number;
}

export type RunSceneResult = 'completed' | 'cancelled';

/** Runs one phase, treating a rejection as ordinary cancellation once the
 *  signal has fired (an adapter may reject its in-flight travel/hold instead
 *  of resolving when aborted) and re-throwing anything else unchanged. */
async function runPhase(work: () => void | Promise<void>, cancelled: () => boolean): Promise<void> {
  try {
    await work();
  } catch (error) {
    if (cancelled()) return;
    throw error;
  }
}

/**
 * Plays `doc.shots` in order through `adapter`, running every phase
 * (selectShot -> applyVisual -> applyLayers -> travel -> settle -> hold ->
 * completeShot) for each shot before moving to the next. Cancellation is
 * cooperative: the same `signal` is handed to the adapter's travel/hold, and
 * the runner rechecks it after every phase so it never starts a phase, or
 * advances to the next shot, once aborted.
 */
export async function runScene(doc: SceneDocument, adapter: SceneAdapter, options: RunSceneOptions = {}): Promise<RunSceneResult> {
  const { signal } = options;
  const cancelled = () => Boolean(signal?.aborted);
  const speed = typeof options.speed === 'number' && Number.isFinite(options.speed) && options.speed > 0 ? options.speed : 1;
  const start = Math.min(Math.max(0, Math.trunc(options.startAt ?? 0)), doc.shots.length);

  for (let index = start; index < doc.shots.length; index++) {
    if (cancelled()) return 'cancelled';
    const shot = doc.shots[index];

    await runPhase(() => adapter.selectShot(shot, index), cancelled);
    if (cancelled()) return 'cancelled';

    await runPhase(() => adapter.applyVisual(shot.style), cancelled);
    if (cancelled()) return 'cancelled';

    await runPhase(() => adapter.applyLayers(shot.layers), cancelled);
    if (cancelled()) return 'cancelled';

    await runPhase(() => adapter.travel(shot.camera, shot.durationSec / speed, signal), cancelled);
    if (cancelled()) return 'cancelled';

    if (adapter.settle) {
      await runPhase(() => adapter.settle!(), cancelled);
      if (cancelled()) return 'cancelled';
    }

    await runPhase(() => adapter.hold(shot.holdSec / speed, signal), cancelled);
    if (cancelled()) return 'cancelled';

    adapter.completeShot(shot, index);
  }

  return 'completed';
}

/** The camera to jump to for an instant (non-travelling) seek to shot `index`. */
export function seekShot(doc: SceneDocument, index: number): SceneShotCamera {
  if (!doc.shots.length) throw new Error('seekShot: scene document has no shots');
  const clamped = Math.min(Math.max(0, Math.trunc(index)), doc.shots.length - 1);
  return doc.shots[clamped].camera;
}

function generateId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ? `${prefix}-${uuid}` : `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** A fresh, empty shot list ready to have shots captured into it. */
export function newSceneDocument(title: string): SceneDocument {
  const now = new Date().toISOString();
  return { version: 1, id: generateId('scene'), title, createdAt: now, updatedAt: now, shots: [] };
}

const DEFAULT_SHOT_DURATION_SEC = 4;
const DEFAULT_SHOT_HOLD_SEC = 1;

export interface CaptureShotOptions {
  id?: string;
  label?: string;
  durationSec?: number;
  holdSec?: number;
  style?: string;
  layers?: Record<string, boolean>;
}

/** Builds a well-formed shot from the theater's current camera, e.g. for an
 *  "add shot here" authoring action. Heading is normalised like validation. */
export function captureShot(camera: SceneShotCamera, opts: CaptureShotOptions = {}): SceneShot {
  const shot: SceneShot = {
    id: opts.id ?? generateId('shot'),
    camera: { ...camera, heading: normalizeHeading(camera.heading) },
    durationSec: opts.durationSec ?? DEFAULT_SHOT_DURATION_SEC,
    holdSec: opts.holdSec ?? DEFAULT_SHOT_HOLD_SEC,
  };
  if (opts.label !== undefined) shot.label = opts.label;
  if (opts.style !== undefined) shot.style = opts.style;
  if (opts.layers !== undefined) shot.layers = opts.layers;
  return shot;
}
