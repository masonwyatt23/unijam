"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Check, CircleAlert, ExternalLink, RotateCcw, Square } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { ErrorPanel, LoadingPanel, PageHeader, ProductShell, ProviderBrand, SegmentedControl, StatusBanner, useRoomState } from "@/app/components/product";

type Provider = "spotify" | "apple-music";
type ProviderValue = "spotify" | "apple_music";
type ApiError = { code: string; message: string; retryable?: boolean };
type Envelope<T> = { data: T | null; error: ApiError | null };
type Preview = {
  previewId: string;
  payloadFingerprint: string;
  roomRevision: number;
  provider: ProviderValue;
  destination: { kind: "new_private_playlist"; name: string; description: string };
  items: Array<{ canonicalRecordingId: string; providerRecordingId: string; position: number; itemKey: string }>;
  createdAtMs: number;
};
type Operation = {
  operationId: string;
  provider: ProviderValue;
  destinationPlaylistId: string | null;
  destinationUrl?: string | null;
  state: {
    operation?: { preview: Preview };
    phase: "confirmed" | "in_flight" | "reconcile_before_retry" | "waiting_retry" | "reconnect" | "succeeded" | "failed" | "cancelled";
    attempt: number;
    appliedItemKeys: string[];
    pendingItemKeys: string[];
    retryAtMs?: number;
    safeError?: string;
  };
  recoveryRequired: { code: "PLAYLIST_CREATION_OUTCOME_UNKNOWN" } | null;
  updatedAtMs: number;
};

const providerOptions = [
  { value: "spotify", label: "Spotify" },
  { value: "apple-music", label: "Apple Music" },
] as const;
const terminalPhases = new Set(["succeeded", "failed", "cancelled", "reconnect"]);

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "include", ...init });
  const body = await response.json() as Envelope<T>;
  if (!response.ok || body.error || !body.data) {
    const failure = new Error(body.error?.message ?? "The request failed.") as Error & { code?: string; retryable?: boolean };
    failure.code = body.error?.code; failure.retryable = body.error?.retryable;
    throw failure;
  }
  return body.data;
}

function phaseLabel(operation: Operation) {
  if (operation.recoveryRequired) return "Operator review required";
  return ({
    confirmed: "Queued", in_flight: "Publishing", reconcile_before_retry: "Checking provider outcome",
    waiting_retry: "Waiting to retry", reconnect: "Reconnect required", succeeded: "Published",
    failed: "Publishing failed", cancelled: "Cancelled",
  } as const)[operation.state.phase];
}

export default function PublishPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const room = useRoomState(roomId);
  const [provider, setProvider] = useState<Provider>("spotify");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [operationId, setOperationId] = useState<string | null>(() => typeof window === "undefined"
    ? null
    : window.sessionStorage.getItem(`unijam:publish-operation:${roomId}`));
  const [operation, setOperation] = useState<Operation | null>(null);
  const [pollVersion, setPollVersion] = useState(0);
  const [confirmation, setConfirmation] = useState(false);
  const [busy, setBusy] = useState<"preview" | "confirm" | "retry" | "cancel" | null>(null);
  const [message, setMessage] = useState("");
  const [errorCode, setErrorCode] = useState("");

  useEffect(() => {
    if (!operationId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await api<Operation>(`/api/v1/rooms/${encodeURIComponent(roomId)}/publish/operations/${encodeURIComponent(operationId)}`);
        if (stopped) return;
        setOperation(next); setMessage(""); setErrorCode("");
        setProvider(next.provider === "apple_music" ? "apple-music" : "spotify");
        setPreview((current) => current ?? next.state.operation?.preview ?? null);
        if (!terminalPhases.has(next.state.phase) && !next.recoveryRequired) timer = setTimeout(poll, 2_000);
      } catch (cause) {
        if (stopped) return;
        const failure = cause as Error & { code?: string };
        setMessage(failure instanceof Error ? failure.message : "Operation status could not be loaded.");
        if (failure.code === "OPERATION_NOT_FOUND") {
          window.sessionStorage.removeItem(`unijam:publish-operation:${roomId}`);
          setOperationId(null);
          return;
        }
        timer = setTimeout(poll, 4_000);
      }
    };
    void poll();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [operationId, pollVersion, roomId]);

  const titleByRecording = useMemo(() => new Map(room.data?.snapshot.occurrences.map((item) => [item.recordingId, item.title]) ?? []), [room.data?.snapshot.occurrences]);

  async function requestPreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy("preview"); setMessage(""); setErrorCode(""); setPreview(null); setOperation(null); setOperationId(null); setConfirmation(false);
    const data = new FormData(event.currentTarget);
    try {
      const next = await api<Preview>(`/api/v1/rooms/${encodeURIComponent(roomId)}/publish-preview`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, playlistName: data.get("playlistName"), playlistDescription: data.get("playlistDescription") }),
      });
      setPreview(next);
    } catch (cause) {
      const failure = cause as Error & { code?: string };
      setMessage(failure.message); setErrorCode(failure.code ?? "");
    } finally { setBusy(null); }
  }

  async function confirmPublish() {
    if (!preview || !confirmation) return;
    setBusy("confirm"); setMessage(""); setErrorCode("");
    try {
      const accepted = await api<{ operationId: string }>(`/api/v1/rooms/${encodeURIComponent(roomId)}/publish-confirmation`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ previewId: preview.previewId, payloadFingerprint: preview.payloadFingerprint }),
      });
      setOperationId(accepted.operationId);
      window.sessionStorage.setItem(`unijam:publish-operation:${roomId}`, accepted.operationId);
    } catch (cause) {
      const failure = cause as Error & { code?: string };
      setMessage(failure.message); setErrorCode(failure.code ?? "");
    } finally { setBusy(null); }
  }

  async function operate(action: "retry" | "cancel") {
    if (!operationId) return;
    setBusy(action); setMessage(""); setErrorCode("");
    try {
      await api<{ operationId: string }>(`/api/v1/rooms/${encodeURIComponent(roomId)}/publish/operations/${encodeURIComponent(operationId)}/${action}`, { method: "POST" });
      const next = await api<Operation>(`/api/v1/rooms/${encodeURIComponent(roomId)}/publish/operations/${encodeURIComponent(operationId)}`);
      setOperation(next);
      setPollVersion((value) => value + 1);
    } catch (cause) {
      const failure = cause as Error & { code?: string };
      setMessage(failure.message); setErrorCode(failure.code ?? "");
    } finally { setBusy(null); }
  }

  function resetDestination() {
    setPreview(null); setOperation(null); setOperationId(null); setConfirmation(false); setMessage(""); setErrorCode("");
    window.sessionStorage.removeItem(`unijam:publish-operation:${roomId}`);
  }

  if (room.status === "loading") return <ProductShell roomId={roomId}><LoadingPanel label="Preparing the room summary…" /></ProductShell>;
  if (room.status === "error" || !room.data) return <ProductShell roomId={roomId}><ErrorPanel title="Publish preview unavailable" message={room.error?.message ?? "Room state could not be loaded."} onRetry={room.refresh} /></ProductShell>;
  const { actor, snapshot } = room.data;
  if (actor.role !== "host") return <ProductShell guest roomId={roomId} displayName={actor.nickname}><ErrorPanel title="Room owner required" message="Only the passkey-authenticated room owner can confirm publishing." /></ProductShell>;
  const publishable = snapshot.occurrences.filter((item) => !["held", "skipped"].includes(item.status));
  const needsConnection = ["PROVIDER_NOT_CONNECTED", "PROVIDER_RECONNECT_REQUIRED", "RECENT_PASSKEY_REQUIRED"].includes(errorCode);

  return <ProductShell roomId={roomId} displayName={actor.nickname}><PageHeader eyebrow="PUBLISH" title={`Publish room ${roomId}`} description="Create one new private playlist at a time. Each service succeeds, fails, retries, or cancels independently." backHref={`/room/${roomId}/recap`} />
    {snapshot.lifecycle === "active" ? <StatusBanner tone="warning" title="Room still active">The immutable preview uses canonical sequence {snapshot.seq}. Any later queue change requires a new preview.</StatusBanner> : null}
    {message ? <StatusBanner tone="danger" title="Destination needs attention">{message}</StatusBanner> : null}
    {needsConnection ? <StatusBanner tone="warning" title="Security or connection action required" action={<Link className="button button-quiet" href={errorCode === "RECENT_PASSKEY_REQUIRED" ? "/host/sign-in" : "/connections"}>Open {errorCode === "RECENT_PASSKEY_REQUIRED" ? "passkey sign-in" : "connections"}</Link>}>Complete this action, then request a fresh immutable preview.</StatusBanner> : null}
    {operation?.state.phase === "succeeded" && !operation.destinationUrl ? <StatusBanner tone="success" title="Private playlist created">This service did not return a shareable URL. Open your library in {provider === "spotify" ? "Spotify" : "Apple Music"} to find the new playlist.</StatusBanner> : null}

    {!preview && !operationId ? <form className="form-card publish-setup" onSubmit={(event) => void requestPreview(event)}><div className="form-section"><span className="form-index">01</span><div><h2>Choose one destination</h2><p>Provider branding appears only after a real provider response supplies a licensed destination.</p><SegmentedControl label="Publish destination" value={provider} onChange={setProvider} options={providerOptions} /></div></div><div className="form-section"><span className="form-index">02</span><div><h2>Name the private playlist</h2><div className="field-grid"><label className="field"><span>Playlist name</span><input name="playlistName" maxLength={100} defaultValue={`UniJam ${roomId}`} required /></label><label className="field"><span>Description</span><input name="playlistDescription" maxLength={300} defaultValue="Created from a live UniJam room" /></label></div></div></div><div className="form-actions"><span>{publishable.length} canonical {publishable.length === 1 ? "recording" : "recordings"}</span><button className="button button-primary" disabled={busy === "preview" || publishable.length === 0}>{busy === "preview" ? "Building preview…" : "Review immutable preview"}</button></div></form> : null}

    {operationId && !preview ? <div className="publish-operation" aria-live="polite"><span className="state-spinner" /><p>Restoring the immutable destination…</p></div> : null}
    {preview ? <section className="publish-preview"><div className="preview-title"><div><p className="eyebrow">IMMUTABLE DESTINATION</p><h2>{preview.destination.name}</h2><p>New private {preview.provider === "spotify" ? "Spotify" : "Apple Music"} playlist · room sequence {preview.roomRevision}</p><small>{preview.destination.description}</small></div><span className="immutable"><Check /> Fingerprint locked</span></div><ol className="compact-tracklist">{preview.items.map((item) => <li key={item.itemKey}><span>{String(item.position + 1).padStart(2, "0")}</span><strong>{titleByRecording.get(item.canonicalRecordingId) ?? item.canonicalRecordingId}</strong><small>{item.providerRecordingId}</small></li>)}</ol>
      {!operationId ? <div className="publish-confirm"><label><input type="checkbox" checked={confirmation} onChange={(event) => setConfirmation(event.target.checked)} /><span><strong>Create this exact private playlist</strong><small>I confirm the service, title, description, order, and {preview.items.length} matched recordings.</small></span></label><div><button className="button button-quiet" onClick={resetDestination} type="button">Discard preview</button><button className="button button-primary" disabled={!confirmation || busy === "confirm"} onClick={() => void confirmPublish()}>{busy === "confirm" ? "Confirming…" : "Confirm and publish"}</button></div></div> : null}
      {operation ? <div className={`publish-operation phase-${operation.state.phase}`} aria-live="polite"><div><p className="eyebrow">DESTINATION STATUS</p><h3>{phaseLabel(operation)}</h3><p>{operation.state.appliedItemKeys.length} applied · {operation.state.pendingItemKeys.length} pending · attempt {operation.state.attempt}</p>{operation.state.safeError ? <p>{operation.state.safeError}</p> : null}{operation.recoveryRequired ? <p>UniJam will not retry an ambiguous playlist creation. An operator must reconcile the provider before this destination can continue.</p> : null}</div><div className="publish-operation-actions">{operation.state.phase === "succeeded" && operation.destinationUrl ? provider === "spotify" ? <ProviderBrand provider="spotify" background="light" purpose="published" href={operation.destinationUrl} label={`Open ${preview.destination.name} on Spotify`} /> : <ProviderBrand provider="apple-music" variant="listen-badge" background="light" purpose="published" href={operation.destinationUrl} label={`Open ${preview.destination.name} on Apple Music`} /> : null}{operation.state.phase === "succeeded" && operation.destinationUrl ? <a className="button button-quiet" href={operation.destinationUrl} target="_blank" rel="noreferrer">Open playlist <ExternalLink size={17} /></a> : null}{["failed", "reconnect", "waiting_retry"].includes(operation.state.phase) && !operation.recoveryRequired ? <button className="button button-primary" disabled={busy === "retry"} onClick={() => void operate("retry")}><RotateCcw size={17} /> {busy === "retry" ? "Retrying…" : "Retry destination"}</button> : null}{!["succeeded", "cancelled"].includes(operation.state.phase) ? <button className="button button-quiet" disabled={busy === "cancel" || operation.state.phase === "in_flight"} onClick={() => void operate("cancel")}><Square size={15} /> {busy === "cancel" ? "Cancelling…" : "Cancel destination"}</button> : null}{terminalPhases.has(operation.state.phase) ? <button className="button button-quiet" onClick={resetDestination}>Publish another service</button> : null}</div></div> : operationId ? <div className="publish-operation" aria-live="polite"><span className="state-spinner" /><p>Queueing the destination…</p></div> : null}
    </section> : null}
    {publishable.length === 0 ? <section className="setlist-empty"><CircleAlert /><h3>Nothing to publish</h3><p>Play or stage a resolved occurrence before creating a destination preview.</p></section> : null}
  </ProductShell>;
}
