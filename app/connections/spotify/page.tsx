"use client";

import { CircleAlert, CircleCheck, KeyRound, Unplug } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useState } from "react";

import { ErrorPanel, LoadingPanel, PageHeader, ProductShell, ProviderBrand, StatusBanner, useCurrentHost } from "@/app/components/product";
import { hostSignInPath, providerConnectionReturnTo } from "@/lib/host-return-to";
import { providerResultMessage, safeProviderReturnTo } from "@/lib/provider-return-to";
import { apiMessage, useProviderStatus } from "../provider-status";

export default function SpotifyConnectionPage() {
  const searchParams = useSearchParams();
  const returnTo = safeProviderReturnTo(searchParams.get("returnTo"));
  const confirmationReturnTo = providerConnectionReturnTo("spotify", returnTo);
  const oauthResult = providerResultMessage("spotify", searchParams.get("providerResult"));
  const connectHref = returnTo
    ? `/api/v1/providers/spotify/connect?returnTo=${encodeURIComponent(returnTo)}`
    : "/api/v1/providers/spotify/connect";
  const host = useCurrentHost();
  const spotify = useProviderStatus("spotify");
  const [feedback, setFeedback] = useState<{ tone: "success" | "error"; message: string } | null>(null);

  async function disconnect() {
    setFeedback(null);
    try {
      const response = await fetch("/api/v1/providers/spotify/disconnect", { method: "POST", credentials: "include" });
      if (!response.ok) {
        setFeedback({ tone: "error", message: await apiMessage(response, "Spotify could not be disconnected.") });
        return;
      }
      setFeedback({ tone: "success", message: "Spotify was disconnected." });
      spotify.refresh();
    } catch {
      setFeedback({ tone: "error", message: "Spotify could not be disconnected because the connector could not be reached. Try again." });
    }
  }

  if (host.status === "loading") return <ProductShell><LoadingPanel label="Checking Spotify availability…" /></ProductShell>;
  if (host.status === "error" || !host.data) {
    const unauthenticated = host.error?.code === "UNAUTHENTICATED";
    return <ProductShell><ErrorPanel
      title={unauthenticated ? "Sign in to manage Spotify" : "Spotify access could not be checked"}
      message={unauthenticated ? "Use your UniJam passkey, then continue with Spotify." : host.error?.message ?? "Your account status is temporarily unavailable."}
      onRetry={unauthenticated ? undefined : host.refresh}
      action={unauthenticated ? <a className="button button-primary" href={hostSignInPath(confirmationReturnTo)}>Sign in with a passkey</a> : undefined}
    /></ProductShell>;
  }
  return <ProductShell displayName={host.data.displayName}>
    <PageHeader eyebrow="SPOTIFY CONNECTION" title="Spotify" description="This screen contains only Spotify authorization, connection status, and publishing controls." backHref={returnTo ?? "/connections"} />
    {oauthResult && <StatusBanner tone={oauthResult.tone} title={oauthResult.title}>{oauthResult.message}</StatusBanner>}
    {spotify.state === "error" && <StatusBanner tone="warning" title="Spotify status unavailable" action={<button className="button button-quiet" onClick={spotify.refresh}>Retry status</button>}>{spotify.message}</StatusBanner>}
    {spotify.data?.enabled === false && <StatusBanner tone="warning" title="Spotify pilot is paused">Rooms remain available. Spotify connection and publishing stay closed until approved credentials and the host allowlist are active.</StatusBanner>}
    {!host.data.recentPasskey && <StatusBanner tone="warning" title="Passkey confirmation required" action={<a className="button button-quiet" href={hostSignInPath(confirmationReturnTo)}>Confirm passkey</a>}>Connect and disconnect actions require a recent passkey confirmation.</StatusBanner>}
    {feedback && <p className={feedback.tone === "error" ? "inline-error" : "inline-success"} role={feedback.tone === "error" ? "alert" : "status"}>{feedback.message}</p>}
    <div className="connection-detail"><article className="connection-card"><div className="provider-isolation provider-spotify-bg"><ProviderBrand provider="spotify" background="dark" purpose="connect" /></div><div className="connection-copy"><div><h2>Spotify</h2><span className={spotify.data?.connected ? "connection-ok" : "connection-wait"}>{spotify.data?.connected ? <><CircleCheck /> Connected</> : <><CircleAlert /> {spotify.state === "loading" ? "Checking…" : spotify.state === "error" ? "Status unavailable" : spotify.data?.enabled ? "Not connected" : "Pilot not active"}</>}</span></div><p>Authorization Code + PKCE. Spotify credentials remain inside the connector service.</p><p>UniJam asks Spotify to read your basic private account details and private playlists, and to create or update private playlists. The same authorization lets you search Spotify&apos;s catalog for your own room picks. UniJam does not request your email or public-playlist write access.</p><dl><div><dt>Storefront</dt><dd>{spotify.data?.storefront?.toUpperCase() ?? "US pilot"}</dd></div><div><dt>Publishing</dt><dd>{spotify.data?.publishingEnabled ? "Enabled" : "Feature-gated"}</dd></div></dl>{spotify.data?.connected ? <button className="button button-quiet" disabled={!host.data.recentPasskey} onClick={() => void disconnect()}><Unplug size={18} /> Disconnect Spotify</button> : spotify.data?.enabled && host.data.recentPasskey ? <a className="button button-ink" href={connectHref}><KeyRound size={18} /> Connect Spotify</a> : <button className="button button-ink" disabled><KeyRound size={18} /> Connect Spotify</button>}</div></article></div>
  </ProductShell>;
}
