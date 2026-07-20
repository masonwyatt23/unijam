"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowRight, CopyButton, ErrorPanel, LoadingPanel, PageHeader, ProductShell, SegmentedControl, ShareButton, useCurrentHost } from "@/app/components/product";
import { hostSignInPath } from "@/lib/host-return-to";

type Approval = "host" | "open";
type ExplicitRule = "allow" | "hold";
type CreatedRoom = { roomId: string; roomUrl: string; guestInvite: string };
type CreateFailure = { code?: string; message: string };

export default function CreateRoomPage() {
  const host = useCurrentHost();
  const [approval, setApproval] = useState<Approval>("host");
  const [explicitRule, setExplicitRule] = useState<ExplicitRule>("hold");
  const [saving, setSaving] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const [error, setError] = useState<CreateFailure | null>(null);
  const [created, setCreated] = useState<CreatedRoom | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!host.data) return;
    setSaving(true); setError(null);
    const data = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/v1/rooms", {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ rules: customizing
          ? { contributionLimit: Number(data.get("limit")), approvalMode: approval, explicitContent: explicitRule, versionPreference: data.get("version") }
          : { contributionLimit: 3, approvalMode: "host", explicitContent: "hold", versionPreference: "original" } }),
      });
      const body = await response.json() as { data?: CreatedRoom; error?: { code?: string; message?: string } };
      if (!response.ok || !body.data) {
        setError({ code: body.error?.code, message: body.error?.message ?? "The room could not be created." });
        return;
      }
      setCreated(body.data);
    } catch { setError({ message: "The room service could not be reached. Try again." }); }
    finally { setSaving(false); }
  }
  if (host.status === "loading") return <ProductShell><LoadingPanel label="Checking room access…" /></ProductShell>;
  if (host.status === "error" || !host.data) {
    const unauthenticated = host.error?.code === "UNAUTHENTICATED";
    return <ProductShell><ErrorPanel
      title={unauthenticated ? "Sign in to create a room" : "Room access could not be checked"}
      message={unauthenticated ? "A passkey account is required to own and manage a UniJam room." : host.error?.message ?? "Your account status is temporarily unavailable."}
      onRetry={unauthenticated ? undefined : host.refresh}
      action={unauthenticated ? <Link className="button button-primary" href={hostSignInPath("/rooms/new")}>Sign in or create an account</Link> : undefined}
    /></ProductShell>;
  }
  if (created) return <ProductShell roomId={created.roomId} displayName={host.data.displayName}><PageHeader eyebrow="ROOM CREATED" title={`Room ${created.roomId}`} description="Share this private invite now, then enter the room. UniJam shows the current invite only once." backHref="/host" /><section className="created-room-card"><p className="eyebrow">PRIVATE GUEST INVITE</p><code>{created.guestInvite}</code><div><ShareButton value={created.guestInvite}>Share guest invite</ShareButton><CopyButton value={created.guestInvite}>Copy guest invite</CopyButton><Link href={`/room/${created.roomId}`} className="button button-ink">Enter room <ArrowRight size={18} /></Link></div><small>The private capability stays after # in the link. Browsers do not send that fragment to UniJam; a guest exchanges it once for a secure room cookie.</small></section></ProductShell>;
  return <ProductShell displayName={host.data.displayName}><PageHeader eyebrow="NEW ROOM" title="Start a room" description="Use the recommended setup and be ready to share in one tap, or customize how songs enter the queue." backHref="/host" />
    <form className="form-card" onSubmit={(event) => void submit(event)}>
      {!customizing ? <section className="quick-start-card" aria-labelledby="quick-start-title"><div><p className="eyebrow">RECOMMENDED</p><h2 id="quick-start-title">A smooth first jam</h2><p>Three picks per guest. You approve songs. Explicit tracks pause for review. Original releases are preferred.</p></div><ul aria-label="Recommended room settings"><li>3 picks each</li><li>Host approval</li><li>Explicit songs held</li><li>Original versions</li></ul></section> : <><div className="form-section"><span className="form-index">01</span><div><h2>Choose how picks land</h2><label className="control-label">Approval</label><SegmentedControl label="Approval mode" value={approval} onChange={setApproval} options={[{ value: "host", label: "Host approves" }, { value: "open", label: "Add immediately" }]} /><div className="field-grid"><label className="field"><span>Picks per guest</span><select name="limit" defaultValue="3"><option value="1">1 pick</option><option value="2">2 picks</option><option value="3">3 picks</option><option value="5">5 picks</option></select></label><label className="field"><span>Version preference</span><select name="version" defaultValue="original"><option value="original">Original releases</option><option value="any">No preference</option></select></label></div></div></div><div className="form-section"><span className="form-index">02</span><div><h2>Handle explicit tracks</h2><SegmentedControl label="Explicit-content rule" value={explicitRule} onChange={setExplicitRule} options={[{ value: "hold", label: "Hold for review" }, { value: "allow", label: "Allow" }]} /></div></div></>}
      {error && <div className="form-error" role="alert"><p>{error.message}</p>{error.code === "UNAUTHENTICATED" ? <Link href={hostSignInPath("/rooms/new")}>Sign in again and return</Link> : null}</div>}
      <div className="form-actions"><Link href="/host" className="button button-quiet">Cancel</Link><button type="button" className="button button-quiet" onClick={() => setCustomizing((value) => !value)}>{customizing ? "Use recommended" : "Customize"}</button><button className="button button-primary" disabled={saving}>{saving ? "Creating room…" : <>{customizing ? "Create room" : "Start with recommended settings"} <ArrowRight size={19} /></>}</button></div>
    </form>
  </ProductShell>;
}
