"use client";

import { useState, type FormEvent } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import { CircleAlert, Headphones, Lock, LockOpen, LogOut, RefreshCw, Sparkles, Users, X } from "lucide-react";
import { CopyButton, ErrorPanel, LivingSetlist, LoadingPanel, ProductShell, ProviderBrand, SegmentedControl, StatusBanner, sendRoomCommand, useCurrentHost, useRoomState } from "@/app/components/product";
import { providerResultMessage } from "@/lib/provider-return-to";

type Provider = "spotify" | "apple-music";
type ApiEnvelope<T> = { data: T | null; error: { code: string; message: string; retryable?: boolean } | null };
type HeldCandidate = { resolutionId?: string; candidate?: { title?: string; artists?: string[]; provider?: "spotify" | "apple_music"; providerUrl?: string } };
type Resolution =
  | { status: "matched"; resolutionId: string; recordingId: string; title: string; artists: string[]; album: string | null; explicit: boolean | null; version: string; provider: Provider; providerRecordingId: string; providerUrl: string; evidence: string[] }
  | { status: "hold"; reasons: string[]; candidates: HeldCandidate[]; sourceAttribution?: { provider: "spotify"; title: string; providerUrl: string } }
  | { status: "no_match" };
type ResolutionAction = "membership" | "spotify-connection" | "switch-to-apple";

const holdLabels: Record<string, string> = {
  ambiguous_candidates: "We found a few likely versions",
  duration_mismatch: "The song lengths do not line up",
  explicit_conflict: "We found both clean and explicit versions",
  version_conflict: "We found more than one version of this song",
  edition_conflict: "We found this song on more than one release",
  storefront_unknown: "We could not confirm that this song is available in the US",
  storefront_unavailable: "This recording is not available in the US",
  source_metadata_incomplete: "This shared link does not identify one exact cross-service recording",
};

const listeningOptions = [
  { value: "spotify", label: "Spotify" },
  { value: "apple-music", label: "Apple Music" },
] as const;

function ListeningPreference({ value, onChange }: { value: Provider; onChange: (provider: Provider) => void }) {
  return <section className="listening-preference" aria-labelledby="listening-preference-title"><Headphones /><div><p className="eyebrow">YOUR LISTENING PREFERENCE</p><h2 id="listening-preference-title">Find picks where you listen</h2><p>This only chooses which catalog UniJam searches. It does not sign you in or connect a music account.</p><SegmentedControl label="Preferred music catalog" value={value} onChange={onChange} options={listeningOptions} /></div></section>;
}

function InviteControl({ roomId }: { roomId: string }) {
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);
  const [invite, setInvite] = useState("");
  const [message, setMessage] = useState("");
  const [errorCode, setErrorCode] = useState("");
  async function replaceInvite() {
    setWorking(true); setMessage(""); setErrorCode("");
    try {
      const response = await fetch(`/api/v1/rooms/${encodeURIComponent(roomId)}/invite/rotate`, { method: "POST", credentials: "include" });
      const body = await response.json() as ApiEnvelope<{ guestInvite: string }>;
      if (!response.ok || body.error || !body.data) {
        const failure = new Error(body.error?.message ?? "The invite could not be replaced.") as Error & { code?: string };
        failure.code = body.error?.code;
        throw failure;
      }
      setInvite(body.data.guestInvite); setConfirming(false); setMessage("Previous guest sessions were closed. Share only this new invite.");
    } catch (cause) {
      const failure = cause as Error & { code?: string };
      setMessage(failure instanceof Error ? failure.message : "The invite could not be replaced.");
      setErrorCode(failure.code ?? "");
    }
    finally { setWorking(false); }
  }
  if (invite) return <div className="invite-result"><code>{invite}</code><CopyButton value={invite}>Copy new invite</CopyButton><p role="status">{message}</p></div>;
  if (confirming) return <div className="invite-confirm"><p>Replacing the invite immediately closes every current guest session.</p><div><button className="button button-quiet" onClick={() => setConfirming(false)} disabled={working}>Keep current invite</button><button className="button button-primary" onClick={() => void replaceInvite()} disabled={working}>{working ? "Replacing…" : "Replace invite"}</button></div>{message && <p className="inline-error" role="alert">{message}</p>}{errorCode === "RECENT_PASSKEY_REQUIRED" ? <Link className="button button-quiet" href={`/host/sign-in?returnTo=${encodeURIComponent(`/room/${roomId}`)}`}>Confirm passkey and return</Link> : null}</div>;
  return <button className="button button-quiet" onClick={() => setConfirming(true)}><RefreshCw size={17} /> Replace invite</button>;
}

function ContributionForm({ roomId, canContribute, offerMembership, provider, onProviderChange, onStaged }: { roomId: string; canContribute: boolean; offerMembership: boolean; provider: Provider; onProviderChange: (provider: Provider) => void; onStaged: () => void }) {
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<"idle" | "working" | "success" | "error" | "hold" | "no-match" | "unsupported">("idle");
  const [message, setMessage] = useState("");
  const [heldCandidates, setHeldCandidates] = useState<HeldCandidate[]>([]);
  const [attribution, setAttribution] = useState<{ provider: Provider; title: string; url: string } | null>(null);
  const [sourceAttribution, setSourceAttribution] = useState<{ provider: "spotify"; title: string; url: string } | null>(null);
  const [membershipNudge, setMembershipNudge] = useState(false);
  const [resolutionAction, setResolutionAction] = useState<ResolutionAction | null>(null);

  async function stageResolution(match: { resolutionId: string; title: string; artists: string[]; provider: Provider; providerUrl: string }) {
    const commandResponse = await fetch(`/api/v1/rooms/${encodeURIComponent(roomId)}/commands`, {
      method: "POST", credentials: "include", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: `cmd_${crypto.randomUUID()}`,
        action: "suggestion.stage",
        payload: { suggestionId: `sug_${crypto.randomUUID()}`, resolutionId: match.resolutionId },
      }),
    });
    const commandBody = await commandResponse.json() as ApiEnvelope<unknown>;
    if (!commandResponse.ok || commandBody.error) throw new Error(commandBody.error?.message ?? "The room did not accept this pick.");
    setInput("");
    setStatus("success");
    setMessage(`${match.title} by ${match.artists.join(", ")} was added to the room.`);
    setAttribution({ provider: match.provider, title: match.title, url: match.providerUrl });
    setResolutionAction(null);
    setHeldCandidates([]);
    setSourceAttribution(null);
    if (offerMembership) {
      try {
        const key = `unijam.membership-nudge.${roomId}`;
        if (!sessionStorage.getItem(key)) { sessionStorage.setItem(key, "shown"); setMembershipNudge(true); }
      } catch { setMembershipNudge(true); }
    }
    onStaged();
  }

  async function selectHeld(candidate: HeldCandidate) {
    if (!candidate.resolutionId || !candidate.candidate?.title || !candidate.candidate.providerUrl || !candidate.candidate.provider) return;
    setStatus("working"); setMessage("");
    try {
      await stageResolution({
        resolutionId: candidate.resolutionId,
        title: candidate.candidate.title,
        artists: candidate.candidate.artists ?? [],
        provider: candidate.candidate.provider === "apple_music" ? "apple-music" : "spotify",
        providerUrl: candidate.candidate.providerUrl,
      });
    } catch (cause) {
      setStatus("error");
      setMessage(cause instanceof Error ? cause.message : "This recording could not be added.");
    }
  }

  async function contribute(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canContribute) return;
    setStatus("working"); setMessage(""); setHeldCandidates([]); setAttribution(null); setSourceAttribution(null); setResolutionAction(null);
    try {
      const resolutionResponse = await fetch(`/api/v1/rooms/${encodeURIComponent(roomId)}/resolve`, {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: input.trim(), provider }),
      });
      const resolutionBody = await resolutionResponse.json() as ApiEnvelope<Resolution>;
      if (resolutionBody.error?.code === "UNSUPPORTED_SOURCE") {
        setStatus("unsupported");
        setMessage("That link is not supported. Use a Spotify or Apple Music link, or enter a song title and artist.");
        return;
      }
      if (resolutionBody.error?.code === "LISTENER_CONNECTION_REQUIRED") {
        setStatus("error");
        setMessage("Spotify search belongs to your own account. Create or sign in to UniJam first, then connect Spotify.");
        setResolutionAction("membership");
        return;
      }
      if (resolutionBody.error?.code === "PROVIDER_NOT_CONNECTED" || resolutionBody.error?.code === "PROVIDER_RECONNECT_REQUIRED") {
        setStatus("error");
        setMessage(resolutionBody.error.code === "PROVIDER_RECONNECT_REQUIRED" ? "Spotify needs your permission again before this search." : "Connect your Spotify account before searching its catalog.");
        setResolutionAction("spotify-connection");
        return;
      }
      if (resolutionBody.error?.code === "PILOT_NOT_ALLOWED") {
        setStatus("error");
        setMessage("Spotify has not enabled this account for UniJam's current test cohort. Apple Music catalog picks still work in this room.");
        setResolutionAction("switch-to-apple");
        return;
      }
      if (!resolutionResponse.ok || resolutionBody.error || !resolutionBody.data) {
        throw new Error(resolutionBody.error?.message ?? "This contribution could not be resolved.");
      }
      if (resolutionBody.data.status === "no_match") {
        setStatus("no-match");
        setMessage("No reliable US recording matched. Check the title and artist, or paste a direct provider link.");
        return;
      }
      if (resolutionBody.data.status === "hold") {
        setStatus("hold");
        setMessage(resolutionBody.data.reasons.map((reason) => holdLabels[reason] ?? "We need a little more detail").join(". ") + ". Listen to the choices and pick the exact recording.");
        setHeldCandidates(resolutionBody.data.candidates.slice(0, 3));
        if (resolutionBody.data.sourceAttribution) {
          setSourceAttribution({ provider: "spotify", title: resolutionBody.data.sourceAttribution.title, url: resolutionBody.data.sourceAttribution.providerUrl });
        }
        return;
      }
      const match = resolutionBody.data;
      await stageResolution(match);
    } catch (cause) {
      setStatus("error");
      setMessage(cause instanceof Error ? cause.message : "This contribution could not be added.");
    }
  }

  const heldSource = heldCandidates.find(({ candidate }) => candidate?.provider && candidate.providerUrl)?.candidate;
  return <section className="contribute-card"><p className="eyebrow">ADD A SONG</p><h2>Put a song in the mix</h2><p>Paste a music link or type the song and artist. We&apos;ll find the right recording before it reaches the queue.</p><form onSubmit={(event) => void contribute(event)}><label className="field" htmlFor="song-input"><span>Song link, title, or artist</span><input id="song-input" value={input} onChange={(event) => setInput(event.target.value)} disabled={!canContribute || status === "working"} placeholder="Artist — song title" required /></label><label className="field" htmlFor="provider-select"><span>Search in</span><select id="provider-select" value={provider} onChange={(event) => { onProviderChange(event.target.value as Provider); setResolutionAction(null); }} disabled={!canContribute || status === "working"}><option value="spotify">Spotify</option><option value="apple-music">Apple Music</option></select><small>You can paste a link from either service. This setting chooses where your queue pick should be found.</small></label><button className="button button-primary" disabled={!canContribute || status === "working" || !input.trim()}>{status === "working" ? "Finding your song…" : "Find and add song"}</button></form>{message && <p className={status === "success" ? "inline-success" : status === "hold" || status === "no-match" || status === "unsupported" ? "inline-hold" : "inline-error"} role={status === "error" ? "alert" : "status"}>{message}</p>}{resolutionAction ? <aside className="membership-nudge provider-resolution-action"><Headphones /><div><strong>{resolutionAction === "membership" ? "Bring your Spotify identity" : resolutionAction === "spotify-connection" ? "Connect Spotify privately" : "Keep adding with Apple Music"}</strong><p>{resolutionAction === "membership" ? "Your room place stays guest-scoped; the passkey account only gives your Spotify authorization somewhere private to live." : resolutionAction === "spotify-connection" ? "UniJam stores this authorization for your account only. Other people in the room cannot use it." : "Choose Apple Music above to search the public US catalog without connecting an account."}</p>{resolutionAction === "membership" ? <Link href={`/host/sign-in?returnTo=${encodeURIComponent(`/room/${roomId}`)}`}>Sign in or create account</Link> : resolutionAction === "spotify-connection" ? <Link href={`/connections/spotify?returnTo=${encodeURIComponent(`/room/${roomId}`)}`}>Connect Spotify</Link> : <button type="button" className="text-button" onClick={() => { onProviderChange("apple-music"); setResolutionAction(null); }}>Switch to Apple Music</button>}</div></aside> : null}{sourceAttribution ? <div className="resolution-attribution"><span>Original shared link</span><ProviderBrand provider="spotify" background="light" purpose="attribution" href={sourceAttribution.url} label={`Open ${sourceAttribution.title} on Spotify`} /></div> : null}{attribution ? <div className="resolution-attribution">{attribution.provider === "spotify" ? <ProviderBrand provider="spotify" background="light" purpose="attribution" href={attribution.url} label={`Open ${attribution.title} on Spotify`} /> : <ProviderBrand provider="apple-music" variant="listen-badge" background="light" purpose="attribution" href={attribution.url} label={`Listen to ${attribution.title} on Apple Music`} />}</div> : null}{heldSource && !sourceAttribution ? <div className="resolution-attribution"><span>Listen before choosing</span>{heldSource.provider === "spotify" ? <ProviderBrand provider="spotify" background="light" purpose="attribution" href={heldSource.providerUrl!} label="Open a held candidate on Spotify" /> : <ProviderBrand provider="apple-music" variant="listen-badge" background="light" purpose="attribution" href={heldSource.providerUrl!} label="Listen to a held candidate on Apple Music" />}</div> : null}{heldCandidates.length > 0 && <ul className="resolution-candidates" aria-label="Possible recording matches">{heldCandidates.map((entry, index) => <li key={`${entry.candidate?.title ?? "candidate"}-${index}`}><div>{entry.candidate?.providerUrl ? <a href={entry.candidate.providerUrl} target="_blank" rel="noreferrer"><strong>{entry.candidate.title ?? "Unknown recording"}</strong><span className="sr-only"> (opens in a new tab)</span></a> : <strong>{entry.candidate?.title ?? "Unknown recording"}</strong>}<span>{entry.candidate?.artists?.join(", ") ?? "Artist unavailable"}</span></div>{entry.resolutionId ? <button className="button button-quiet" type="button" disabled={status === "working"} onClick={() => void selectHeld(entry)}>Choose this version</button> : null}</li>)}</ul>}{membershipNudge ? <aside className="membership-nudge" aria-labelledby="membership-nudge-title"><Sparkles /><div><strong id="membership-nudge-title">Keep your UniJam identity</strong><p>Your pick is in. An account can remember your name and give you a place to start your own rooms later.</p><Link href={`/host/sign-in?returnTo=${encodeURIComponent(`/room/${roomId}`)}`}>Sign in or create an account</Link></div><button type="button" className="icon-button" aria-label="Dismiss account invitation" onClick={() => setMembershipNudge(false)}><X /></button></aside> : null}<small>{canContribute ? "If we cannot identify one exact recording, nothing is added until you choose." : "This room is read-only for your current role or lifecycle."}</small></section>;
}

function RoomControls({ roomId, seq, role, ready, locked, onRefresh }: { roomId: string; seq: number; role: "host" | "cohost" | "guest"; ready: boolean | null; locked: boolean; onRefresh: () => void }) {
  const [working, setWorking] = useState<"ready" | "lock" | "end" | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: "success" | "danger"; message: string; code?: string } | null>(null);
  const canManage = role === "host" || role === "cohost";

  async function updateRoom(kind: "ready" | "lock") {
    setWorking(kind); setFeedback(null);
    try {
      if (kind === "ready" && ready !== null) {
        await sendRoomCommand(roomId, seq, "participant.ready", { ready: !ready });
        setFeedback({ tone: "success", message: ready ? "You are no longer marked ready." : "You are ready for the next cue." });
      } else {
        await sendRoomCommand(roomId, seq, "room.rules.update", { rules: { locked: !locked } });
        setFeedback({ tone: "success", message: locked ? "The room is open to current invites." : "The room is locked to new guests." });
      }
      onRefresh();
    } catch (cause) {
      setFeedback({ tone: "danger", message: cause instanceof Error ? cause.message : "The room control was not saved." });
    } finally { setWorking(null); }
  }

  async function endRoom() {
    setWorking("end"); setFeedback(null);
    try {
      const response = await fetch(`/api/v1/rooms/${encodeURIComponent(roomId)}/end`, { method: "POST", credentials: "include" });
      const body = await response.json() as ApiEnvelope<{ ended: boolean }>;
      if (!response.ok || body.error || !body.data?.ended) {
        const failure = new Error(body.error?.message ?? "The room could not be ended.") as Error & { code?: string };
        failure.code = body.error?.code;
        throw failure;
      }
      setConfirmEnd(false);
      setFeedback({ tone: "success", message: "Room ended. Guests were signed out and the recap is now final." });
      onRefresh();
    } catch (cause) {
      const failure = cause as Error & { code?: string };
      setFeedback({ tone: "danger", message: failure instanceof Error ? failure.message : "The room could not be ended.", code: failure.code });
    } finally { setWorking(null); }
  }

  return <section className="room-control-panel" aria-label="Your room controls">{ready !== null ? <div><p className="eyebrow">YOUR STATUS</p><button className={`button ${ready ? "button-primary" : "button-quiet"}`} aria-pressed={ready} disabled={working !== null} onClick={() => void updateRoom("ready")}>{ready ? "Ready for the cue" : "Mark me ready"}</button></div> : null}{canManage ? <div><p className="eyebrow">ROOM ACCESS</p><button className="button button-quiet" aria-pressed={locked} disabled={working !== null} onClick={() => void updateRoom("lock")}>{locked ? <LockOpen size={17} /> : <Lock size={17} />}{working === "lock" ? "Saving…" : locked ? "Open room" : "Lock room"}</button></div> : null}{role === "host" ? <div className="room-end-control"><p className="eyebrow">CLOSE THE NIGHT</p>{confirmEnd ? <div className="room-end-confirm"><p>End the room, close every guest session, and freeze the recap?</p><div><button className="button button-quiet" disabled={working === "end"} onClick={() => setConfirmEnd(false)}>Keep room live</button><button className="button button-danger" disabled={working === "end"} onClick={() => void endRoom()}>{working === "end" ? "Ending…" : "End room now"}</button></div></div> : <button className="button button-danger" disabled={working !== null} onClick={() => setConfirmEnd(true)}><LogOut size={17} /> End room</button>}</div> : null}{feedback ? <div className={`room-control-feedback ${feedback.tone === "danger" ? "inline-error" : "inline-success"}`} role={feedback.tone === "danger" ? "alert" : "status"}>{feedback.message}{feedback.code === "RECENT_PASSKEY_REQUIRED" ? <Link href={`/host/sign-in?returnTo=${encodeURIComponent(`/room/${roomId}`)}`}>Confirm passkey and return</Link> : null}</div> : null}</section>;
}

export default function LiveRoomPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const searchParams = useSearchParams();
  const room = useRoomState(roomId);
  const account = useCurrentHost();
  const providerResult = (() => {
    const provider = searchParams.get("provider");
    return provider === "spotify" || provider === "apple-music"
      ? providerResultMessage(provider, searchParams.get("providerResult"))
      : null;
  })();
  const [listeningPreference, setListeningPreference] = useState<Provider>(() => {
    if (typeof window === "undefined") return "spotify";
    try {
      const saved = sessionStorage.getItem(`unijam.listening-preference.${roomId}`) ?? localStorage.getItem("unijam.listening-preference");
      return saved === "apple-music" ? "apple-music" : "spotify";
    } catch { /* A preference can still be chosen for the current render. */ }
    return "spotify";
  });
  function saveListeningPreference(provider: Provider) {
    setListeningPreference(provider);
    try {
      localStorage.setItem("unijam.listening-preference", provider);
      sessionStorage.setItem(`unijam.listening-preference.${roomId}`, provider);
    } catch { /* The selection still works for this render when storage is unavailable. */ }
  }
  if (room.status === "loading") return <ProductShell guest roomId={roomId}><LoadingPanel /></ProductShell>;
  if (room.status === "error" || !room.data) return <ProductShell guest roomId={roomId}><ErrorPanel title="Room state could not be loaded" message={room.error?.message ?? "The room is unavailable."} onRetry={room.refresh} /></ProductShell>;
  const { actor, snapshot, transport } = room.data;
  const guest = actor.role === "guest" || actor.role === "viewer";
  const canHost = actor.role === "host" || actor.role === "cohost";
  const canContribute = actor.role !== "viewer" && snapshot.lifecycle === "active";
  const participants = Object.values(snapshot.participants);
  const ready = participants.filter((participant) => participant.ready).length;
  const reviewCount = Object.values(snapshot.suggestions).filter((suggestion) => suggestion.status === "pending" || suggestion.status === "held").length;
  const now = snapshot.occurrences.find((occurrence) => occurrence.status === "now");
  const transportLabel = transport === "offline" ? "offline · HTTP state retained" : transport === "reconnecting" || transport === "connecting" ? "reconnecting · HTTP fallback" : `canonical · seq ${snapshot.seq}`;
  return <ProductShell guest={guest} roomId={roomId} roomLabel={`Room ${roomId}`} displayName={actor.nickname}><div className="room-topbar"><div><span className="status-pill"><span className="live-dot" /> {snapshot.lifecycle === "active" ? "LIVE ROOM" : "ROOM ENDED"}</span><h1>Room {roomId}</h1><p>{snapshot.rules.approvalMode === "host" ? "Host approval" : "Open queue"} · {snapshot.rules.contributionLimit} picks per guest · {snapshot.rules.explicitContent === "hold" ? "explicit tracks held" : "explicit tracks allowed"}</p></div><div className="room-actions"><span className={`connection-state state-${transport}`} role="status" aria-live="polite"><span />{transportLabel}</span>{actor.role === "host" && snapshot.lifecycle === "active" ? <InviteControl roomId={roomId} /> : null}</div></div>
    {snapshot.lifecycle === "ended" && <StatusBanner tone="warning" title="This room has ended">The setlist is read-only. Open the recap to review played occurrences.</StatusBanner>}
    {providerResult && <StatusBanner tone={providerResult.tone} title={providerResult.title}>{providerResult.message}</StatusBanner>}
    <ListeningPreference value={listeningPreference} onChange={saveListeningPreference} />
    <div className="room-layout"><LivingSetlist guest={!canHost} actorId={actor.participantId} snapshot={snapshot} onRefresh={room.refresh} /><aside className="room-side">{now ? <section className="handoff-card"><Headphones /><div><p className="eyebrow">NATIVE HANDOFF</p><h2>{now.title}</h2><p>Open the exact matched recording in one service. UniJam never infers playback.</p></div><div><Link href={`/room/${roomId}/handoff/spotify`}>Spotify</Link><Link href={`/room/${roomId}/handoff/apple-music`}>Apple Music</Link></div></section> : null}<ContributionForm roomId={roomId} canContribute={canContribute} offerMembership={guest && account.status === "error"} provider={listeningPreference} onProviderChange={saveListeningPreference} onStaged={room.refresh} />
      {snapshot.lifecycle === "active" && actor.role !== "viewer" ? <RoomControls roomId={roomId} seq={snapshot.seq} role={actor.role} ready={snapshot.participants[actor.participantId]?.ready ?? null} locked={snapshot.rules.locked} onRefresh={room.refresh} /> : null}
      {canHost && <section className="room-summary"><div><Users /><span><strong>{participants.length} {participants.length === 1 ? "person" : "people"}</strong><small>{ready} ready</small></span></div><div><Lock /><span><strong>{snapshot.rules.locked ? "Room locked" : "Room open"}</strong><small>{snapshot.rules.speakerDuty === "host" ? "Host handles playback" : "Shared speaker duty"}</small></span></div><Link href={`/room/${roomId}/review`}>Review {reviewCount} {reviewCount === 1 ? "pick" : "picks"} <CircleAlert size={17} /></Link></section>}
      {guest && <section className="guest-boundary"><Lock /><div><strong>{account.data ? "Member in a guest role" : "Private guest session"}</strong><p>This session cannot open host controls or publishing. Any provider connection you add to a passkey account remains personal to you.</p></div></section>}
    </aside></div>
  </ProductShell>;
}
