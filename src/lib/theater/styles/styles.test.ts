import { describe, expect, it } from 'vitest';
import type * as CesiumNS from 'cesium';
import { animeStyle } from './anime';
import { createStyleManager, normalStyle, SENSOR_STYLES } from './index';
import { noirStyle } from './noir';
import { retroStyle } from './retro';
import { snowStyle } from './snow';
import { surveillanceStyle } from './surveillance';
import { thermalStyle } from './thermal';
import type { SensorStyle } from './types';

const SHADER_STYLES: SensorStyle[] = [retroStyle, surveillanceStyle, thermalStyle, noirStyle, snowStyle, animeStyle];

describe('shader styles', () => {
  it.each(SHADER_STYLES)('$name: fragmentShader is a non-empty GLSL ES 3.00 string', (style) => {
    expect(typeof style.fragmentShader).toBe('string');
    expect(style.fragmentShader.trim().length).toBeGreaterThan(0);
  });

  it.each(SHADER_STYLES)('$name: references the required Cesium PostProcessStage bindings', (style) => {
    expect(style.fragmentShader).toContain('colorTexture');
    expect(style.fragmentShader).toContain('v_textureCoordinates');
    expect(style.fragmentShader).toContain('out_FragColor');
    expect(style.fragmentShader).toMatch(/uniform\s+float\s+intensity\s*;/);
  });

  it.each(SHADER_STYLES)('$name: contains no czm_ builtins', (style) => {
    expect(style.fragmentShader).not.toMatch(/czm_/);
  });

  it.each(SHADER_STYLES)('$name: does not sample a depth texture', (style) => {
    expect(style.fragmentShader).not.toMatch(/depthTexture/);
  });

  it.each(SHADER_STYLES)('$name: every uniform default lies within [min, max]', (style) => {
    for (const [uniformName, meta] of Object.entries(style.uniforms)) {
      expect(meta.min, `${style.name}.${uniformName}.min`).toBeLessThanOrEqual(meta.max);
      expect(meta.default, `${style.name}.${uniformName}.default`).toBeGreaterThanOrEqual(meta.min);
      expect(meta.default, `${style.name}.${uniformName}.default`).toBeLessThanOrEqual(meta.max);
    }
  });
});

describe('SENSOR_STYLES registry', () => {
  it('starts with the shaderless "normal" pseudo-style', () => {
    expect(SENSOR_STYLES[0]).toBe(normalStyle);
    expect(normalStyle.fragmentShader).toBe('');
  });

  it('orders retro -> CRT, surveillance -> NVG, thermal -> FLIR, then noir, snow, anime', () => {
    expect(SENSOR_STYLES.map((s) => s.name)).toEqual(['normal', 'retro', 'surveillance', 'thermal', 'noir', 'snow', 'anime']);
    expect(SENSOR_STYLES.map((s) => s.label)).toEqual(['NORMAL', 'CRT', 'NVG', 'FLIR', 'NOIR', 'SNOW', 'ANIME']);
  });

  it('has unique names and unique 1-7 keyboard keys', () => {
    const names = SENSOR_STYLES.map((s) => s.name);
    const keys = SENSOR_STYLES.map((s) => s.key);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.sort()).toEqual(['1', '2', '3', '4', '5', '6', '7']);
  });
});

// ── createStyleManager: crossfade math against a fake Cesium/viewer ───────────

class FakePostProcessStage {
  name: string;
  fragmentShader: string;
  uniforms: Record<string, number>;
  enabled = false;
  constructor(options: { name: string; fragmentShader: string; uniforms: Record<string, number> }) {
    this.name = options.name;
    this.fragmentShader = options.fragmentShader;
    this.uniforms = options.uniforms;
  }
}

function makeFakeViewer() {
  const added: FakePostProcessStage[] = [];
  const removed: FakePostProcessStage[] = [];
  const postProcessStages = {
    add: (stage: FakePostProcessStage) => {
      added.push(stage);
      return stage;
    },
    remove: (stage: FakePostProcessStage) => {
      removed.push(stage);
      return true;
    },
  };
  const viewer = { scene: { postProcessStages } };
  return { viewer, added, removed };
}

/** A fake requestAnimationFrame that only runs when the test steps it, for determinism. */
function makeFakeClock() {
  let time = 0;
  let pending: FrameRequestCallback | null = null;
  let requestCalls = 0;
  let cancelCalls = 0;
  return {
    now: () => time,
    requestFrame: (cb: FrameRequestCallback) => {
      requestCalls++;
      pending = cb;
      return requestCalls;
    },
    cancelFrame: () => {
      cancelCalls++;
      pending = null;
    },
    /** Advances the fake clock to `t` and, if a frame is pending, runs it. */
    tick(t: number) {
      time = t;
      const cb = pending;
      pending = null;
      cb?.(t);
    },
    hasPendingFrame: () => pending !== null,
    get requestCallCount() {
      return requestCalls;
    },
    get cancelCallCount() {
      return cancelCalls;
    },
  };
}

function findStage(added: FakePostProcessStage[], styleName: string): FakePostProcessStage {
  const stage = added.find((s) => s.name === `lookout_sensor_${styleName}`);
  if (!stage) throw new Error(`no stage added for ${styleName}`);
  return stage;
}

describe('createStyleManager', () => {
  it('adds one stage per shader style at intensity 0, disabled, skipping "normal"', () => {
    const { viewer, added } = makeFakeViewer();
    const clock = makeFakeClock();
    const FakeCesium = { PostProcessStage: FakePostProcessStage } as unknown as typeof CesiumNS;
    createStyleManager(FakeCesium, viewer as unknown as CesiumNS.Viewer, clock);

    expect(added.map((s) => s.name).sort()).toEqual(
      SHADER_STYLES.map((s) => `lookout_sensor_${s.name}`).sort(),
    );
    for (const stage of added) {
      expect(stage.uniforms.intensity).toBe(0);
      expect(stage.enabled).toBe(false);
    }
    // Only the four shaders with a `time` uniform get one seeded.
    expect(findStage(added, 'retro').uniforms.time).toBe(0);
    expect(findStage(added, 'surveillance').uniforms.time).toBe(0);
    expect(findStage(added, 'thermal').uniforms.time).toBe(0);
    expect(findStage(added, 'snow').uniforms.time).toBe(0);
    expect(findStage(added, 'noir').uniforms.time).toBeUndefined();
    expect(findStage(added, 'anime').uniforms.time).toBeUndefined();
  });

  it('crossfades intensity over 500ms with ease-in-out timing, keeping enabled in lockstep', () => {
    const { viewer, added } = makeFakeViewer();
    const clock = makeFakeClock();
    const FakeCesium = { PostProcessStage: FakePostProcessStage } as unknown as typeof CesiumNS;
    const manager = createStyleManager(FakeCesium, viewer as unknown as CesiumNS.Viewer, clock);
    const retro = findStage(added, 'retro');

    manager.setStyle('retro');
    expect(clock.hasPendingFrame()).toBe(true);

    // t=0: first frame runs immediately at the transition's own start time.
    clock.tick(0);
    expect(retro.uniforms.intensity).toBe(0);
    expect(retro.enabled).toBe(false);

    // t=250: halfway through the 500ms fade — the eased curve is symmetric at the midpoint.
    clock.tick(250);
    expect(retro.uniforms.intensity).toBeCloseTo(0.5, 6);
    expect(retro.enabled).toBe(true);

    // t=500: fade complete, snapped exactly to the target.
    clock.tick(500);
    expect(retro.uniforms.intensity).toBe(1);
    expect(retro.enabled).toBe(true);
    // The retro stage still animates `time` while enabled, so the loop keeps itself alive.
    expect(clock.hasPendingFrame()).toBe(true);
  });

  it('crossfades the outgoing and incoming style together on setStyle', () => {
    const { viewer, added } = makeFakeViewer();
    const clock = makeFakeClock();
    const FakeCesium = { PostProcessStage: FakePostProcessStage } as unknown as typeof CesiumNS;
    const manager = createStyleManager(FakeCesium, viewer as unknown as CesiumNS.Viewer, clock);
    const retro = findStage(added, 'retro');
    const thermal = findStage(added, 'thermal');

    manager.setStyle('retro');
    clock.tick(0);
    clock.tick(500);
    expect(retro.uniforms.intensity).toBe(1);

    manager.setStyle('thermal');
    clock.tick(500); // transition start
    clock.tick(750); // halfway through the new 500ms fade
    expect(retro.uniforms.intensity).toBeCloseTo(0.5, 6);
    expect(thermal.uniforms.intensity).toBeCloseTo(0.5, 6);

    clock.tick(1000);
    expect(retro.uniforms.intensity).toBe(0);
    expect(retro.enabled).toBe(false);
    expect(thermal.uniforms.intensity).toBe(1);
    expect(thermal.enabled).toBe(true);
  });

  it('setUniform writes straight through to the stage', () => {
    const { viewer, added } = makeFakeViewer();
    const clock = makeFakeClock();
    const FakeCesium = { PostProcessStage: FakePostProcessStage } as unknown as typeof CesiumNS;
    const manager = createStyleManager(FakeCesium, viewer as unknown as CesiumNS.Viewer, clock);
    const thermal = findStage(added, 'thermal');

    manager.setUniform('thermal', 'palette', 1);
    expect(thermal.uniforms.palette).toBe(1);

    // An unknown style name is a no-op, never a throw.
    expect(() => manager.setUniform('does-not-exist', 'x', 1)).not.toThrow();
  });

  it('dispose removes every owned stage and cancels the animation loop', () => {
    const { viewer, added, removed } = makeFakeViewer();
    const clock = makeFakeClock();
    const FakeCesium = { PostProcessStage: FakePostProcessStage } as unknown as typeof CesiumNS;
    const manager = createStyleManager(FakeCesium, viewer as unknown as CesiumNS.Viewer, clock);

    manager.setStyle('retro');
    clock.tick(0);
    expect(clock.hasPendingFrame()).toBe(true);

    manager.dispose();
    expect(clock.cancelCallCount).toBe(1);
    expect(removed.map((s) => s.name).sort()).toEqual(added.map((s) => s.name).sort());

    // Disposed managers ignore further calls instead of throwing.
    const callsBefore = clock.requestCallCount;
    expect(() => manager.setStyle('thermal')).not.toThrow();
    expect(clock.requestCallCount).toBe(callsBefore);
  });
});
