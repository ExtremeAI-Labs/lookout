import type { Metadata, Viewport } from "next";
import ErrorBoundary from '@/components/ErrorBoundary';
import AssistantDock from '@/components/assistant/AssistantDock';
import "./globals.css";
import "@/components/assistant/assistant.css";

const DEMO = process.env.NEXT_PUBLIC_LOOKOUT_DEMO === '1';
const SITE_NAME = DEMO ? "Lookout Theater (demo)" : "Lookout Theater";
const SITE_TITLE = DEMO ? "Lookout Theater — hosted demo" : "Lookout Theater — self-hosted situational awareness";
const SITE_DESCRIPTION = DEMO ? "A public, read-only demo of Lookout Theater: a CesiumJS globe replaying synthetic sample data — no live feeds, no assistant." : "Lookout Theater: a self-hosted 3D situational-awareness console — live aircraft, ships, satellites, quakes and public cameras; an assistant with a sensitivity firewall; hash-sealed cases; a recorder for your own receiver.";

export const viewport: Viewport = {
  themeColor: "#0a0a0f",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  colorScheme: "dark",
};

export const metadata: Metadata = {
  title: {
    default: SITE_TITLE,
    template: DEMO ? "%s | Lookout demo" : "%s | Lookout Theater",
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  robots: {
    // A demo deployment is fine to index; it carries no live data and no write paths.
    index: true,
    follow: true,
  },
  icons: {
    icon: [{ url: "/favicon.svg", type: "image/svg+xml" }],
    shortcut: "/favicon.svg",
  },
  manifest: "/site.webmanifest",
  other: {
    "mobile-web-app-capable": "yes",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" dir="ltr">
      <body>
        <ErrorBoundary name="Lookout demo">
          {children}
        </ErrorBoundary>
        {/* Scout — the assistant dock, mounted once here. It is hard-stubbed in this demo
            (no LOOKOUT_GATEWAY_URL / LOOKOUT_GATEWAY_KEY / OPENAI_API_KEY are set), so chat and
            voice both degrade to a clear "not configured" message rather than erroring — see
            src/app/api/assistant/{chat,voice}/route.ts and DEMO_MODE.md. */}
        <ErrorBoundary name="Scout">
          <AssistantDock />
        </ErrorBoundary>
      </body>
    </html>
  );
}
