// Adapted from God's Eye View (github.com/bilawalsidhu/gods-eye-view), MIT © 2026 Bilawal Sidhu.
//
// Shared shape for the theater's "sensor style" post-process shaders — see ./index.ts for the
// manager that turns these into Cesium PostProcessStages.

/** One shader-exposed control: a slider's range plus the value it starts at. */
export type SensorStyleUniform = {
  default: number;
  min: number;
  max: number;
  label: string;
};

export type SensorStyle = {
  /** Internal id, also the PostProcessStage uniform bag's key in the manager. */
  name: string;
  /** Short on-screen label, e.g. the HUD status pill (CRT, NVG, FLIR…). */
  label: string;
  /** Keyboard shortcut, 1-7. */
  key: string;
  uniforms: Record<string, SensorStyleUniform>;
  /** GLSL ES 3.00 fragment shader body for a Cesium PostProcessStage. Empty for the "normal" pseudo-style. */
  fragmentShader: string;
};
