import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* This tree is the public kit: the theater without the private console. The flag swaps the
     console-only menu items for a source link; it is baked at build time. */
  env: { NEXT_PUBLIC_LOOKOUT_KIT: '1', NEXT_PUBLIC_LOOKOUT_REPO_URL: 'https://github.com/ExtremeAI-Labs/lookout' },
  /* Standalone output is opt-in (LOOKOUT_STANDALONE=1) for a self-hosted service that wants a
     single folder to copy; `npm start` needs nothing. Vercel builds its own artifacts and
     does not want it: since the 16.2.6 -> 16.3.4 bump its adapter fails packaging with
     `ENOENT .next/next-server.js.nft.json` in onBuildComplete when a Turbopack build also
     emits standalone. Keep standalone everywhere except Vercel. */
  output: process.env.LOOKOUT_STANDALONE === '1' && !process.env.VERCEL ? 'standalone' : undefined,
  typescript: {
    ignoreBuildErrors: false,
  },
  async headers() {
    return [
      // /vendor/cesium/<version>/ is ~15 MB of prebuilt assets whose contents can only change
      // with the version — the version is part of the path, so caching it immutably is safe.
      {
        source: '/vendor/cesium/:version/:file*',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
        ],
      },
      {
        // DEMO MODE: upstream Lookout also allow-lists its local CCTV tracker service
        // (http://127.0.0.1:4614) here; that service is amputated from this public demo
        // (see DEMO_MODE.md), so it is not in this policy.
        source: '/(.*)',
        headers: [
          { key: 'Content-Security-Policy', value: `default-src 'self' 'unsafe-inline' 'unsafe-eval' https: wss: data: blob:; frame-ancestors ${process.env.LOOKOUT_FRAME_ANCESTORS || "'self'"};` },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-XSS-Protection', value: '1; mode=block' },
        ],
      },
    ];
  },
};

export default nextConfig;
