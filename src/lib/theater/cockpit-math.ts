// Adapted from God's Eye View (github.com/bilawalsidhu/gods-eye-view), MIT © 2026 Bilawal Sidhu.
/**
 * Pure cockpit-camera math: heading slew, the inertial anchor + bounded
 * correction toward a delayed feed position, ground-safe height, and the
 * camera pose for a followed aircraft. No Cesium types or imports — plain
 * {lat,lng,alt(m),heading(deg),speedMps} objects throughout.
 */
import {
  bearingBetween,
  destinationPoint,
  distanceMetres,
  normalizeHeading,
  shortestHeadingDelta,
  type LatLng,
} from './geo';

/** Cockpit camera offset forward of the aircraft nose, metres. */
export const COCKPIT_FORWARD_OFFSET_M = 7;
/** Cockpit camera offset above the aircraft, metres. */
export const COCKPIT_UP_OFFSET_M = 2.6;
/** Fixed cockpit camera pitch, degrees (negative looks down). */
export const COCKPIT_PITCH_DEG = -4;
/** Maximum heading-indicator slew rate, degrees per second. */
export const HEADING_SLEW_DEG_PER_S = 28;
/** Minimum camera clearance above the rendered ground floor, metres. */
export const MIN_GROUND_CLEARANCE_M = 12;

export interface ChaseOffset {
  /** Metres ahead of the aircraft along its heading; negative sits behind it. */
  forwardOffsetM: number;
  /** Metres above the aircraft. */
  upOffsetM: number;
  /** Fixed camera pitch, degrees. */
  pitchDeg: number;
}

/** First-person cockpit offset, built from the constants above. */
export const COCKPIT_PRESET: ChaseOffset = {
  forwardOffsetM: COCKPIT_FORWARD_OFFSET_M,
  upOffsetM: COCKPIT_UP_OFFSET_M,
  pitchDeg: COCKPIT_PITCH_DEG,
};

/** Third-person chase-camera offset: behind, above, and pitched down. */
export const CHASE_PRESET: ChaseOffset = { forwardOffsetM: -120, upOffsetM: 45, pitchDeg: -12 };

export interface AircraftState {
  lat: number;
  lng: number;
  /** Altitude, metres. */
  alt: number;
  /** True heading, degrees. */
  heading: number;
  speedMps?: number;
}

export interface CameraPose {
  lat: number;
  lng: number;
  alt: number;
  heading: number;
  pitch: number;
}

/**
 * Advance a displayed heading along the shortest arc without exceeding
 * `maxDegPerSec * dt`. A null/non-finite `current` seeds directly on the
 * target — there is nothing to slew from yet.
 */
export function slewHeading(
  current: number | null | undefined,
  target: number,
  maxDegPerSec: number,
  dt: number,
): number {
  const to = normalizeHeading(target);
  if (current == null || !Number.isFinite(current)) return to;
  const from = normalizeHeading(current);
  const maxStep = Math.max(
    0,
    (Number.isFinite(maxDegPerSec) ? maxDegPerSec : 0) * Math.max(0, Number.isFinite(dt) ? dt : 0),
  );
  const delta = shortestHeadingDelta(from, to);
  const step = Math.abs(delta) <= maxStep ? delta : Math.sign(delta) * maxStep;
  return normalizeHeading(from + step);
}

/**
 * Bounded cockpit-anchor correction magnitude for one render step, metres.
 *
 * The cockpit advances inertially from the aircraft's reported course/speed,
 * then uses this amount to converge on the delayed feed position. Capping
 * correction below forward speed keeps a late fix from reading as a
 * first-person surge or reversal while still removing drift.
 */
export function cockpitAnchorCorrectionStep(distanceM: number, speedMps: number, dtSec: number): number {
  if (!Number.isFinite(distanceM) || distanceM <= 0 || !Number.isFinite(dtSec) || dtSec <= 0) return 0;
  const dt = Math.min(0.1, dtSec);
  const speed = Number.isFinite(speedMps) ? Math.max(0, speedMps) : 0;
  const eased = distanceM * (1 - Math.exp(-1.25 * dt));
  const correctionRateMps = Math.max(0.75, speed * 0.22);
  return Math.min(distanceM, eased, correctionRateMps * dt);
}

/** Advance a position inertially along heading at speed for dtSec (dead reckoning). */
export function cockpitInertialAdvance(
  position: LatLng,
  headingDeg: number,
  speedMps: number,
  dtSec: number,
): LatLng {
  if (!Number.isFinite(speedMps) || speedMps <= 0 || !Number.isFinite(dtSec) || dtSec <= 0) {
    return { lat: position.lat, lng: position.lng };
  }
  return destinationPoint(position.lat, position.lng, normalizeHeading(headingDeg), speedMps * dtSec);
}

/** Move `anchor` one bounded step toward `target` (see cockpitAnchorCorrectionStep). */
export function cockpitAnchorCorrectionTowards(
  anchor: LatLng,
  target: LatLng,
  speedMps: number,
  dtSec: number,
): LatLng {
  const distanceM = distanceMetres(anchor.lat, anchor.lng, target.lat, target.lng);
  const step = cockpitAnchorCorrectionStep(distanceM, speedMps, dtSec);
  if (step <= 0) return { lat: anchor.lat, lng: anchor.lng };
  const brg = bearingBetween(anchor.lat, anchor.lng, target.lat, target.lng);
  return destinationPoint(anchor.lat, anchor.lng, brg, step);
}

export interface CockpitAnchorStepInput {
  anchor: LatLng;
  delayedTarget: LatLng;
  headingDeg: number;
  speedMps: number;
  dtSec: number;
}

/**
 * One cockpit-anchor render step: advance inertially from heading/speed, then
 * apply a bounded correction toward the delayed feed position — the pairing
 * `cockpitAnchorCorrectionStep` exists to make safe.
 */
export function cockpitAnchorStep({
  anchor,
  delayedTarget,
  headingDeg,
  speedMps,
  dtSec,
}: CockpitAnchorStepInput): LatLng {
  const advanced = cockpitInertialAdvance(anchor, headingDeg, speedMps, dtSec);
  return cockpitAnchorCorrectionTowards(advanced, delayedTarget, speedMps, dtSec);
}

/**
 * Keep the cockpit camera above the shared rendered-surface floor. Unknown
 * floors preserve the proposed camera height.
 */
export function cockpitGroundSafeHeight(proposedHeightM: number, groundHeightM: number, clearanceM: number): number {
  if (!Number.isFinite(proposedHeightM)) return proposedHeightM;
  if (!Number.isFinite(groundHeightM)) return proposedHeightM;
  const clearance = Number.isFinite(clearanceM) ? Math.max(0, clearanceM) : 0;
  return Math.max(proposedHeightM, groundHeightM + clearance);
}

/**
 * Camera pose for a followed aircraft: `offset.forwardOffsetM` along its
 * heading (negative sits behind it, e.g. a third-person chase view), raised
 * `offset.upOffsetM`, pitched at a fixed `offset.pitchDeg`. The camera
 * heading matches the aircraft's so it keeps looking the way it's traveling.
 */
export function chasePose(aircraft: AircraftState, offset: ChaseOffset): CameraPose {
  const heading = normalizeHeading(aircraft.heading);
  const { lat, lng } = destinationPoint(aircraft.lat, aircraft.lng, heading, offset.forwardOffsetM);
  return {
    lat,
    lng,
    alt: aircraft.alt + offset.upOffsetM,
    heading,
    pitch: offset.pitchDeg,
  };
}
