"use client";

import { useCallback, useEffect, useState } from "react";
import { CircleAlert, CircleCheck, KeyRound, PageHeader, ProductShell, ProviderBrand, StatusBanner, ErrorPanel, LoadingPanel, useCurrentHost } from "@/app/components/product";
import { Link2, Unplug } from "lucide-react";

type Provider = "spotify" | "apple-music";
type ConnectionStatus = { connected: boolean; enabled: boolean; publishingEnabled: boolean; storefront: string | null };
type ApiError = { code?: string; message?: string; retryable?: boolean };
type Envelope<T> = { data?: T | null; error?: ApiError | null };
type Resource = { state: "loading" | "ready" | "error"; data: ConnectionStatus | null; message: string };

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

async function apiMessage(response: Response, fallback: string): Promise<string> {
  const body = await response.clone().json().catch(() => null) as Envelope<unknown> | null;
  return body?.error?.message ?? fallback;
}

function useProviderStatus(provider: Provider) {
  const [version, setVersion] = useState(0);
  const [resource, setResource] = useState<Resource>({ state: "loading", data: null, message: "" });
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/v1/providers/${provider}/status`, { credentials: "include", cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as Envelope<ConnectionStatus>;
        if (!response.ok || body.error || !body.data) throw new Error(body.error?.message ?? "Connection status is unavailable.");
        setResource({ state: "ready", data: body.data, message: "" });
      })
      .catch((cause) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setResource({ state: "error", data: null, message: cause instanceof Error ? cause.message : "Connection status is unavailable." });
      });
    return () => controller.abort();
  }, [provider, version]);
  return { ...resource, refresh: useCallback(() => { setResource({ state: "loading", data: null, message: "" }); setVersion((value) => value + 1); }, []) };
}

export default function ConnectionsPage() {
  const host = useCurrentHost();
  const spotify = useProviderStatus("spotify");
  const apple = useProviderStatus("apple-music");
  const [appleState, setAppleState] = useState<"idle" | "working" | "error" | "success">("idle");
  const [actionMessage, setActionMessage] = useState("");

  async function disconnect(provider: Provider, refresh: () => void) {
    setActionMessage("");
    const response = await fetch(`/api/v1/providers/${provider}/disconnect`, { method: "POST", credentials: "include" });
    if (!response.ok) { setActionMessage(await apiMessage(response, `${provider === "spotify" ? "Spotify" : "Apple Music"} could not be disconnected.`)); return; }
    refresh();
  }

  async function connectAppleMusic() {
    setAppleState("working"); setActionMessage("");
    try {
      const tokenResponse = await fetch("/api/v1/providers/apple-music/developer-token", { method: "POST", credentials: "include" });
      if (!tokenResponse.ok) throw new Error(await apiMessage(tokenResponse, "Apple Music authorization could not start."));
      const tokenBody = await tokenResponse.json() as Envelope<{ developerToken: string; expiresAtMs: number }>;
      if (!tokenBody.data?.developerToken) throw new Error("Apple Music authorization did not return a developer token.");
      const musicKit = await loadMusicKit();
      await Promise.resolve(musicKit.configure({ developerToken: tokenBody.data.developerToken, storefrontId: "us", app: { name: "UniJam", build: "0.1.0" } }));
      const musicUserToken = await musicKit.getInstance().authorize();
      if (!musicUserToken) throw new Error("Apple Music did not grant access.");
      const connection = await fetch("/api/v1/providers/apple-music/connect", {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ musicUserToken }),
      });
      if (!connection.ok) throw new Error(await apiMessage(connection, "Apple Music could not be connected."));
      setAppleState("success");
      setActionMessage("Apple Music is connected for the US storefront.");
      apple.refresh();
    } catch (cause) {
      setAppleState("error");
      setActionMessage(cause instanceof Error ? cause.message : "Apple Music could not be connected.");
    }
  }

  if (host.status === "loading") return <ProductShell><LoadingPanel label="Checking provider availability…" /></ProductShell>;
  if (host.status === "error" || !host.data) return <ProductShell><ErrorPanel title="Host access required" message={host.error?.message ?? "Sign in before managing provider connections."} /></ProductShell>;
  const unavailable = spotify.state === "error" && apple.state === "error";
  return <ProductShell displayName={host.data.displayName}><PageHeader eyebrow="CONNECTIONS" title="Provider connections" description="Each provider is authorized, stored, disconnected, and retried independently." />{unavailable && <StatusBanner tone="warning" title="Connector unavailable">{spotify.message || apple.message}</StatusBanner>}{!host.data.recentPasskey && <StatusBanner tone="warning" title="Passkey confirmation required">Provider changes require a recent passkey confirmation. Sign in with your passkey again before connecting or disconnecting.</StatusBanner>}{actionMessage && <p className={appleState === "error" ? "inline-error" : "inline-success"} role={appleState === "error" ? "alert" : "status"}>{actionMessage}</p>}<div className="connection-grid"><article className="connection-card"><div className="provider-isolation provider-spotify-bg"><ProviderBrand provider="spotify" background="dark" purpose="connect" /></div><div className="connection-copy"><div><h2>Spotify</h2><span className="connection-wait">{spotify.data?.connected ? <><CircleCheck /> Connected</> : spotify.state === "loading" ? "Checking…" : <><CircleAlert /> {spotify.data?.enabled ? "Not connected" : "Unavailable"}</>}</span></div><p>Authorization Code + PKCE. Spotify credentials remain inside the connector service.</p><dl><div><dt>Storefront</dt><dd>{spotify.data?.storefront ?? "US pilot"}</dd></div><div><dt>Publishing</dt><dd>{spotify.data?.publishingEnabled ? "Enabled" : "Feature-gated"}</dd></div></dl>{spotify.data?.connected ? <button className="button button-quiet" onClick={() => void disconnect("spotify", spotify.refresh)}><Unplug size={18} /> Disconnect Spotify</button> : spotify.data?.enabled ? <a className="button button-ink" href="/api/v1/providers/spotify/connect"><KeyRound size={18} /> Connect Spotify</a> : <button className="button button-ink" disabled><KeyRound size={18} /> Connect Spotify</button>}</div></article><article className="connection-card"><div className="provider-isolation provider-apple-bg"><span className="neutral-provider"><Link2 /><strong>Apple Music</strong></span></div><div className="connection-copy"><div><h2>Apple Music</h2><span className="connection-wait">{apple.data?.connected ? <><CircleCheck /> Connected</> : apple.state === "loading" ? "Checking…" : <><CircleAlert /> {apple.data?.enabled ? "Not connected" : "Unavailable"}</>}</span></div><p>MusicKit authorization runs only on this isolated connection screen. The connector validates and encrypts the Music User Token.</p><dl><div><dt>Storefront</dt><dd>{apple.data?.storefront ?? "US pilot"}</dd></div><div><dt>Publishing</dt><dd>{apple.data?.publishingEnabled ? "Enabled" : "Feature-gated"}</dd></div></dl>{apple.data?.connected ? <button className="button button-quiet" onClick={() => void disconnect("apple-music", apple.refresh)}><Unplug size={18} /> Disconnect Apple Music</button> : apple.data?.enabled ? <button className="button button-ink" disabled={appleState === "working"} onClick={() => void connectAppleMusic()}><KeyRound size={18} /> {appleState === "working" ? "Waiting for Apple Music…" : "Connect Apple Music"}</button> : <button className="button button-ink" disabled><KeyRound size={18} /> Connect Apple Music</button>}</div></article></div><p className="provider-footnote">No provider token, playlist, metadata, or artwork is fabricated on this screen.</p></ProductShell>;
}
