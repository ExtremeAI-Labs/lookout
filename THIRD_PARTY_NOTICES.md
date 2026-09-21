# Third-party notices

## God's Eye View (sensor-style shaders)

`src/lib/theater/styles/{retro,surveillance,thermal,noir,snow,anime}.ts` are adapted from
[God's Eye View](https://github.com/bilawalsidhu/gods-eye-view) by Bilawal Sidhu, used under the
MIT License (code portion only). `src/lib/theater/styles/index.ts` is a TypeScript port of that
project's `src/ui/visualEffects.js` (post-process stage lifecycle and crossfade) and
`src/ui/visualPresets.js` (the style registry and transition duration).

```
MIT License

Copyright (c) 2026 Bilawal Sidhu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The MIT grant above covers the God's Eye View source code only; it does not extend to any
third-party data, imagery, or model assets bundled in that upstream project. None of that
data/asset material was ported into Lookout — only the GLSL shader code and the plain
TypeScript/JavaScript logic that wires it into Cesium's `PostProcessStage` pipeline.

### Theater user-interface styling (2026-09-17)

The 3D theater's visual language — the "Apple meets Blade Runner" tokens (near-black ground,
glass panels, cyan accent, small tracked monospace labels), the scope vignette, the top-left
title bar, the top-right style indicator, the round top-center actions and the bottom command
dock — is ported from God's Eye View's `src/ui/styles/*.css` and templates under the same MIT
licence, re-expressed in `src/app/theater/theater.css` for Lookout's components. Fonts:
JetBrains Mono and Inter, SIL Open Font License 1.1, self-hosted under `public/fonts/`.

## God's Eye View (aircraft classifier)

`src/lib/theater/aircraft-class.ts` is a TypeScript port of that project's `src/data/aircraftClass.js`
(Bilawal Sidhu, MIT) — the ICAO type-designator sets and category fallbacks — which were themselves
adapted from [skylight](https://github.com/cpaczek/skylight) (cpaczek, MIT). The class-to-model
table in the same file is Lookout's own.

## 3D aircraft and ship models (CC BY 4.0, not MIT)

The glTF binaries under `public/models/` are third-party visual assets from Sketchfab, each under
**Creative Commons Attribution 4.0**, as optimised and re-oriented by God's Eye View. They are NOT
covered by this repository's MIT licence. The per-file creators, sources and modification notes are
in [`public/models/ATTRIBUTION.md`](public/models/ATTRIBUTION.md) (carried over verbatim from
God's Eye View's `public/models/README.md`); that file must travel with the models, and the theater's
attribution line credits them.
