"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Clock3 } from "lucide-react";

import {
  ArrowRight, Check, ErrorPanel, LoadingPanel, PageHeader, ProductShell,
  RecordingArtwork, StatusBanner, Users, useRoomState,
} from "@/app/components/product";

export default function RecapPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const room = useRoomState(roomId);
  if (room.status === "loading") return <ProductShell guest roomId={roomId}><LoadingPanel label="Building the recap…" /></ProductShell>;
  if (room.status === "error" || !room.data) return <ProductShell guest roomId={roomId}><ErrorPanel title="Recap unavailable" message={room.error?.message ?? "Room state could not be loaded."} onRetry={room.refresh} /></ProductShell>;

  const { actor, snapshot } = room.data;
  const guest = actor.role === "guest" || actor.role === "viewer";
  const canPublish = actor.role === "host";
  const played = snapshot.occurrences.filter((item) => item.status === "played");
  const voters = new Set(snapshot.occurrences.flatMap((item) => item.voterIds));

  return <ProductShell guest={guest} roomId={roomId} displayName={actor.nickname}>
    <PageHeader eyebrow="ROOM RECAP" title="The night’s set" description={`${Object.keys(snapshot.participants).length} people shaped ${played.length} ${played.length === 1 ? "song" : "songs"}.`} backHref={`/room/${roomId}`} actions={canPublish ? <Link href={`/room/${roomId}/publish`} className="button button-primary">Save the setlist <ArrowRight size={18} /></Link> : undefined} />
    {snapshot.lifecycle === "active" && <StatusBanner title="The room is still live">This recap keeps updating. End the room when the last song finishes.</StatusBanner>}
    <section className="recap-hero">
      <div className="recap-number"><span>{String(played.length).padStart(2, "0")}</span><p>songs<br />played</p></div>
      <div className="recap-summary"><p>{played.length ? "Every pick, vote, and handoff became one shared night." : "The first played song will start this story."}</p><div><span><Users /> {Object.keys(snapshot.participants).length} people</span><span><Check /> {voters.size} voters</span><span><Clock3 /> Updated {new Date(snapshot.updatedAtMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span></div></div>
    </section>
    <section className="recap-card recap-story">
      <p className="eyebrow">PLAYED ORDER</p>
      {played.length === 0 ? <div className="setlist-empty"><h3>No songs played yet</h3><p>Confirm a song when it starts, then advance it when it finishes.</p></div> : <ol>{played.map((item, index) => <li key={item.occurrenceId}>
        <span>{String(index + 1).padStart(2, "0")}</span>
        <RecordingArtwork display={item.display} title={item.title} className="recap-artwork" size={68} />
        <div className="recap-track-copy"><strong>{item.title}</strong><span>{item.display?.artists.join(", ") || "Artist unavailable"}{item.display?.album ? ` · ${item.display.album}` : ""}</span></div>
        <span className="recap-votes">{item.voterIds.length} {item.voterIds.length === 1 ? "vote" : "votes"}</span>
      </li>)}</ol>}
    </section>
  </ProductShell>;
}
