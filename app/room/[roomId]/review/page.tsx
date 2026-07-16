"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { CircleAlert, ErrorPanel, LoadingPanel, PageHeader, ProductShell, StatusBanner, sendRoomCommand, useRoomState, type RoomSuggestion } from "@/app/components/product";

export default function PickReviewPage() {
  const { roomId } = useParams<{ roomId: string }>(); const room = useRoomState(roomId);
  const [status, setStatus] = useState<{ tone: "success" | "danger"; message: string } | null>(null);
  if (room.status === "loading") return <ProductShell guest roomId={roomId}><LoadingPanel label="Loading pick review…" /></ProductShell>;
  if (room.status === "error" || !room.data) return <ProductShell guest roomId={roomId}><ErrorPanel title="Pick review unavailable" message={room.error?.message ?? "Room state could not be loaded."} onRetry={room.refresh} /></ProductShell>;
  const { actor, snapshot } = room.data;
  if (actor.role !== "host" && actor.role !== "cohost") return <ProductShell guest roomId={roomId} displayName={actor.nickname}><ErrorPanel title="Host access required" message="Only a room host or co-host can approve or reject picks." /></ProductShell>;
  const suggestions = Object.values(snapshot.suggestions).filter((item) => item.status === "pending" || item.status === "held");
  async function decide(suggestion: RoomSuggestion, action: "suggestion.approve" | "suggestion.reject") {
    setStatus(null);
    try { await sendRoomCommand(roomId, snapshot.seq, action, { suggestionId: suggestion.suggestionId }); setStatus({ tone: "success", message: action.endsWith("approve") ? `${suggestion.title} was approved.` : `${suggestion.title} was rejected.` }); room.refresh(); }
    catch (cause) { setStatus({ tone: "danger", message: cause instanceof Error ? cause.message : "The decision was not saved." }); }
  }
  return <ProductShell roomId={roomId} displayName={actor.nickname}><PageHeader eyebrow="PICK REVIEW" title={`${suggestions.length} ${suggestions.length === 1 ? "pick" : "picks"} waiting`} description="Approve or reject only the resolved suggestions returned by the room authority." backHref={`/room/${roomId}`} />{status && <StatusBanner tone={status.tone} title={status.tone === "success" ? "Decision saved" : "Decision not saved"}>{status.message}</StatusBanner>}{suggestions.length === 0 ? <section className="state-panel"><span className="gate-icon"><CircleAlert /></span><p className="eyebrow">ALL CLEAR</p><h1>No picks need review</h1><p>Pending and held suggestions will appear here with their stable IDs.</p></section> : <section className="review-list">{suggestions.map((suggestion) => <article className="review-item" key={suggestion.suggestionId}><div><span className={`confidence ${suggestion.status}`}>{suggestion.status}</span><h2>{suggestion.title}</h2><p><code>{suggestion.recordingId}</code> · submitted by {snapshot.participants[suggestion.submittedBy]?.nickname ?? "Former participant"}</p></div><div><button className="button button-quiet" onClick={() => void decide(suggestion, "suggestion.reject")}>Reject</button><button className="button button-primary" onClick={() => void decide(suggestion, "suggestion.approve")}>Approve</button></div></article>)}</section>}</ProductShell>;
}
