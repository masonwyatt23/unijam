"use client";

import { useState, type FormEvent } from "react";
import { Brand } from "@/app/components/product";
import { Link2 } from "lucide-react";

export default function JoinPage() {
  const [error, setError] = useState("");
  function continueToInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    const raw = String(new FormData(event.currentTarget).get("invite") ?? "").trim();
    try {
      const invite = new URL(raw);
      const match = invite.pathname.match(/\/join\/([A-Z0-9]{6,16})$/i);
      const capability = new URLSearchParams(invite.hash.slice(1)).get("cap");
      if (!match || !capability) throw new Error();
      window.location.assign(`/join/${match[1].toUpperCase()}#cap=${encodeURIComponent(capability)}`);
    } catch { setError("Paste the complete guest invite from the host. A room code alone cannot authenticate you."); }
  }
  return <main className="join-page"><header><Brand /><a href="/host/sign-in">Host a room</a></header><section className="join-card"><div className="join-intro"><span className="gate-icon"><Link2 /></span><p className="eyebrow">GUEST ACCESS</p><h1>Open your invite</h1><p>The complete invite contains a private fragment that is never sent in page requests.</p></div><form onSubmit={continueToInvite}><label className="field"><span>Guest invite</span><input name="invite" inputMode="url" autoCapitalize="none" autoComplete="off" placeholder="https://unijam.ashlr.ai/join/…#cap=…" required /></label>{error && <p className="inline-error" role="alert">{error}</p>}<button className="button button-primary button-wide">Continue</button></form><p className="privacy-line">No account or provider login is required to join.</p></section></main>;
}
