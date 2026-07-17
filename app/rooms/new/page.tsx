"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowRight, CopyButton, ErrorPanel, LoadingPanel, PageHeader, ProductShell, SegmentedControl, useCurrentHost } from "@/app/components/product";
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
        body: JSON.stringify({ rules: { contributionLimit: Number(data.get("limit")), approvalMode: approval, explicitContent: explicitRule, versionPreference: data.get("version") } }),
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
  if (created) return <ProductShell roomId={created.roomId} displayName={host.data.displayName}><PageHeader eyebrow="ROOM CREATED" title={`Room ${created.roomId}`} description="This is the only copy of the current guest invite shown by the v1 API. Copy it before entering the room." backHref="/host" /><section className="created-room-card"><p className="eyebrow">PRIVATE GUEST INVITE</p><code>{created.guestInvite}</code><div><CopyButton value={created.guestInvite}>Copy guest invite</CopyButton><Link href={`/room/${created.roomId}`} className="button button-primary">Enter room <ArrowRight size={18} /></Link></div><small>The capability stays in the URL fragment and is exchanged for a secure room cookie when a guest joins.</small></section></ProductShell>;
  return <ProductShell displayName={host.data.displayName}><PageHeader eyebrow="NEW ROOM" title="Set the room rules" description="The current room authority supports these rules. A display name and occasion are not stored yet, so this room is identified by its generated code." backHref="/host" />
    <form className="form-card" onSubmit={(event) => void submit(event)}><div className="form-section"><span className="form-index">01</span><div><h2>Choose how picks land</h2><label className="control-label">Approval</label><SegmentedControl label="Approval mode" value={approval} onChange={setApproval} options={[{ value: "host", label: "Host approves" }, { value: "open", label: "Add immediately" }]} /><div className="field-grid"><label className="field"><span>Picks per guest</span><select name="limit" defaultValue="3"><option value="1">1 pick</option><option value="2">2 picks</option><option value="3">3 picks</option><option value="5">5 picks</option></select></label><label className="field"><span>Version preference</span><select name="version" defaultValue="original"><option value="original">Original releases</option><option value="any">No preference</option></select></label></div></div></div><div className="form-section"><span className="form-index">02</span><div><h2>Handle explicit tracks</h2><SegmentedControl label="Explicit-content rule" value={explicitRule} onChange={setExplicitRule} options={[{ value: "hold", label: "Hold for review" }, { value: "allow", label: "Allow" }]} /></div></div>{error && <div className="form-error" role="alert"><p>{error.message}</p>{error.code === "UNAUTHENTICATED" ? <Link href={hostSignInPath("/rooms/new")}>Sign in again and return</Link> : null}</div>}<div className="form-actions"><Link href="/host" className="button button-quiet">Cancel</Link><button className="button button-primary" disabled={saving}>{saving ? "Creating room…" : <>Create room <ArrowRight size={19} /></>}</button></div></form>
  </ProductShell>;
}
