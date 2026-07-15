"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowRight, CopyButton, PageHeader, ProductShell, SegmentedControl } from "@/app/components/product";

type Approval = "host" | "open";
type ExplicitRule = "allow" | "hold";
type CreatedRoom = { roomId: string; roomUrl: string; guestInvite: string };

export default function CreateRoomPage() {
  const [approval, setApproval] = useState<Approval>("host");
  const [explicitRule, setExplicitRule] = useState<ExplicitRule>("hold");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<CreatedRoom | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError("");
    const data = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/v1/rooms", {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ rules: { contributionLimit: Number(data.get("limit")), approvalMode: approval, explicitContent: explicitRule, versionPreference: data.get("version") } }),
      });
      const body = await response.json() as { data?: CreatedRoom; error?: { message?: string } };
      if (!response.ok || !body.data) throw new Error(body.error?.message ?? "The room could not be created.");
      setCreated(body.data);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The room could not be created."); }
    finally { setSaving(false); }
  }
  if (created) return <ProductShell roomId={created.roomId}><PageHeader eyebrow="ROOM CREATED" title={`Room ${created.roomId}`} description="This is the only copy of the current guest invite shown by the v1 API. Copy it before entering the room." backHref="/host" /><section className="created-room-card"><p className="eyebrow">PRIVATE GUEST INVITE</p><code>{created.guestInvite}</code><div><CopyButton value={created.guestInvite}>Copy guest invite</CopyButton><Link href={`/room/${created.roomId}`} className="button button-primary">Enter room <ArrowRight size={18} /></Link></div><small>The capability stays in the URL fragment and is exchanged for a secure room cookie when a guest joins.</small></section></ProductShell>;
  return <ProductShell><PageHeader eyebrow="NEW ROOM" title="Set the room rules" description="The current room authority supports these rules. A display name and occasion are not stored yet, so this room is identified by its generated code." backHref="/host" />
    <form className="form-card" onSubmit={(event) => void submit(event)}><div className="form-section"><span className="form-index">01</span><div><h2>Choose how picks land</h2><label className="control-label">Approval</label><SegmentedControl label="Approval mode" value={approval} onChange={setApproval} options={[{ value: "host", label: "Host approves" }, { value: "open", label: "Add immediately" }]} /><div className="field-grid"><label className="field"><span>Picks per guest</span><select name="limit" defaultValue="3"><option value="1">1 pick</option><option value="2">2 picks</option><option value="3">3 picks</option><option value="5">5 picks</option></select></label><label className="field"><span>Version preference</span><select name="version" defaultValue="original"><option value="original">Original releases</option><option value="any">No preference</option></select></label></div></div></div><div className="form-section"><span className="form-index">02</span><div><h2>Handle explicit tracks</h2><SegmentedControl label="Explicit-content rule" value={explicitRule} onChange={setExplicitRule} options={[{ value: "hold", label: "Hold for review" }, { value: "allow", label: "Allow" }]} /></div></div>{error && <p className="form-error" role="alert">{error}</p>}<div className="form-actions"><Link href="/host" className="button button-quiet">Cancel</Link><button className="button button-primary" disabled={saving}>{saving ? "Creating room…" : <>Create room <ArrowRight size={19} /></>}</button></div></form>
  </ProductShell>;
}
