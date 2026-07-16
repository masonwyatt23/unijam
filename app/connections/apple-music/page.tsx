"use client";

import { CircleAlert, CircleCheck, KeyRound, Link2, Unplug } from "lucide-react";
import { useState } from "react";

import { ErrorPanel, LoadingPanel, PageHeader, ProductShell, StatusBanner, useCurrentHost } from "@/app/components/product";
import { apiMessage, useProviderStatus, type Envelope } from "../provider-status";

type MusicKitInstance = { authorize: () => Promise<string> };
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
  const host = useCurrentHost();
  const apple = useProviderStatus("apple-music");
  const [working, setWorking] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: "success" | "error"; message: string } | null>(null);

  async function disconnect() {
    setFeedback(null);
    try {
      const response = await fetch("/api/v1/providers/apple-music/disconnect", { method: "POST", credentials: "include" });
      if (!response.ok) {
        setFeedback({ tone: "error", message: await apiMessage(response, "Apple Music could not be disconnected.") });
        return;
      }
      setFeedback({ tone: "success", message: "Apple Music was disconnected." });
      apple.refresh();
    } catch {
      setFeedback({ tone: "error", message: "Apple Music could not be disconnected because the connector could not be reached. Try again." });
    }
  }

  async function connect() {
    setWorking(true); setFeedback(null);
    try {
      const tokenResponse = await fetch("/api/v1/providers/apple-music/developer-token", { method: "POST", credentials: "include" });
      if (!tokenResponse.ok) throw new Error(await apiMessage(tokenResponse, "Apple Music authorization could not start."));
      const tokenBody = await tokenResponse.json() as Envelope<{ developerToken: string; expiresAtMs: number }>;
      if (!tokenBody.data?.developerToken) throw new Error("Apple Music authorization did not return a developer token.");
      const musicKit = await loadMusicKit();
      await Promise.resolve(musicKit.configure({ developerToken: tokenBody.data.developerToken, storefrontId: "us", app: { name: "UniJam", build: "0.1.0" } }));
      const musicUserToken = await musicKit.getInstance().authorize();
      if (!musicUserToken) throw new Error("Apple Music did not grant access.");
      const connection = await fetch("/api/v1/providers/apple-music/connect", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ musicUserToken }) });
      if (!connection.ok) throw new Error(await apiMessage(connection, "Apple Music could not be connected."));
      setFeedback({ tone: "success", message: "Apple Music is connected for the US storefront." });
      apple.refresh();
    } catch (cause) {
      setFeedback({ tone: "error", message: cause instanceof Error ? cause.message : "Apple Music could not be connected." });
    } finally { setWorking(false); }
  }

  if (host.status === "loading") return <ProductShell><LoadingPanel label="Checking Apple Music availability…" /></ProductShell>;
  if (host.status === "error" || !host.data) return <ProductShell><ErrorPanel title="Host access required" message={host.error?.message ?? "Sign in before managing Apple Music."} /></ProductShell>;
  return <ProductShell displayName={host.data.displayName}>
    <PageHeader eyebrow="APPLE MUSIC CONNECTION" title="Apple Music" description="MusicKit authorization runs only on this provider-specific screen." backHref="/connections" />
    {apple.state === "error" && <StatusBanner tone="warning" title="Apple Music status unavailable" action={<button className="button button-quiet" onClick={apple.refresh}>Retry status</button>}>{apple.message}</StatusBanner>}
    {apple.data?.enabled === false && <StatusBanner tone="warning" title="Apple Music pilot is paused">Rooms remain available. Apple Music connection and publishing stay closed until approved credentials and pilot access are active.</StatusBanner>}
    {!host.data.recentPasskey && <StatusBanner tone="warning" title="Passkey confirmation required" action={<a className="button button-quiet" href="/host/sign-in">Confirm passkey</a>}>Connect and disconnect actions require a recent passkey confirmation.</StatusBanner>}
    {feedback && <p className={feedback.tone === "error" ? "inline-error" : "inline-success"} role={feedback.tone === "error" ? "alert" : "status"}>{feedback.message}</p>}
    <div className="connection-detail"><article className="connection-card"><div className="provider-isolation provider-apple-bg"><span className="neutral-provider"><Link2 /><strong>Apple Music</strong></span></div><div className="connection-copy"><div><h2>Apple Music</h2><span className={apple.data?.connected ? "connection-ok" : "connection-wait"}>{apple.data?.connected ? <><CircleCheck /> Connected</> : <><CircleAlert /> {apple.state === "loading" ? "Checking…" : apple.state === "error" ? "Status unavailable" : apple.data?.enabled ? "Not connected" : "Pilot not active"}</>}</span></div><p>The connector validates and encrypts the Music User Token. Official Apple Music badges remain reserved for links to licensed content.</p><dl><div><dt>Storefront</dt><dd>{apple.data?.storefront?.toUpperCase() ?? "US pilot"}</dd></div><div><dt>Publishing</dt><dd>{apple.data?.publishingEnabled ? "Enabled" : "Feature-gated"}</dd></div></dl>{apple.data?.connected ? <button className="button button-quiet" disabled={!host.data.recentPasskey} onClick={() => void disconnect()}><Unplug size={18} /> Disconnect Apple Music</button> : apple.data?.enabled ? <button className="button button-ink" disabled={!host.data.recentPasskey || working} onClick={() => void connect()}><KeyRound size={18} /> {working ? "Waiting for Apple Music…" : "Connect Apple Music"}</button> : <button className="button button-ink" disabled><KeyRound size={18} /> Connect Apple Music</button>}</div></article></div>
  </ProductShell>;
}
