import type { Metadata } from "next";
import { headers } from "next/headers";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/barlow-condensed/500.css";
import "@fontsource/barlow-condensed/600.css";
import "@fontsource/barlow-condensed/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  // The Worker overwrites these internal headers before Vinext handles a
  // document request. Never derive canonical metadata from the public Host.
  const environment = requestHeaders.get("x-unijam-app-environment") ?? "development";
  const origin = requestHeaders.get("x-unijam-app-origin") ?? "http://localhost:3000";
  const description = "Invite-only live music rooms for friends across Spotify and Apple Music.";
  return {
    metadataBase: new URL(origin),
    title: { default: "UniJam — One room, every listener", template: "%s · UniJam" },
    description,
    robots: environment === "production" ? { index: true, follow: true } : { index: false, follow: false },
    openGraph: {
      type: "website",
      url: origin,
      title: "UniJam — One room, every listener",
      description,
      images: [{ url: "/unijam-social-preview.png", width: 1731, height: 909, alt: "UniJam living setlist flowing through a live room." }],
    },
    twitter: {
      card: "summary_large_image",
      title: "UniJam — One room, every listener",
      description,
      images: [{ url: "/unijam-social-preview.png", alt: "UniJam living setlist flowing through a live room." }],
    },
    icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
    ...(environment === "development" ? { other: { "codex-preview": "development" } } : {}),
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
