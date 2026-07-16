"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Brand, Music2, RoomGate, SegmentedControl, type GateState } from "@/app/components/product";

type Service = "ask" | "spotify" | "apple-music";
export default function InviteExchangePage() {
  const { roomId } = useParams<{ roomId: string }>(); const router = useRouter();
  const capabilityRef = useRef<string | null>(typeof window === "undefined" ? null : new URLSearchParams(window.location.hash.slice(1)).get("cap"));
  const [service, setService] = useState<Service>("ask"); const [status, setStatus] = useState<"idle" | "joining" | "error">("idle"); const [message, setMessage] = useState(""); const [gateState, setGateState] = useState<GateState | null>(null);
  useEffect(() => { history.replaceState(null, "", location.pathname); }, []);
  async function join(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setStatus("joining"); setMessage("");
    const capability = capabilityRef.current;
    if (!capability) { setStatus("error"); setGateState("invalid"); return; }
    const data = new FormData(event.currentTarget);
    try {
      const response = await fetch(`/api/v1/rooms/${encodeURIComponent(roomId)}/join`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ capability, nickname: data.get("nickname") }) });
      const body = await response.json() as { data?: { role?: string }; error?: { code?: string; message?: string } };
      if (!response.ok || body.data?.role !== "guest") {
        const stateByCode: Partial<Record<string, GateState>> = {
          INVALID_INVITE_EXCHANGE: "invalid", INVITE_INVALID: "invalid", INVITE_INVALID_OR_ROTATED: "invalid-or-rotated",
          INVITE_EXPIRED: "expired", INVITE_ROTATED: "rotated", ROOM_ENDED: "ended", ROOM_LOCKED: "locked", JOIN_RATE_LIMITED: "rate-limited",
        };
        const nextGate = body.error?.code ? stateByCode[body.error.code] : undefined;
        if (nextGate) { setStatus("error"); setGateState(nextGate); return; }
        throw new Error(body.error?.message ?? "The invite could not be exchanged.");
      }
      capabilityRef.current = null;
      sessionStorage.setItem(`unijam.service.${roomId}`, service);
      router.replace(`/room/${roomId}`);
    } catch (cause) { setStatus("error"); if (!navigator.onLine) setGateState("offline"); else setMessage(cause instanceof Error ? cause.message : "The invite could not be exchanged."); }
  }
  if (gateState) return <RoomGate state={gateState} onRetry={["locked", "offline", "rate-limited"].includes(gateState) ? () => { setGateState(null); setStatus("idle"); } : undefined} />;
  return <main className="join-page"><header><Brand /><a href="/host/sign-in">Host a room</a></header><section className="join-card"><div className="join-intro"><span className="gate-icon"><Music2 /></span><p className="eyebrow">ROOM {roomId}</p><h1>Choose your room name</h1><p>Your invite is exchanged once for a secure, room-scoped cookie.</p></div><form onSubmit={(event) => void join(event)}><label className="control-label">What do you listen with?</label><SegmentedControl label="Music service preference" value={service} onChange={setService} options={[{ value: "ask", label: "Ask each time" }, { value: "spotify", label: "Spotify" }, { value: "apple-music", label: "Apple Music" }]} /><label className="field"><span>Your name in the room</span><input name="nickname" autoComplete="nickname" maxLength={48} required /></label>{status === "error" && <p className="inline-error" role="alert">{message}</p>}<button className="button button-primary button-wide" disabled={status === "joining"}>{status === "joining" ? "Joining…" : "Join room"}</button></form></section></main>;
}
