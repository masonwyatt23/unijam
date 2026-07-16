"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Check, CircleAlert, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";

import { ErrorPanel, LoadingPanel, ProductShell, ProviderBrand, useRoomState } from "@/app/components/product";

type PublicProvider = "spotify" | "apple-music";
type ProviderValue = "spotify" | "apple_music";
type Handoff = {
  occurrenceId: string;
  recordingId: string;
  title: string;
  provider: ProviderValue;
  links: { universalUrl: string; nativeUri: string; storefront: "US" };
};
type Envelope<T> = { data: T | null; error: { code: string; message: string } | null };

function providerName(provider: PublicProvider) {
  return provider === "spotify" ? "Spotify" : "Apple Music";
}

export function ProviderHandoffPage({ provider }: { provider: PublicProvider }) {
  const { roomId } = useParams<{ roomId: string }>();
  const room = useRoomState(roomId);
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");
  const [prepared, setPrepared] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/v1/rooms/${encodeURIComponent(roomId)}/handoff/${provider}`, { credentials: "include", cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as Envelope<Handoff>;
        if (!response.ok || body.error || !body.data) throw new Error(body.error?.message ?? "Handoff is unavailable.");
        setHandoff(body.data); setStatus("ready");
      })
      .catch((cause: Error | DOMException) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setMessage(cause instanceof Error ? cause.message : "Handoff is unavailable."); setStatus("error");
      });
    return () => controller.abort();
  }, [provider, roomId]);

  async function record(action: "handoff.request" | "handoff.confirm") {
    if (!handoff) return;
    const response = await fetch(`/api/v1/rooms/${encodeURIComponent(roomId)}/commands`, {
      method: "POST", credentials: "include", headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId: `handoff_${crypto.randomUUID()}`, action, payload: { occurrenceId: handoff.occurrenceId, provider: handoff.provider } }),
    });
    const body = await response.json() as Envelope<unknown>;
    if (!response.ok || body.error) throw new Error(body.error?.message ?? "The handoff state could not be recorded.");
  }

  function recordOpen() {
    if (!handoff) return;
    void fetch(`/api/v1/rooms/${encodeURIComponent(roomId)}/commands`, {
      method: "POST", credentials: "include", keepalive: true, headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId: `handoff_${crypto.randomUUID()}`, action: "handoff.open", payload: { occurrenceId: handoff.occurrenceId, provider: handoff.provider } }),
    });
  }

  async function prepare() {
    setMessage("");
    try { await record("handoff.request"); setPrepared(true); }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : "The handoff could not be prepared."); }
  }

  async function confirm() {
    setMessage("");
    try { await record("handoff.confirm"); setConfirmed(true); }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : "The handoff could not be confirmed."); }
  }

  if (room.status === "loading" || status === "loading") return <ProductShell guest roomId={roomId}><LoadingPanel label="Preparing a safe handoff…" /></ProductShell>;
  if (room.status === "error" || !room.data) return <ProductShell guest roomId={roomId}><ErrorPanel title="Room unavailable" message={room.error?.message ?? "The room could not be loaded."} onRetry={room.refresh} /></ProductShell>;
  const guest = room.data.actor.role === "guest" || room.data.actor.role === "viewer";
  const canConfirm = room.data.actor.role === "host" || room.data.actor.role === "cohost";
  if (status === "error" || !handoff) return <ProductShell guest={guest} roomId={roomId} displayName={room.data.actor.nickname}><div className="handoff-page"><Link href={`/room/${roomId}`} className="back-link"><ArrowLeft size={17} /> Back to room</Link><ErrorPanel title={`${providerName(provider)} handoff unavailable`} message={message} /></div></ProductShell>;

  return <ProductShell guest={guest} roomId={roomId} displayName={room.data.actor.nickname}><div className="handoff-page"><Link href={`/room/${roomId}`} className="back-link"><ArrowLeft size={17} /> Back to room</Link><section className="handoff-sheet"><p className="eyebrow">NATIVE HANDOFF · US</p><h1>{handoff.title}</h1><p className="handoff-artist">UniJam matched one exact recording. Opening it is not treated as playback.</p>{message ? <p className="inline-error" role="alert">{message}</p> : null}{!prepared ? <button className="button button-primary" onClick={() => void prepare()}>Prepare {providerName(provider)} handoff</button> : <div className="handoff-destination">{provider === "spotify" ? <ProviderBrand provider="spotify" background="light" purpose="handoff" href={handoff.links.universalUrl} label={`Open ${handoff.title} on Spotify`} /> : <ProviderBrand provider="apple-music" variant="listen-badge" background="light" purpose="handoff" href={handoff.links.universalUrl} label={`Listen to ${handoff.title} on Apple Music`} />}<a className="button button-quiet" href={handoff.links.universalUrl} target="_blank" rel="noreferrer" onClick={recordOpen}>Open web player <ExternalLink size={17} /></a></div>}<div className="handoff-rule"><CircleAlert /><div><strong>Playback is never inferred</strong><p>UniJam records only that this handoff was requested, opened, or explicitly confirmed by a host.</p></div></div>{canConfirm && prepared ? <button className="button button-quiet" disabled={confirmed} onClick={() => void confirm()}>{confirmed ? <><Check size={18} /> Handoff confirmed</> : "Confirm handoff opened"}</button> : null}</section></div></ProductShell>;
}
