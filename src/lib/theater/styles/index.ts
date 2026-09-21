// Adapted from God's Eye View (github.com/bilawalsidhu/gods-eye-view), MIT © 2026 Bilawal Sidhu.
// TypeScript port of gods-eye-view's src/ui/visualEffects.js (stage lifecycle + crossfade) and
// src/ui/visualPresets.js (the style registry + transition duration).
//
// Cesium is loaded by the app as a prebuilt bundle via a <script> tag (see
// src/components/theater/CesiumTheater.tsx) — it is never a runtime import here, only a type one.
// The live `Cesium` namespace is handed in by the caller instead.
import type * as CesiumNS from 'cesium';
import type { SensorStyle } from './types';
import { retroStyle } from './retro';
import { surveillanceStyle } from './surveillance';
import { thermalStyle } from './thermal';
import { noirStyle } from './noir';
import { snowStyle } from './snow';
import { animeStyle } from './anime';

export type { SensorStyle, SensorStyleUniform } from './types';
export { retroStyle, surveillanceStyle, thermalStyle, noirStyle, snowStyle, animeStyle };

/** The unfiltered view. No PostProcessStage is created for it — it just means "every style off". */
export const normalStyle: SensorStyle = {
  name: 'normal',
  label: 'NORMAL',
  key: '1',
  uniforms: {},
  fragmentShader: '',
};

/** Switcher order and the 1-7 keyboard shortcuts: normal, then CRT/NVG/FLIR, then the rest. */
export const SENSOR_STYLES: SensorStyle[] = [
  normalStyle,
  retroStyle,
  surveillanceStyle,
  thermalStyle,
  noirStyle,
  snowStyle,
  animeStyle,
];

/** Duration (ms) for the shader intensity crossfade between style presets. */
const TRANSITION_DURATION_MS = 500;

type CesiumGlobal = typeof CesiumNS;

type StageEntry = {
  style: SensorStyle;
  stage: CesiumNS.PostProcessStage;
};

type Transition = { start: number; from: number; to: number };

export type StyleManagerOptions = {
  /** Monotonic clock, ms. Defaults to performance.now(); injectable for deterministic tests. */
  now?: () => number;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (id: number) => void;
};

export type StyleManager = {
  /** Crossfades from whatever style is active to `name` over TRANSITION_DURATION_MS. */
  setStyle(name: string): void;
  setUniform(styleName: string, uniformName: string, value: number): void;
  /** Removes every owned PostProcessStage from the viewer and stops the animation loop. */
  dispose(): void;
};

/**
 * Adds one PostProcessStage per shader style (skipping the shaderless "normal" pseudo-style) to
 * `viewer.scene.postProcessStages`, all at intensity 0 so idle stages cost nothing — a stage's
 * `enabled` is kept in lockstep with its `intensity` uniform. `setStyle` crossfades the outgoing
 * and incoming style's intensity together via requestAnimationFrame.
 */
export function createStyleManager(Cesium: CesiumGlobal, viewer: CesiumNS.Viewer, options: StyleManagerOptions = {}): StyleManager {
  const now = options.now ?? (() => performance.now());
  const requestFrame = options.requestFrame ?? ((callback: FrameRequestCallback) => requestAnimationFrame(callback));
  const cancelFrame = options.cancelFrame ?? ((id: number) => cancelAnimationFrame(id));

  const stages = new Map<string, StageEntry>();
  const transitions = new Map<string, Transition>();
  let current = 'normal';
  let frameId: number | null = null;
  let disposed = false;

  for (const style of SENSOR_STYLES) {
    if (!style.fragmentShader) continue; // the "normal" pseudo-style has no stage
    const uniforms: Record<string, number> = { intensity: 0 };
    if (style.fragmentShader.includes('uniform float time')) uniforms.time = 0;
    for (const [uniformName, meta] of Object.entries(style.uniforms)) uniforms[uniformName] = meta.default;
    const stage = new Cesium.PostProcessStage({
      name: `lookout_sensor_${style.name}`,
      fragmentShader: style.fragmentShader,
      uniforms,
    });
    stage.enabled = false;
    viewer.scene.postProcessStages.add(stage);
    stages.set(style.name, { style, stage });
  }

  function setStageIntensity(entry: StageEntry, value: number): void {
    entry.stage.uniforms.intensity = value;
    entry.stage.enabled = value > 0.001;
  }

  function startAnimationLoop(): void {
    if (disposed || frameId !== null) return;
    const tick = () => {
      if (disposed) return;
      const t = now();
      for (const [name, transition] of transitions) {
        const entry = stages.get(name);
        if (!entry) {
          transitions.delete(name);
          continue;
        }
        const progress = Math.min((t - transition.start) / TRANSITION_DURATION_MS, 1);
        const eased = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2;
        setStageIntensity(entry, transition.from + (transition.to - transition.from) * eased);
        if (progress >= 1) {
          setStageIntensity(entry, transition.to);
          transitions.delete(name);
        }
      }
      const elapsedSec = t / 1000;
      let animatedStageVisible = transitions.size > 0;
      for (const entry of stages.values()) {
        if (entry.stage.enabled && entry.stage.uniforms.time !== undefined) {
          entry.stage.uniforms.time = elapsedSec;
          if (entry.stage.uniforms.intensity > 0.001) animatedStageVisible = true;
        }
      }
      frameId = animatedStageVisible ? requestFrame(tick) : null;
    };
    frameId = requestFrame(tick);
  }

  function setStyle(name: string): void {
    if (disposed || name === current) return;
    const from = current;
    current = name;
    if (from !== 'normal') {
      const fromEntry = stages.get(from);
      if (fromEntry) transitions.set(from, { start: now(), from: fromEntry.stage.uniforms.intensity ?? 0, to: 0 });
    }
    if (name !== 'normal') {
      const toEntry = stages.get(name);
      if (toEntry) transitions.set(name, { start: now(), from: toEntry.stage.uniforms.intensity ?? 0, to: 1 });
    }
    if (transitions.size > 0) startAnimationLoop();
  }

  function setUniform(styleName: string, uniformName: string, value: number): void {
    const entry = stages.get(styleName);
    if (!entry) return;
    entry.stage.uniforms[uniformName] = value;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (frameId !== null) cancelFrame(frameId);
    frameId = null;
    transitions.clear();
    for (const entry of stages.values()) viewer.scene.postProcessStages.remove(entry.stage);
    stages.clear();
  }

  return { setStyle, setUniform, dispose };
}
