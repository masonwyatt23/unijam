import type { Metadata } from "next";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/barlow-condensed/500.css";
import "@fontsource/barlow-condensed/600.css";
import "@fontsource/barlow-condensed/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://unijam.ashlr.ai"),
  title: { default: "UniJam — One room, every listener", template: "%s · UniJam" },
  description: "Invite-only live music rooms for friends across Spotify and Apple Music.",
  openGraph: {
    type: "website",
    url: "https://unijam.ashlr.ai",
    title: "UniJam — One room, every listener",
    description: "Invite-only live music rooms for friends across Spotify and Apple Music.",
    images: [{ url: "/unijam-social-preview.png", width: 1731, height: 909, alt: "UniJam living setlist flowing through a live room." }],
  },
  twitter: {
    card: "summary_large_image",
    title: "UniJam — One room, every listener",
    description: "Invite-only live music rooms for friends across Spotify and Apple Music.",
    images: [{ url: "/unijam-social-preview.png", alt: "UniJam living setlist flowing through a live room." }],
  },
  other: { "codex-preview": "development" },
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
