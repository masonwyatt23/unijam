"use client";

import Link from "next/link";
import { ArrowRight, CircleAlert, CircleCheck, Link2 } from "lucide-react";

import { ErrorPanel, LoadingPanel, PageHeader, ProductShell, StatusBanner, useCurrentHost } from "@/app/components/product";
import { hostSignInPath } from "@/lib/host-return-to";
import { providerName, useProviderStatus, type Provider } from "./provider-status";

function ProviderStatus({ provider }: { provider: Provider }) {
  const status = useProviderStatus(provider);
  const name = providerName(provider);
  const state = status.state === "loading"
    ? "Checking…"
    : status.state === "error"
      ? "Status unavailable"
      : status.data?.connected
        ? "Connected"
        : status.data?.enabled
          ? "Not connected"
          : "Pilot not active";
  return <article className="connection-card connection-hub-card">
    <div className="provider-isolation provider-neutral-bg"><span className="neutral-provider"><Link2 /><strong>{name}</strong></span></div>
    <div className="connection-copy">
      <div><h2>{name}</h2><span className={status.data?.connected ? "connection-ok" : "connection-wait"}>{status.data?.connected ? <CircleCheck /> : <CircleAlert />}{state}</span></div>
      <p>{provider === "spotify" ? "Authorization Code + PKCE and Spotify publishing are managed on a provider-only screen." : "MusicKit authorization and Apple Music publishing are managed on a provider-only screen."}</p>
      <dl><div><dt>Storefront</dt><dd>{status.data?.storefront?.toUpperCase() ?? "US pilot"}</dd></div><div><dt>Publishing</dt><dd>{status.data?.publishingEnabled ? "Enabled" : "Feature-gated"}</dd></div></dl>
      {status.state === "error" ? <button className="button button-quiet" onClick={status.refresh}>Retry {name} status</button> : <Link className="button button-ink" href={`/connections/${provider}`}>Manage {name} <ArrowRight size={18} /></Link>}
    </div>
  </article>;
}

export default function ConnectionsPage() {
  const host = useCurrentHost();
  if (host.status === "loading") return <ProductShell><LoadingPanel label="Checking provider availability…" /></ProductShell>;
  if (host.status === "error" || !host.data) {
    const unauthenticated = host.error?.code === "UNAUTHENTICATED";
    return <ProductShell><ErrorPanel
      title={unauthenticated ? "Sign in to manage connections" : "Connection access could not be checked"}
      message={unauthenticated ? "Use your UniJam passkey to connect Spotify or Apple Music." : host.error?.message ?? "Your account status is temporarily unavailable."}
      onRetry={unauthenticated ? undefined : host.refresh}
      action={unauthenticated ? <Link className="button button-primary" href={hostSignInPath("/connections")}>Sign in with a passkey</Link> : undefined}
    /></ProductShell>;
  }
  return <ProductShell displayName={host.data.displayName}>
    <PageHeader eyebrow="CONNECTIONS" title="Choose one provider" description="Provider authorization stays isolated. Open one service to connect, disconnect, or review its publishing gate." />
    {!host.data.recentPasskey && <StatusBanner tone="warning" title="Passkey confirmation required" action={<Link className="button button-quiet" href={hostSignInPath("/connections")}>Confirm passkey</Link>}>Provider changes require a recent passkey confirmation.</StatusBanner>}
    <div className="connection-grid"><ProviderStatus provider="spotify" /><ProviderStatus provider="apple-music" /></div>
    <p className="provider-footnote">This overview uses neutral UniJam symbols. Official provider artwork appears only inside its permitted, provider-specific context.</p>
  </ProductShell>;
}
