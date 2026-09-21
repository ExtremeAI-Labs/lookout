import { describe, it, expect } from 'vitest';
import {
  slewHeading,
  cockpitAnchorCorrectionStep,
  cockpitAnchorStep,
  cockpitGroundSafeHeight,
  chasePose,
  COCKPIT_FORWARD_OFFSET_M,
  COCKPIT_UP_OFFSET_M,
  COCKPIT_PITCH_DEG,
  HEADING_SLEW_DEG_PER_S,
  MIN_GROUND_CLEARANCE_M,
  COCKPIT_PRESET,
  CHASE_PRESET,
} from './cockpit-math';
import { bearingBetween, distanceMetres, normalizeHeading } from './geo';

describe('presentation constants', () => {
  it('match the source cockpit defaults', () => {
    expect(COCKPIT_FORWARD_OFFSET_M).toBe(7);
    expect(COCKPIT_UP_OFFSET_M).toBe(2.6);
    expect(COCKPIT_PITCH_DEG).toBe(-4);
    expect(HEADING_SLEW_DEG_PER_S).toBe(28);
    expect(MIN_GROUND_CLEARANCE_M).toBe(12);
    expect(CHASE_PRESET).toEqual({ forwardOffsetM: -120, upOffsetM: 45, pitchDeg: -12 });
  });
});

describe('slewHeading', () => {
  it('takes the short way round across north instead of the long way through 180', () => {
    const next = slewHeading(350, 10, HEADING_SLEW_DEG_PER_S, 0.1);
    // Moving the short way from 350 toward 10 climbs through 360/0; it must
    // never dip toward 180.
    expect(next).toBeGreaterThan(350);
    expect(next).toBeLessThanOrEqual(360);
  });

  it('never overshoots the target when the step would exceed the remaining delta', () => {
    const reached = slewHeading(350, 10, HEADING_SLEW_DEG_PER_S, 10);
    expect(reached).toBeCloseTo(10, 6);
  });

  it('seeds directly on target when there is nothing to slew from yet', () => {
    expect(slewHeading(null, 123, HEADING_SLEW_DEG_PER_S, 1)).toBeCloseTo(123, 6);
    expect(slewHeading(undefined, 123, HEADING_SLEW_DEG_PER_S, 1)).toBeCloseTo(123, 6);
  });

  it('steps by exactly maxDegPerSec * dt when the delta is larger', () => {
    expect(slewHeading(0, 90, 28, 1)).toBeCloseTo(28, 6);
  });
});

describe('cockpitAnchorCorrectionStep', () => {
  it('cannot turn a forward step into a reversal', () => {
    const speedMps = 200;
    const dtSec = 0.1;
    const forwardStepM = speedMps * dtSec;
    const correction = cockpitAnchorCorrectionStep(1000, speedMps, dtSec);
    expect(correction).toBeGreaterThan(0);
    expect(correction).toBeLessThan(forwardStepM);
  });

  it('bounds late-fix catch-up and render stalls', () => {
    expect(cockpitAnchorCorrectionStep(5000, 250, 2)).toBeLessThanOrEqual(5.5);
    expect(cockpitAnchorCorrectionStep(0, 250, 0.1)).toBe(0);
    expect(cockpitAnchorCorrectionStep(Number.NaN, 250, 0.1)).toBe(0);
  });
});

describe('cockpitAnchorStep', () => {
  it('advances toward the delayed target without overshooting or reversing', () => {
    const anchor = { lat: 0, lng: 0 };
    const delayedTarget = { lat: 0.01, lng: 0 }; // ~1.1 km north
    const next = cockpitAnchorStep({
      anchor,
      delayedTarget,
      headingDeg: 0,
      speedMps: 200,
      dtSec: 0.1,
    });
    // Moves north — toward both the heading and the delayed target.
    expect(next.lat).toBeGreaterThan(anchor.lat);
    // Never leaps past the delayed target in a single bounded step.
    expect(next.lat).toBeLessThan(delayedTarget.lat);
  });
});

describe('cockpitGroundSafeHeight', () => {
  it('never drops the camera below ground + clearance', () => {
    expect(cockpitGroundSafeHeight(47, 57, 12)).toBe(69);
  });

  it('leaves a comfortably-clear proposed height untouched', () => {
    expect(cockpitGroundSafeHeight(1200, 57, 12)).toBe(1200);
  });

  it('preserves the proposed height when the ground floor is unknown', () => {
    expect(cockpitGroundSafeHeight(47, Number.NaN, 12)).toBe(47);
  });

  it('treats a negative clearance as zero', () => {
    expect(cockpitGroundSafeHeight(47, 57, -4)).toBe(57);
  });
});

describe('chasePose', () => {
  const aircraft = { lat: 40, lng: -100, alt: 3000, heading: 90 };

  it('sits behind and above along the heading for a third-person follow', () => {
    const pose = chasePose(aircraft, CHASE_PRESET);
    expect(pose.alt).toBeCloseTo(aircraft.alt + CHASE_PRESET.upOffsetM, 6);
    expect(pose.heading).toBeCloseTo(normalizeHeading(aircraft.heading), 6);
    expect(pose.pitch).toBe(CHASE_PRESET.pitchDeg);
    // "Behind" means opposite the heading (heading 90/east -> bearing 270/west).
    const brg = bearingBetween(aircraft.lat, aircraft.lng, pose.lat, pose.lng);
    expect(brg).toBeCloseTo(270, 3);
    const dist = distanceMetres(aircraft.lat, aircraft.lng, pose.lat, pose.lng);
    expect(dist).toBeCloseTo(Math.abs(CHASE_PRESET.forwardOffsetM), 3);
  });

  it('sits ahead and slightly above for the first-person cockpit preset', () => {
    const pose = chasePose(aircraft, COCKPIT_PRESET);
    expect(pose.alt).toBeCloseTo(aircraft.alt + COCKPIT_UP_OFFSET_M, 6);
    const brg = bearingBetween(aircraft.lat, aircraft.lng, pose.lat, pose.lng);
    expect(brg).toBeCloseTo(normalizeHeading(aircraft.heading), 3);
    const dist = distanceMetres(aircraft.lat, aircraft.lng, pose.lat, pose.lng);
    expect(dist).toBeCloseTo(COCKPIT_FORWARD_OFFSET_M, 3);
  });
});
