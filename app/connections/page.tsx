"use client";

import Link from "next/link";
import { ArrowRight, CircleAlert, CircleCheck, Link2, RotateCcw } from "lucide-react";

import { ErrorPanel, LoadingPanel, PageHeader, ProductShell, StatusBanner, useCurrentHost } from "@/app/components/product";
import { hostSignInPath } from "@/lib/host-return-to";
import { providerName, useProviderStatus, type Provider } from "./provider-status";

function ProviderStatus({ provider }: { provider: Provider }) {
  const status = useProviderStatus(provider);
  const name = providerName(provider);
  const state = status.state === "loading"
    ? "Checking…"
    : status.state === "error"
      ? "Couldn’t check status"
      : status.data?.connected
        ? "Connected"
        : status.data?.enabled
          ? "Ready to connect"
          : "Pilot access required";

  return <article className="connection-card connection-hub-card">
    <div className="provider-isolation provider-neutral-bg"><span className="neutral-provider"><Link2 /><strong>{name}</strong></span></div>
    <div className="connection-copy">
      <div><h2>{name}</h2><span className={status.data?.connected ? "connection-ok" : "connection-wait"}>{status.data?.connected ? <CircleCheck /> : <CircleAlert />}{state}</span></div>
      <p>{provider === "spotify" ? "Use your own Spotify account to browse saved music, add exact recordings, and save the finished setlist." : "Use Apple Music to browse your library, match exact recordings, and save the finished setlist."}</p>
      <dl><div><dt>Music region</dt><dd>{status.data?.storefront?.toUpperCase() ?? "US"}</dd></div><div><dt>Save playlists</dt><dd>{status.data?.publishingEnabled ? "Available" : "Coming after pilot testing"}</dd></div></dl>
      <div className="connection-card-actions"><Link className="button button-ink" href={`/connections/${provider}`}>{status.data?.connected ? `Manage ${name}` : `Open ${name} setup`} <ArrowRight size={18} /></Link>{status.state === "error" ? <button className="button button-quiet" onClick={status.refresh}><RotateCcw size={17} /> Check again</button> : null}</div>
    </div>
  </article>;
}

export default function ConnectionsPage() {
  const host = useCurrentHost();
  if (host.status === "loading") return <ProductShell><LoadingPanel label="Checking your music services…" /></ProductShell>;
  if (host.status === "error" || !host.data) {
    const unauthenticated = host.error?.code === "UNAUTHENTICATED";
    return <ProductShell><ErrorPanel
      title={unauthenticated ? "Sign in to connect your music" : "Connection access could not be checked"}
      message={unauthenticated ? "Use your UniJam passkey, then choose Spotify or Apple Music." : host.error?.message ?? "Your account status is temporarily unavailable."}
      onRetry={unauthenticated ? undefined : host.refresh}
      action={unauthenticated ? <Link className="button button-primary" href={hostSignInPath("/connections")}>Sign in with a passkey</Link> : undefined}
    /></ProductShell>;
  }
  return <ProductShell displayName={host.data.displayName}>
    <PageHeader eyebrow="CONNECT YOUR MUSIC" title="Choose your service" description="Connect the service you already use. UniJam keeps each connection private and never shares it with the room." />
    {!host.data.recentPasskey && <StatusBanner tone="warning" title="Confirm it’s you" action={<Link className="button button-quiet" href={hostSignInPath("/connections")}>Confirm passkey</Link>}>A quick passkey check protects your music connections.</StatusBanner>}
    <div className="connection-grid"><ProviderStatus provider="spotify" /><ProviderStatus provider="apple-music" /></div>
    <p className="provider-footnote">Choose one service to enter its secure connection screen. Provider artwork appears there in its permitted, service-specific context.</p>
  </ProductShell>;
}
