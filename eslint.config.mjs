import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored verbatim from the Assistant Standard's web kit — lint it upstream, not here.
    "src/lib/assistant/kit/**",
  ]),
  {
    // The public-feed parsers inherited from OSIRIS (flights, satellites, cameras, quakes, ships)
    // read loosely-typed upstream JSON with `any`. Typing them is a follow-up, not a blocker; the
    // rule stays on everywhere else.
    files: ["src/app/api/cctv/**", "src/app/api/flights/**", "src/app/api/satellites/**", "src/app/api/maritime/**", "src/app/api/earthquakes/**"],
    rules: { "@typescript-eslint/no-explicit-any": "warn" },
  },
]);

export default eslintConfig;
