"use client";

import { useParams } from "next/navigation";
import { Check, CircleAlert, ErrorPanel, LoadingPanel, PageHeader, ProductShell, StatusBanner, useRoomState } from "@/app/components/product";

export default function PublishPage() {
  const { roomId } = useParams<{ roomId: string }>(); const room = useRoomState(roomId);
  if (room.status === "loading") return <ProductShell roomId={roomId}><LoadingPanel label="Preparing the room summary…" /></ProductShell>;
  if (room.status === "error" || !room.data) return <ProductShell roomId={roomId}><ErrorPanel title="Publish preview unavailable" message={room.error?.message ?? "Room state could not be loaded."} onRetry={room.refresh} /></ProductShell>;
  const { actor, snapshot } = room.data;
  if (actor.role !== "host" && actor.role !== "cohost") return <ProductShell guest roomId={roomId} displayName={actor.nickname}><ErrorPanel title="Host access required" message="Guests cannot publish room destinations." /></ProductShell>;
  const played = snapshot.occurrences.filter((item) => item.status === "played");
  return <ProductShell roomId={roomId} displayName={actor.nickname}><PageHeader eyebrow="PUBLISH" title={`Publish room ${roomId}`} description="Only played occurrence titles returned by the room authority are shown below." backHref={`/room/${roomId}/recap`} /><StatusBanner tone="warning" title="Publishing API not deployed">No publish-preview, confirmation, operation-status, retry, or cancel endpoints are present. Nothing can be published from this build.</StatusBanner><section className="publish-preview"><div className="preview-title"><div><p className="eyebrow">LOCAL ROOM SUMMARY</p><h2>Room {roomId}</h2><p>{played.length} played {played.length === 1 ? "occurrence" : "occurrences"} · no destination created</p></div><span className="immutable"><Check /> Canonical state</span></div>{played.length === 0 ? <div className="setlist-empty"><CircleAlert /><h3>Nothing has been played</h3><p>A provider preview would still require deployed publishing endpoints.</p></div> : <ol className="compact-tracklist">{played.map((item, index) => <li key={item.occurrenceId}><span>{String(index + 1).padStart(2, "0")}</span><strong>{item.title}</strong><small>{item.occurrenceId}</small></li>)}</ol>}<div className="publish-confirm"><p>Destination selection and confirmation remain disabled until the connector API can produce an immutable server preview.</p><button className="button button-primary" disabled>Publishing unavailable</button></div></section></ProductShell>;
}
