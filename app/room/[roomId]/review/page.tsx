"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import {
  CircleAlert, ErrorPanel, LoadingPanel, PageHeader, ProductShell, RecordingArtwork,
  StatusBanner, sendRoomCommand, useRoomState, type RoomSuggestion,
} from "@/app/components/product";

function durationLabel(durationMs?: number) {
  if (durationMs === undefined) return null;
  const seconds = Math.round(durationMs / 1_000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export default function PickReviewPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const room = useRoomState(roomId);
  const [status, setStatus] = useState<{ tone: "success" | "danger"; message: string } | null>(null);
  if (room.status === "loading") return <ProductShell guest roomId={roomId}><LoadingPanel label="Loading pick review…" /></ProductShell>;
  if (room.status === "error" || !room.data) return <ProductShell guest roomId={roomId}><ErrorPanel title="Pick review unavailable" message={room.error?.message ?? "Room state could not be loaded."} onRetry={room.refresh} /></ProductShell>;

  const { actor, snapshot } = room.data;
  if (actor.role !== "host" && actor.role !== "cohost") return <ProductShell guest roomId={roomId} displayName={actor.nickname}><ErrorPanel title="Host access required" message="Only a room host or co-host can approve or reject picks." /></ProductShell>;
  const suggestions = Object.values(snapshot.suggestions).filter((item) => item.status === "pending" || item.status === "held");

  async function decide(suggestion: RoomSuggestion, action: "suggestion.approve" | "suggestion.reject") {
    setStatus(null);
    try {
      await sendRoomCommand(roomId, snapshot.seq, action, { suggestionId: suggestion.suggestionId });
      setStatus({ tone: "success", message: action.endsWith("approve") ? `${suggestion.title} was approved.` : `${suggestion.title} was rejected.` });
      room.refresh();
    } catch (cause) {
      setStatus({ tone: "danger", message: cause instanceof Error ? cause.message : "The decision was not saved." });
    }
  }

  return <ProductShell roomId={roomId} displayName={actor.nickname}>
    <PageHeader eyebrow="PICK REVIEW" title={`${suggestions.length} ${suggestions.length === 1 ? "pick" : "picks"} waiting`} description="Check the exact artist, album, version, and artwork before a pick reaches the setlist." backHref={`/room/${roomId}`} />
    {status && <StatusBanner tone={status.tone} title={status.tone === "success" ? "Decision saved" : "Decision not saved"}>{status.message}</StatusBanner>}
    {suggestions.length === 0 ? <section className="state-panel"><span className="gate-icon"><CircleAlert /></span><p className="eyebrow">ALL CLEAR</p><h1>No picks need review</h1><p>Held or host-approved picks will appear here.</p></section> : <section className="review-list">{suggestions.map((suggestion) => {
      const display = suggestion.display;
      return <article className="review-item" key={suggestion.suggestionId}>
        <div className="review-recording">
          <RecordingArtwork display={display} title={suggestion.title} className="review-artwork" size={76} />
          <div><span className={`confidence ${suggestion.status}`}>{suggestion.status === "held" ? "Needs a decision" : "Waiting"}</span><h2>{suggestion.title}</h2><p>{display?.artists.join(", ") || "Artist unavailable"}{display?.album ? ` · ${display.album}` : ""}</p><div className="review-meta">{durationLabel(display?.durationMs) && <span>{durationLabel(display?.durationMs)}</span>}{display?.explicit && <span>Explicit</span>}<span>Picked by {snapshot.participants[suggestion.submittedBy]?.nickname ?? "Former participant"}</span>{display && <a href={display.providerUrl} target="_blank" rel="noreferrer">Open on {display.provider === "spotify" ? "Spotify" : "Apple Music"}<span className="sr-only"> (opens in a new tab)</span></a>}</div></div>
        </div>
        <div><button className="button button-quiet" onClick={() => void decide(suggestion, "suggestion.reject")}>Reject</button><button className="button button-primary" onClick={() => void decide(suggestion, "suggestion.approve")}>Approve this version</button></div>
      </article>;
    })}</section>}
  </ProductShell>;
}
