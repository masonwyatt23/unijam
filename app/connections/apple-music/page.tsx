"use client";

import { CircleAlert, CircleCheck, KeyRound, Unplug } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useState } from "react";

import { ErrorPanel, LoadingPanel, PageHeader, ProductShell, ProviderBrand, StatusBanner, useCurrentHost } from "@/app/components/product";
import { hostSignInPath, providerConnectionReturnTo } from "@/lib/host-return-to";
import { providerResultMessage, providerResultPath, safeProviderReturnTo } from "@/lib/provider-return-to";
import { apiMessage, useProviderStatus, type Envelope } from "../provider-status";

type MusicKitInstance = { authorize: () => Promise<string>; unauthorize: () => Promise<void> };
type MusicKitGlobal = {
  configure: (configuration: { developerToken: string; storefrontId: "us"; app: { name: string; build: string } }) => unknown;
  getInstance: () => MusicKitInstance;
};
declare global { interface Window { MusicKit?: MusicKitGlobal } }

const musicKitScript = "https://js-cdn.music.apple.com/musickit/v3/musickit.js";
let musicKitLoad: Promise<MusicKitGlobal> | null = null;

function loadMusicKit(): Promise<MusicKitGlobal> {
  if (window.MusicKit) return Promise.resolve(window.MusicKit);
  if (musicKitLoad) return musicKitLoad;
  const pending = new Promise<MusicKitGlobal>((resolve, reject) => {
    const complete = () => window.MusicKit ? resolve(window.MusicKit) : reject(new Error("Apple Music authorization did not load."));
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${musicKitScript}"]`);
    if (existing) {
      existing.addEventListener("load", complete, { once: true });
      existing.addEventListener("error", () => reject(new Error("Apple Music authorization could not load.")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = musicKitScript;
    script.async = true;
    script.dataset.unijamProvider = "apple-music";
    script.addEventListener("load", complete, { once: true });
    script.addEventListener("error", () => reject(new Error("Apple Music authorization could not load.")), { once: true });
    document.head.appendChild(script);
  });
  musicKitLoad = pending.catch((error) => { musicKitLoad = null; throw error; });
  return musicKitLoad;
}

export default function AppleMusicConnectionPage() {
  const searchParams = useSearchParams();
  const returnTo = safeProviderReturnTo(searchParams.get("returnTo"));
  const confirmationReturnTo = providerConnectionReturnTo("apple-music", returnTo);
  const connectionResult = providerResultMessage("apple-music", searchParams.get("providerResult"));
  const host = useCurrentHost();
  const apple = useProviderStatus("apple-music");
  const [working, setWorking] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: "success" | "error"; message: string } | null>(null);

  async function disconnect() {
    setWorking(true); setFeedback(null);
    try {
      const response = await fetch("/api/v1/providers/apple-music/disconnect", { method: "POST", credentials: "include" });
      if (!response.ok) {
        setFeedback({ tone: "error", message: await apiMessage(response, "Apple Music could not be disconnected.") });
        return;
      }
      // The encrypted server token is purged first. Only then do we ask
      // MusicKit to clear this browser's local Apple Music authorization.
      try {
        const musicKit = await configuredMusicKit();
        await musicKit.getInstance().unauthorize();
      } catch {
        setFeedback({ tone: "error", message: "Apple Music was disconnected from UniJam, but this browser could not clear its local Apple Music permission. Close any Apple Music authorization window and try again." });
        apple.refresh();
        return;
      }
      setFeedback({ tone: "success", message: "Apple Music was disconnected." });
      apple.refresh();
    } catch {
      setFeedback({ tone: "error", message: "Apple Music could not be disconnected because the connector could not be reached. Try again." });
    } finally { setWorking(false); }
  }

  async function configuredMusicKit(): Promise<MusicKitGlobal> {
    const tokenResponse = await fetch("/api/v1/providers/apple-music/developer-token", { method: "POST", credentials: "include" });
    if (!tokenResponse.ok) throw new Error(await apiMessage(tokenResponse, "Apple Music authorization could not start."));
    const tokenBody = await tokenResponse.json() as Envelope<{ developerToken: string; expiresAtMs: number }>;
    if (!tokenBody.data?.developerToken) throw new Error("Apple Music authorization did not return a developer token.");
    const musicKit = await loadMusicKit();
    await Promise.resolve(musicKit.configure({ developerToken: tokenBody.data.developerToken, storefrontId: "us", app: { name: "UniJam", build: "0.1.0" } }));
    return musicKit;
  }

  function authorizationWasCancelled(cause: unknown): boolean {
    if (cause instanceof DOMException && (cause.name === "AbortError" || cause.name === "NotAllowedError")) return true;
    return cause instanceof Error && /cancel(?:led|ed)?|declin|denied|abort/iu.test(cause.message);
  }

  async function connect() {
    setWorking(true); setFeedback(null);
    try {
      const musicKit = await configuredMusicKit();
      const musicUserToken = await musicKit.getInstance().authorize();
      if (!musicUserToken) throw new Error("Apple Music authorization was cancelled.");
      const connection = await fetch("/api/v1/providers/apple-music/connect", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ musicUserToken }) });
      if (!connection.ok) throw new Error(await apiMessage(connection, "Apple Music could not be connected."));
      if (returnTo) {
        window.location.assign(providerResultPath(returnTo, "apple-music", "connected"));
        return;
      }
      setFeedback({ tone: "success", message: "Apple Music is connected for the US storefront." });
      apple.refresh();
    } catch (cause) {
      if (returnTo && authorizationWasCancelled(cause)) {
        window.location.assign(providerResultPath(returnTo, "apple-music", "cancelled"));
        return;
      }
      setFeedback({ tone: "error", message: cause instanceof Error ? cause.message : "Apple Music could not be connected." });
    } finally { setWorking(false); }
  }

  if (host.status === "loading") return <ProductShell><LoadingPanel label="Checking Apple Music availability…" /></ProductShell>;
  if (host.status === "error" || !host.data) {
    const unauthenticated = host.error?.code === "UNAUTHENTICATED";
    return <ProductShell><ErrorPanel
      title={unauthenticated ? "Sign in to manage Apple Music" : "Apple Music access could not be checked"}
      message={unauthenticated ? "Use your UniJam passkey, then continue with Apple Music." : host.error?.message ?? "Your account status is temporarily unavailable."}
      onRetry={unauthenticated ? undefined : host.refresh}
      action={unauthenticated ? <a className="button button-primary" href={hostSignInPath(confirmationReturnTo)}>Sign in with a passkey</a> : undefined}
    /></ProductShell>;
  }
  return <ProductShell displayName={host.data.displayName}>
    <PageHeader eyebrow="APPLE MUSIC CONNECTION" title="Apple Music" description="MusicKit authorization runs only on this provider-specific screen." backHref={returnTo ?? "/connections"} />
    {connectionResult && <StatusBanner tone={connectionResult.tone} title={connectionResult.title}>{connectionResult.message}</StatusBanner>}
    {apple.state === "error" && <StatusBanner tone="warning" title="Apple Music status unavailable" action={<button className="button button-quiet" onClick={apple.refresh}>Retry status</button>}>{apple.message}</StatusBanner>}
    {apple.data?.enabled === false && <StatusBanner tone="warning" title="Apple Music pilot is paused">Rooms remain available. Apple Music connection and publishing stay closed until approved credentials and pilot access are active.</StatusBanner>}
    {!host.data.recentPasskey && <StatusBanner tone="warning" title="Passkey confirmation required" action={<a className="button button-quiet" href={hostSignInPath(confirmationReturnTo)}>Confirm passkey</a>}>Connect and disconnect actions require a recent passkey confirmation.</StatusBanner>}
    {feedback && <p className={feedback.tone === "error" ? "inline-error" : "inline-success"} role={feedback.tone === "error" ? "alert" : "status"}>{feedback.message}</p>}
    <div className="connection-detail"><article className="connection-card"><div className="provider-isolation provider-apple-bg"><ProviderBrand provider="apple-music" variant="music-icon" background="light" purpose="connect" href="https://music.apple.com/us" label="Open Apple Music" /></div><div className="connection-copy"><div><h2>Apple Music</h2><span className={apple.data?.connected ? "connection-ok" : "connection-wait"}>{apple.data?.connected ? <><CircleCheck /> Connected</> : <><CircleAlert /> {apple.state === "loading" ? "Checking…" : apple.state === "error" ? "Status unavailable" : apple.data?.enabled ? "Not connected" : "Pilot not active"}</>}</span></div><p>The connector validates and encrypts the Music User Token. The official Apple Music icon links to Apple Music; connecting only opens MusicKit’s authorization prompt.</p><dl><div><dt>Storefront</dt><dd>{apple.data?.storefront?.toUpperCase() ?? "US pilot"}</dd></div><div><dt>Publishing</dt><dd>{apple.data?.publishingEnabled ? "Enabled" : "Feature-gated"}</dd></div></dl>{apple.data?.connected ? <button className="button button-quiet" disabled={!host.data.recentPasskey || working} onClick={() => void disconnect()}><Unplug size={18} /> {working ? "Disconnecting…" : "Disconnect Apple Music"}</button> : apple.data?.enabled || apple.state === "error" ? <button className="button button-ink" disabled={!host.data.recentPasskey || working} onClick={() => void connect()}><KeyRound size={18} /> {working ? "Waiting for Apple Music…" : "Connect Apple Music"}</button> : <button className="button button-ink" disabled><KeyRound size={18} /> Connect Apple Music</button>}</div></article></div>
  </ProductShell>;
}
