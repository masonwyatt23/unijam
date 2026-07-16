"use client";

import { startRegistration } from "@simplewebauthn/browser";
import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Clock3, KeyRound, Plus, Radio, Users } from "lucide-react";
import { ErrorPanel, LoadingPanel, PageHeader, ProductShell, useCurrentHost } from "@/app/components/product";

type Envelope<T> = { data: T | null; error: { message?: string } | null };
type HostRoom = { roomId: string; lifecycle: "active" | "ended"; inviteEpoch: number; createdAtMs: number; updatedAtMs: number; endedAtMs: number | null };
type JoinedRoom = { roomId: string; nickname: string; lifecycle: "active" | "ended"; joinedAtMs: number; lastJoinedAtMs: number; endedAtMs: number | null };

function HostRoomIndex() {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [rooms, setRooms] = useState<HostRoom[]>([]);
  const [message, setMessage] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/v1/rooms", { credentials: "include", cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as Envelope<{ rooms: HostRoom[] }>;
        if (!response.ok || body.error || !body.data) throw new Error(body.error?.message ?? "Rooms could not be loaded.");
        setRooms(body.data.rooms); setState("ready");
      })
      .catch((cause: Error | DOMException) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setMessage(cause instanceof Error ? cause.message : "Rooms could not be loaded."); setState("error");
      });
    return () => controller.abort();
  }, [attempt]);
  if (state === "loading") return <section className="room-card honest-empty" aria-busy="true"><span className="state-spinner" /><h2>Loading rooms</h2><p>Reading your room registry…</p></section>;
  if (state === "error") return <section className="room-card honest-empty" role="alert"><Radio /><h2>Room history unavailable</h2><p>{message}</p><button className="button button-quiet" onClick={() => { setState("loading"); setAttempt((value) => value + 1); }}>Retry room history</button></section>;
  if (rooms.length === 0) return <section className="room-card honest-empty"><Radio /><h2>No rooms yet</h2><p>Create your first room, copy its private invite, and start the setlist.</p></section>;
  return <section className="host-room-index" aria-labelledby="room-index-title"><div className="host-room-index-heading"><div><p className="eyebrow">YOUR ROOMS</p><h2 id="room-index-title">Return to the room</h2></div><span>{rooms.length} recent</span></div><div className="host-room-list">{rooms.map((room) => <Link key={room.roomId} href={room.lifecycle === "active" ? `/room/${room.roomId}` : `/room/${room.roomId}/recap`} className="host-room-row"><span className={`room-state-dot ${room.lifecycle}`} /><div><strong>Room {room.roomId}</strong><small>{room.lifecycle === "active" ? `Live · invite version ${room.inviteEpoch}` : `Ended ${room.endedAtMs ? new Date(room.endedAtMs).toLocaleDateString() : ""}`}</small></div><span><Clock3 /> Updated {new Date(room.updatedAtMs).toLocaleDateString()}</span><ArrowRight /></Link>)}</div></section>;
}

function JoinedRoomIndex() {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [rooms, setRooms] = useState<JoinedRoom[]>([]);
  const [message, setMessage] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/v1/rooms/joined", { credentials: "include", cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as Envelope<{ rooms: JoinedRoom[] }>;
        if (!response.ok || body.error || !body.data) throw new Error(body.error?.message ?? "Joined rooms could not be loaded.");
        setRooms(body.data.rooms); setState("ready");
      })
      .catch((cause: Error | DOMException) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setMessage(cause instanceof Error ? cause.message : "Joined rooms could not be loaded."); setState("error");
      });
    return () => controller.abort();
  }, [attempt]);
  if (state === "loading") return <section className="room-card honest-empty" aria-busy="true"><span className="state-spinner" /><h2>Loading joined rooms</h2><p>Finding rooms tied to your account…</p></section>;
  if (state === "error") return <section className="room-card honest-empty" role="alert"><Users /><h2>Joined rooms unavailable</h2><p>{message}</p><button className="button button-quiet" onClick={() => { setState("loading"); setAttempt((value) => value + 1); }}>Retry joined rooms</button></section>;
  if (rooms.length === 0) return <section className="room-card honest-empty"><Users /><h2>No joined rooms yet</h2><p>Open a friend&apos;s private invite while signed in and UniJam will remember the room here.</p></section>;
  return <section className="host-room-index" aria-labelledby="joined-room-index-title"><div className="host-room-index-heading"><div><p className="eyebrow">ROOM HISTORY</p><h2 id="joined-room-index-title">Previously joined</h2></div><span>{rooms.length} recent</span></div><div className="host-room-list">{rooms.map((room) => <article key={room.roomId} className="host-room-row joined-room-history-row"><span className={`room-state-dot ${room.lifecycle}`} /><div><strong>Room {room.roomId}</strong><small>{room.lifecycle === "active" ? `Joined as ${room.nickname} · use the current invite to rejoin` : "Room ended · only the host can reopen its recap"}</small></div><span><Clock3 /> Visited {new Date(room.lastJoinedAtMs).toLocaleDateString()}</span></article>)}</div></section>;
}

export default function HostWorkspacePage() {
  const host = useCurrentHost();
  const [passkeyState, setPasskeyState] = useState<"idle" | "working" | "success" | "error">("idle");
  const [passkeyMessage, setPasskeyMessage] = useState("");

  async function addPasskey() {
    if (!host.data) return;
    setPasskeyState("working"); setPasskeyMessage("");
    try {
      const optionsResponse = await fetch("/api/v1/auth/passkeys/additional/options", {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ userName: host.data.displayName }),
      });
      const optionsBody = await optionsResponse.json() as Envelope<{
        options: Parameters<typeof startRegistration>[0]["optionsJSON"];
      }>;
      if (!optionsResponse.ok || optionsBody.error || !optionsBody.data) {
        throw new Error(optionsBody.error?.message ?? "A new passkey could not be started.");
      }
      const credential = await startRegistration({ optionsJSON: optionsBody.data.options });
      const verificationResponse = await fetch("/api/v1/auth/passkeys/additional/verify", {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ response: credential }),
      });
      const verificationBody = await verificationResponse.json() as Envelope<unknown>;
      if (!verificationResponse.ok || verificationBody.error) {
        throw new Error(verificationBody.error?.message ?? "The new passkey could not be verified.");
      }
      setPasskeyState("success");
      setPasskeyMessage("Your new passkey is ready. Sensitive actions remain server-gated by recent passkey verification.");
      host.refresh();
    } catch (cause) {
      setPasskeyState("error");
      setPasskeyMessage(cause instanceof Error ? cause.message : "The new passkey could not be added.");
    }
  }

  if (host.status === "loading") return <ProductShell><LoadingPanel label="Loading your workspace…" /></ProductShell>;
  if (host.status === "error" || !host.data) return <ProductShell><ErrorPanel title="Host session required" message={host.error?.message ?? "Sign in with a passkey to open the host workspace."} onRetry={host.refresh} /></ProductShell>;
  return <ProductShell displayName={host.data.displayName}><PageHeader eyebrow="HOST WORKSPACE" title={`Welcome, ${host.data.displayName}`} description="Create a room, return to an active setlist, or open an ended room’s recap." actions={<Link href="/rooms/new" className="button button-primary"><Plus size={19} /> Create room</Link>} />
    {host.data.recoveryEnrollmentAvailable && <section className="recovery-passkey-callout" aria-labelledby="recovery-passkey-title"><KeyRound /><div><p className="eyebrow">RECOVERY SESSION</p><h2 id="recovery-passkey-title">Add a passkey now</h2><p>Recovery access cannot manage providers or destructive room actions. The server’s single-use recovery enrollment grant expires after 15 minutes.</p>{passkeyMessage && <p className={passkeyState === "error" ? "inline-error" : "inline-success"} role={passkeyState === "error" ? "alert" : "status"}>{passkeyMessage}</p>}</div><button className="button button-primary" disabled={passkeyState === "working" || passkeyState === "success"} onClick={() => void addPasskey()}>{passkeyState === "working" ? "Waiting for your device…" : passkeyState === "success" ? "Passkey added" : "Add a passkey"}</button></section>}
    {host.data.recentPasskey && !host.data.recoveryEnrollmentAvailable && <section className="security-note"><KeyRound /><div><strong>Add your own backup passkey</strong><p>Register another device or hardware key for this account. Cofounders should use separate pilot invites and accounts, never a shared passkey.</p>{passkeyMessage && <p className={passkeyState === "error" ? "inline-error" : "inline-success"} role={passkeyState === "error" ? "alert" : "status"}>{passkeyMessage}</p>}</div><button className="button button-quiet" disabled={passkeyState === "working" || passkeyState === "success"} onClick={() => void addPasskey()}>{passkeyState === "working" ? "Waiting for your device…" : passkeyState === "success" ? "Passkey added" : "Add another passkey"}</button></section>}
    {!host.data.recentPasskey && !host.data.recoveryEnrollmentAvailable && <section className="security-note"><KeyRound /><div><strong>Recent passkey confirmation required</strong><p>Sign in again before connecting providers, publishing, rotating invites, or ending rooms.</p></div><Link href="/host/sign-in">Confirm passkey <ArrowRight size={16} /></Link></section>}
    <section className="workspace-grid"><Link href="/rooms/new" className="room-card empty-room-card"><Plus /><strong>Start a room</strong><span>Create an authoritative room with your rules, then share its private invite.</span></Link><HostRoomIndex /><JoinedRoomIndex /></section>
    <section className="security-note"><KeyRound /><div><strong>Passkey protected</strong><p>{host.data.recentPasskey ? "Your passkey was confirmed recently." : "Sensitive provider and destructive actions remain unavailable until a passkey is enrolled and verified."}</p></div><Link href="/rooms/new">Create a room <ArrowRight size={16} /></Link></section>
  </ProductShell>;
}
