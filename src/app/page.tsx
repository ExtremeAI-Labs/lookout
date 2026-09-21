// The 3D theater is the root route in this demo (upstream Lookout's root is a 2D
// OSINT console, amputated here — see DEMO_MODE.md). Re-exporting the real route's page
// keeps src/app/theater/page.tsx byte-identical to upstream rather than duplicating it, and
// leaves /theater working too.
export { default, metadata } from './theater/page';
