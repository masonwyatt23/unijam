"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, CircleAlert } from "lucide-react";
import { ErrorPanel, LoadingPanel, ProductShell, useRoomState } from "@/app/components/product";

export default function AppleMusicHandoffPage() {
  const { roomId } = useParams<{ roomId: string }>(); const room = useRoomState(roomId);
  if (room.status === "loading") return <ProductShell roomId={roomId}><LoadingPanel label="Checking handoff availability…" /></ProductShell>;
  if (room.status === "error" || !room.data) return <ProductShell roomId={roomId}><ErrorPanel title="Handoff unavailable" message={room.error?.message ?? "Room state could not be loaded."} /></ProductShell>;
  const { actor } = room.data; const guest = actor.role === "guest" || actor.role === "viewer";
  return <ProductShell guest={guest} roomId={roomId} displayName={actor.nickname}><div className="handoff-page"><Link href={`/room/${roomId}`} className="back-link"><ArrowLeft size={17} /> Back to room</Link><section className="handoff-sheet"><span className="gate-icon"><CircleAlert /></span><p className="eyebrow">NATIVE HANDOFF</p><h1>Handoff unavailable</h1><p className="handoff-artist">The canonical room snapshot contains recording IDs but no provider match or allowlisted Apple Music URL.</p><div className="handoff-rule"><CircleAlert /><div><strong>No provider link was invented</strong><p>A licensed Apple Music badge will appear only when a real provider match supplies an exact content URL.</p></div></div></section></div></ProductShell>;
}
