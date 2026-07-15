"use client";

import { startRegistration } from "@simplewebauthn/browser";
import { useState } from "react";
import Link from "next/link";
import { ArrowRight, KeyRound, Plus, Radio } from "lucide-react";
import { ErrorPanel, LoadingPanel, PageHeader, ProductShell, useCurrentHost } from "@/app/components/product";

type Envelope<T> = { data: T | null; error: { message?: string } | null };

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
  return <ProductShell displayName={host.data.displayName}><PageHeader eyebrow="HOST WORKSPACE" title={`Welcome, ${host.data.displayName}`} description="Create a room and keep its one-time guest invite safe. Room history will appear here when the registry list endpoint is available." actions={<Link href="/rooms/new" className="button button-primary"><Plus size={19} /> Create room</Link>} />
    {host.data.recoveryEnrollmentAvailable && <section className="recovery-passkey-callout" aria-labelledby="recovery-passkey-title"><KeyRound /><div><p className="eyebrow">RECOVERY SESSION</p><h2 id="recovery-passkey-title">Add a passkey now</h2><p>Recovery access cannot manage providers or destructive room actions. The server’s single-use recovery enrollment grant expires after 15 minutes.</p>{passkeyMessage && <p className={passkeyState === "error" ? "inline-error" : "inline-success"} role={passkeyState === "error" ? "alert" : "status"}>{passkeyMessage}</p>}</div><button className="button button-primary" disabled={passkeyState === "working" || passkeyState === "success"} onClick={() => void addPasskey()}>{passkeyState === "working" ? "Waiting for your device…" : passkeyState === "success" ? "Passkey added" : "Add a passkey"}</button></section>}
    {!host.data.recentPasskey && !host.data.recoveryEnrollmentAvailable && <section className="security-note"><KeyRound /><div><strong>Recent passkey confirmation required</strong><p>Sign in again before connecting providers, publishing, rotating invites, or ending rooms.</p></div><Link href="/host/sign-in">Confirm passkey <ArrowRight size={16} /></Link></section>}
    <section className="workspace-grid"><Link href="/rooms/new" className="room-card empty-room-card"><Plus /><strong>Start a room</strong><span>Create an authoritative room with default rules, then share its private invite.</span></Link><section className="room-card honest-empty"><Radio /><h2>No room list yet</h2><p>The current v1 API does not expose a host room index. UniJam will not invent room history on this screen.</p></section></section>
    <section className="security-note"><KeyRound /><div><strong>Passkey protected</strong><p>{host.data.recentPasskey ? "Your passkey was confirmed recently." : "Sensitive provider and destructive actions remain unavailable until a passkey is enrolled and verified."}</p></div><Link href="/rooms/new">Create a room <ArrowRight size={16} /></Link></section>
  </ProductShell>;
}
