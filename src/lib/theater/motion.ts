// Adapted from God's Eye View (github.com/bilawalsidhu/gods-eye-view), MIT © 2026 Bilawal Sidhu.
/**
 * Dead-reckoning / interpolation model for feeds that arrive every 30 s –
 * 15 min (ADS-B/AIS style polling, not a smooth stream). Between the last two
 * known fixes it renders one fix behind (GEV's idea: interpolate the chord
 * rather than snap to the newest point), and past the newest fix it
 * dead-reckons forward along heading and speed, capped so a stale/dead feed
 * doesn't drift an entity indefinitely.
 *
 * Allocation-light on purpose: called for ~7,000 entities 4x/second.
 */
import { destinationPoint, normalizeHeading, shortestHeadingDelta } from './geo';

/** A single position report for one tracked entity. */
export interface Fix {
  lat: number;
  lng: number;
  /** Altitude, metres. */
  alt: number;
  /** True heading/track, degrees. */
  heading: number;
  speedMps: number;
  /** Fix epoch, milliseconds. */
  t: number;
}

/** The rendered position for one entity at a given instant. */
export interface PositionResult {
  lat: number;
  lng: number;
  alt: number;
  heading: number;
  speedMps: number;
  /** True once the entity has coasted past the coast cap with no new fix. */
  coasting: boolean;
}

/** Longest a track dead-reckons past its newest fix before holding position. */
export const MAX_COAST_MS = 120_000;

interface TrackState {
  prev: Fix | null;
  latest: Fix;
}

function holdAt(fix: Fix): PositionResult {
  return {
    lat: fix.lat,
    lng: fix.lng,
    alt: fix.alt,
    heading: normalizeHeading(fix.heading),
    speedMps: fix.speedMps,
    coasting: false,
  };
}

export interface TrackMotionOptions {
  /** Longest a track dead-reckons past its newest fix before holding position. */
  maxCoastMs?: number;
  /**
   * Render this far in the past. With a delay equal to the poll interval there are
   * always two fixes bracketing the render time, so every frame is an interpolation
   * and none is a guess — the right choice for objects whose feed is regular
   * (satellites). Aircraft feeds are irregular, so they leave this at 0 and dead-reckon.
   */
  renderDelayMs?: number;
}

/** Per-entity dead-reckoning / interpolation over a feed of sparse fixes. */
export class TrackMotion {
  private readonly tracks = new Map<string, TrackState>();
  private readonly maxCoastMs: number;
  private readonly renderDelayMs: number;

  constructor(options: number | TrackMotionOptions = MAX_COAST_MS) {
    const opts = typeof options === 'number' ? { maxCoastMs: options } : options;
    this.maxCoastMs = opts.maxCoastMs ?? MAX_COAST_MS;
    this.renderDelayMs = opts.renderDelayMs ?? 0;
  }

  /** Number of tracked entities. */
  get size(): number {
    return this.tracks.size;
  }

  /** Whether `id` has at least one recorded fix. */
  has(id: string): boolean {
    return this.tracks.has(id);
  }

  /**
   * Record a new fix for `id`. A fix at or before the current latest fix's
   * timestamp is ignored — out-of-order and duplicate fixes must never rewind
   * or freeze the interpolation window.
   */
  addFix(id: string, next: Fix): void {
    const state = this.tracks.get(id);
    if (!state) {
      this.tracks.set(id, { prev: null, latest: next });
      return;
    }
    if (next.t <= state.latest.t) return;
    state.prev = state.latest;
    state.latest = next;
  }

  /**
   * Rendered position for `id` at wall-clock `now` (same epoch as `Fix.t`).
   *  - Before the earliest known fix: holds at that fix (never extrapolates
   *    backwards).
   *  - Between the last two fixes: linear interpolation (render-one-behind).
   *  - At/after the latest fix: dead-reckons forward along its heading at its
   *    speed, capped at `maxCoastMs`; beyond the cap it holds position and
   *    reports `coasting: true`.
   * Returns null when `id` has no recorded fix.
   */
  positionAt(id: string, wallNow: number): PositionResult | null {
    const state = this.tracks.get(id);
    if (!state) return null;
    const { prev, latest } = state;
    const now = wallNow - this.renderDelayMs;

    if (prev && now <= prev.t) {
      return holdAt(prev);
    }

    if (prev && now <= latest.t) {
      const span = latest.t - prev.t;
      const t = span > 0 ? (now - prev.t) / span : 1;
      return {
        lat: prev.lat + (latest.lat - prev.lat) * t,
        lng: prev.lng + (latest.lng - prev.lng) * t,
        alt: prev.alt + (latest.alt - prev.alt) * t,
        heading: normalizeHeading(prev.heading + shortestHeadingDelta(prev.heading, latest.heading) * t),
        speedMps: prev.speedMps + (latest.speedMps - prev.speedMps) * t,
        coasting: false,
      };
    }

    if (!prev && now <= latest.t) {
      return holdAt(latest);
    }

    // now > latest.t: dead-reckon forward, capped at maxCoastMs.
    const elapsedMs = now - latest.t;
    const cappedMs = Math.min(elapsedMs, this.maxCoastMs);
    const dtSec = cappedMs / 1000;
    const heading = normalizeHeading(latest.heading);
    const { lat, lng } =
      dtSec > 0 && latest.speedMps > 0
        ? destinationPoint(latest.lat, latest.lng, heading, latest.speedMps * dtSec)
        : { lat: latest.lat, lng: latest.lng };
    return {
      lat,
      lng,
      alt: latest.alt,
      heading,
      speedMps: latest.speedMps,
      coasting: elapsedMs >= this.maxCoastMs,
    };
  }

  /** Drop entities whose latest fix is older than `maxAgeMs` relative to `now`. */
  prune(now: number, maxAgeMs: number): void {
    for (const [id, state] of this.tracks) {
      if (now - state.latest.t > maxAgeMs) this.tracks.delete(id);
    }
  }
}
