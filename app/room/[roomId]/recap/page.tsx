"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { Clock3 } from "lucide-react";
import { ArrowRight, Check, ErrorPanel, LoadingPanel, PageHeader, ProductShell, StatusBanner, Users, useRoomState } from "@/app/components/product";

export default function RecapPage() {
  const { roomId } = useParams<{ roomId: string }>(); const room = useRoomState(roomId);
  if (room.status === "loading") return <ProductShell roomId={roomId}><LoadingPanel label="Building the recap…" /></ProductShell>;
  if (room.status === "error" || !room.data) return <ProductShell roomId={roomId}><ErrorPanel title="Recap unavailable" message={room.error?.message ?? "Room state could not be loaded."} onRetry={room.refresh} /></ProductShell>;
  const { actor, snapshot } = room.data;
  const guest = actor.role === "guest" || actor.role === "viewer";
  // Publishing uses the owner's provider connections and therefore remains an
  // owner-only action even when a co-host can manage the live setlist.
  const canPublish = actor.role === "host";
  const played = snapshot.occurrences.filter((item) => item.status === "played");
  const voters = new Set(snapshot.occurrences.flatMap((item) => item.voterIds));
  return <ProductShell guest={guest} roomId={roomId} displayName={actor.nickname}><PageHeader eyebrow="ROOM RECAP" title={`Room ${roomId}`} description={`${Object.keys(snapshot.participants).length} participants · ${played.length} played occurrences · sequence ${snapshot.seq}`} backHref={`/room/${roomId}`} actions={canPublish ? <Link href={`/room/${roomId}/publish`} className="button button-primary">Review publishing <ArrowRight size={18} /></Link> : undefined} />{snapshot.lifecycle === "active" && <StatusBanner title="This room is still active">The recap updates from canonical room state. End the room before treating it as final.</StatusBanner>}<section className="recap-hero"><div className="recap-number"><span>{String(played.length).padStart(2, "0")}</span><p>played<br />occurrences</p></div><div className="recap-summary"><p>{played.length ? "The played set is preserved in occurrence order." : "No occurrences have been marked played yet."}</p><div><span><Users /> {Object.keys(snapshot.participants).length} participants</span><span><Check /> {voters.size} voters</span><span><Clock3 /> Updated {new Date(snapshot.updatedAtMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span></div></div></section><section className="recap-card recap-story"><p className="eyebrow">PLAYED ORDER</p>{played.length === 0 ? <div className="setlist-empty"><h3>No played songs</h3><p>Confirm and advance a Now occurrence to add it here.</p></div> : <ol>{played.map((item, index) => <li key={item.occurrenceId}><span>{String(index + 1).padStart(2, "0")}</span><strong>{item.title}</strong><small>{item.occurrenceId}</small></li>)}</ol>}</section></ProductShell>;
}
