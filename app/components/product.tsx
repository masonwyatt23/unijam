"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowLeft, ArrowRight, Check, ChevronDown, CircleAlert, CircleCheck, Clock3,
  Copy, ExternalLink, KeyRound, Library, Link2, ListChecks, LogOut, Menu, Music2, Radio,
  RotateCcw, Settings2, Share2, ShieldCheck, Signal, Sparkles, ThumbsUp, Unplug,
  Users, WifiOff, X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

type ApiFailure = { code: string; message: string; retryable?: boolean };
type ApiEnvelope<T> = { data: T | null; error: ApiFailure | null; requestId: string };

export type HostAccount = { accountId: string; displayName: string; recentPasskey: boolean; recoveryEnrollmentAvailable: boolean };
export type RoomActor = { participantId: string; nickname: string; role: "host" | "cohost" | "guest" | "viewer"; ready: boolean };
export type RoomIdentity = Omit<RoomActor, "ready">;
export type RoomRules = {
  contributionLimit: number;
  approvalMode: "host" | "open";
  explicitContent: "allow" | "hold";
  versionPreference: "original" | "any";
  locked: boolean;
  speakerDuty: "host" | "shared";
};
export type RoomSuggestion = {
  suggestionId: string;
  recordingId: string;
  title: string;
  submittedBy: string;
  status: "pending" | "approved" | "held" | "rejected";
  occurrenceId?: string;
  display?: RecordingDisplay;
};
export type RecordingDisplay = {
  artists: string[];
  album?: string;
  durationMs?: number;
  explicit?: boolean;
  provider: "spotify" | "apple_music";
  providerUrl: string;
  artwork?: { url: string; width: number; height: number };
};
export type RoomOccurrence = {
  occurrenceId: string;
  recordingId: string;
  suggestionId: string;
  title: string;
  display?: RecordingDisplay;
  status: "now" | "staged" | "held" | "played" | "skipped";
  position: number;
  cosignerIds: string[];
  voterIds: string[];
  playbackConfirmedAtMs?: number;
};
export type RoomSnapshot = {
  roomId: string;
  seq: number;
  lifecycle: "active" | "ended";
  rules: RoomRules;
  participants: Record<string, RoomActor>;
  suggestions: Record<string, RoomSuggestion>;
  occurrences: RoomOccurrence[];
  updatedAtMs: number;
};

type Resource<T> = { status: "loading" | "ready" | "error"; data: T | null; error: ApiFailure | null; refresh: () => void };

function useApiResource<T>(url: string): Resource<T> {
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<Omit<Resource<T>, "refresh">>({ status: "loading", data: null, error: null });
  useEffect(() => {
    const controller = new AbortController();
    fetch(url, { credentials: "include", cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as ApiEnvelope<T>;
        if (!response.ok || body.error) throw body.error ?? { code: "REQUEST_FAILED", message: "The request failed." };
        setState({ status: "ready", data: body.data, error: null });
      })
      .catch((cause: ApiFailure | DOMException) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        const failure: ApiFailure = cause instanceof DOMException
          ? { code: "NETWORK_ERROR", message: "The service could not be reached.", retryable: true }
          : cause;
        setState({ status: "error", data: null, error: failure });
      });
    return () => controller.abort();
  }, [url, version]);
  const refresh = useCallback(() => {
    // Preserve a rendered canonical snapshot during background refreshes so
    // command feedback and focus are not destroyed after every accepted ack.
    setState((current) => current.data ? current : { status: "loading", data: null, error: null });
    setVersion((value) => value + 1);
  }, []);
  return { ...state, refresh };
}

export function useCurrentHost(): Resource<HostAccount> {
  return useApiResource<HostAccount>("/api/v1/auth/me");
}

export type RoomTransport = "connecting" | "connected" | "reconnecting" | "offline" | "closed";
export type RoomContext = { actor: RoomIdentity; snapshot: RoomSnapshot; transport: RoomTransport };
type StateResponse =
  | RoomSnapshot
  | { actor?: RoomIdentity; type: "snapshot"; snapshot: RoomSnapshot }
  | { actor?: RoomIdentity; type: "events"; events: unknown[]; latestSeq: number }
  | { actor: RoomIdentity; state: { type: "snapshot"; snapshot: RoomSnapshot } };
export function useRoomState(roomId: string): Resource<RoomContext> {
  const resource = useApiResource<StateResponse>(`/api/v1/rooms/${encodeURIComponent(roomId)}/state?snapshot=1`);
  const actor = resource.data && "actor" in resource.data ? resource.data.actor : null;
  const snapshot = resource.data && "roomId" in resource.data
    ? resource.data
    : resource.data && "state" in resource.data && resource.data.state.type === "snapshot"
      ? resource.data.state.snapshot
      : resource.data && "type" in resource.data && resource.data.type === "snapshot"
        ? resource.data.snapshot
        : null;
  const lastSeqRef = useRef(0);
  const [transport, setTransport] = useState<RoomTransport>("connecting");
  const refresh = resource.refresh;
  useEffect(() => {
    if (snapshot) lastSeqRef.current = snapshot.seq;
  }, [snapshot]);
  const isLive = snapshot?.lifecycle === "active";
  useEffect(() => {
    if (!isLive || typeof window === "undefined") return;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let stopped = false;
    let attempt = 0;
    const connect = () => {
      if (stopped) return;
      if (!navigator.onLine) { setTransport("offline"); return; }
      setTransport(attempt === 0 ? "connecting" : "reconnecting");
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}/api/v1/rooms/${encodeURIComponent(roomId)}/websocket`);
      socket.addEventListener("open", () => {
        attempt = 0;
        setTransport("connected");
        socket?.send(JSON.stringify({ type: "hello", protocol: 1, lastSeq: lastSeqRef.current, clientInstanceId: `client_${crypto.randomUUID()}` }));
      });
      socket.addEventListener("message", (event) => {
        try {
          const message = JSON.parse(String(event.data)) as { type?: string; latestSeq?: number; seq?: number };
          const remoteSeq = message.type === "ack" ? message.seq : message.latestSeq;
          if (typeof remoteSeq === "number" && remoteSeq > lastSeqRef.current) refresh();
        } catch { /* invalid server frames are ignored; HTTP remains authoritative */ }
      });
      socket.addEventListener("close", (event) => {
        if (stopped) return;
        setTransport(navigator.onLine ? "reconnecting" : "offline");
        // A policy close means room authority changed (ended, invite rotated,
        // or participant access changed). Re-read HTTP authority before the
        // next attempt so an ended room or revoked session terminates this
        // socket lifecycle instead of backing off forever on a stale snapshot.
        if (event.code === 1008) refresh();
        const delay = Math.min(8_000, 500 * 2 ** attempt);
        attempt += 1;
        reconnectTimer = window.setTimeout(connect, delay);
      });
    };
    const reconnectOnline = () => {
      setTransport("reconnecting");
      if (!socket || socket.readyState === WebSocket.CLOSED) connect();
    };
    const markOffline = () => setTransport("offline");
    window.addEventListener("online", reconnectOnline);
    window.addEventListener("offline", markOffline);
    connect();
    return () => {
      stopped = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      window.removeEventListener("online", reconnectOnline);
      window.removeEventListener("offline", markOffline);
      socket?.close(1000, "Room view closed");
    };
  }, [roomId, refresh, isLive]);
  if (resource.status === "ready" && (!snapshot || !actor)) {
    return { status: "error", data: null, error: { code: "ROOM_CONTEXT_UNAVAILABLE", message: !actor ? "The room API did not return the current server-derived actor." : "The room authority did not return a canonical snapshot.", retryable: true }, refresh: resource.refresh };
  }
  return { ...resource, data: snapshot && actor ? { actor, snapshot, transport: isLive ? transport : "closed" } : null };
}

export async function sendRoomCommand(roomId: string, seq: number, action: string, payload: Record<string, unknown>): Promise<void> {
  const response = await fetch(`/api/v1/rooms/${encodeURIComponent(roomId)}/commands`, {
    method: "POST", credentials: "include", headers: { "content-type": "application/json" },
    body: JSON.stringify({ commandId: `command_${crypto.randomUUID()}`, expectedSeq: seq, action, payload }),
  });
  const body = await response.json() as ApiEnvelope<unknown>;
  if (!response.ok || body.error) throw new Error(body.error?.message ?? "The room did not accept that change.");
}

export function Brand({ compact = false }: { compact?: boolean }) {
  return <Link className={compact ? "wordmark wordmark-compact" : "wordmark"} href="/" aria-label="UniJam home"><span>U</span>UniJam</Link>;
}

export function ProductFooter() {
  return <footer className="product-footer"><Brand compact /><p>Music belongs to the moment, not the platform.</p><p className="legal">Apple and Apple Music are trademarks of Apple Inc., registered in the U.S. and other countries. Spotify is a trademark of Spotify AB.</p></footer>;
}

type SpotifyBrand = { provider: "spotify"; variant?: "full-logo"; background: "light" | "dark" } & (
  { purpose: "connect"; href?: never; label?: "Spotify" } |
  { purpose: "attribution" | "handoff" | "published"; href: string; label: `Open ${string} on Spotify` }
);
type AppleMusicBrand = {
  provider: "apple-music";
  variant: "listen-badge";
  background: "light" | "dark";
  purpose: "attribution" | "handoff" | "published";
  href: string;
  label: `Listen to ${string} on Apple Music` | `Open ${string} on Apple Music`;
} | {
  provider: "apple-music";
  variant: "music-icon";
  background: "light" | "dark";
  purpose: "connect";
  href: "https://music.apple.com/us";
  label: "Open Apple Music";
};
export type ProviderBrandProps = (SpotifyBrand | AppleMusicBrand) & { compact?: boolean };
const spotifyAssets = { light: "/brand/spotify/Full_Logo_Black_RGB.svg", dark: "/brand/spotify/Full_Logo_White_RGB.svg" } as const;
const appleListenBadge = "https://marketing.services.apple/api/storage/images/6408fd8630506600073b0d7e/en-us-large@1x.png";
const appleMusicIcon = "https://marketing.services.apple/api/storage/images/640a26dd7251da00075dc811/en-us-large%401x.png";

function isApprovedProviderLink(provider: ProviderBrandProps["provider"], href: string): boolean {
  try {
    const url = new URL(href);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return false;
    if (provider === "spotify") {
      return url.hostname === "open.spotify.com" && /^\/(?:track|playlist)\/[0-9A-Za-z]+\/?$/.test(url.pathname);
    }
    return url.hostname === "music.apple.com" && (url.pathname === "/us" || /^\/us\/(?:song|album|playlist)\//.test(url.pathname));
  } catch {
    return false;
  }
}

export function ProviderBrand(props: ProviderBrandProps) {
  const href = props.provider === "spotify" && props.purpose === "connect" ? undefined : props.href;
  // A provider response can never turn an official mark into an open redirect
  // or imply that non-provider content is supplied by Spotify or Apple Music.
  if (href && !isApprovedProviderLink(props.provider, href)) return null;
  const image = props.provider === "spotify" ? spotifyAssets[props.background] : props.variant === "music-icon" ? appleMusicIcon : appleListenBadge;
  const alt = props.label ?? (props.provider === "spotify" ? "Spotify" : "Listen on Apple Music");
  const className = `provider-brand provider-${props.provider}${props.provider === "apple-music" && props.variant === "music-icon" ? " provider-apple-icon" : ""}${props.compact ? " provider-compact" : ""}`;
  // Official provider artwork is rendered without an optimization transform.
  // eslint-disable-next-line @next/next/no-img-element
  const content = <img src={image} alt={alt} width={props.provider === "spotify" ? 96 : props.variant === "music-icon" ? 56 : 111} height={props.provider === "spotify" ? 40 : props.variant === "music-icon" ? 56 : 33} referrerPolicy="strict-origin" />;
  return href ? <a className={className} href={href} target="_blank" rel="noreferrer">{content}<span className="sr-only"> (opens in a new tab)</span></a> : <span className={className}>{content}</span>;
}

function initials(value: string): string {
  return value.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "H";
}

export function ProductShell({ children, guest = false, roomId, displayName, roomLabel }: { children: ReactNode; guest?: boolean; roomId?: string; displayName?: string; roomLabel?: string }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const railRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      menuButtonRef.current?.focus();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);
  useEffect(() => {
    if (!open || guest) return;
    const rail = railRef.current;
    if (!rail) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    const focusable = () => [...rail.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')];
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => focusable()[0]?.focus());
    const trapFocus = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setOpen(false); menuButtonRef.current?.focus(); return; }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      const current = document.activeElement;
      if (event.shiftKey && current === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
      else if (!event.shiftKey && current === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
    };
    document.addEventListener("keydown", trapFocus);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener("keydown", trapFocus); if (document.activeElement === document.body) previousFocus?.focus(); };
  }, [guest, open]);
  const navItems = useMemo(() => [
    { href: "/host", label: "Rooms", icon: Radio },
    { href: roomId ? `/library?roomId=${roomId}` : "/library", label: "Music library", icon: Library },
    ...(roomId ? [{ href: `/room/${roomId}/review`, label: "Pick review", icon: ListChecks }] : []),
    { href: "/connections", label: "Connect music", icon: Link2 },
    ...(roomId ? [{ href: `/room/${roomId}/recap`, label: "Recap", icon: Clock3 }] : []),
  ], [roomId]);
  const roomName = roomLabel ?? (roomId ? `Room ${roomId}` : "Current room");
  const accountName = guest ? "Guest" : displayName ?? "Host session";
  async function signOut() {
    setSigningOut(true);
    try {
      await fetch("/api/v1/auth/logout", { method: "POST", credentials: "include" });
    } finally {
      window.location.assign("/");
    }
  }
  return <div className={`product-shell${guest ? " is-guest" : ""}`}>
    <a href="#main-content" className="skip-link" aria-hidden={open || undefined} tabIndex={open ? -1 : undefined}>Skip to main content</a>
    <header className="mobile-bar"><Brand compact /><button ref={menuButtonRef} className="icon-button" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="app-nav" aria-label={open ? "Close navigation" : "Open navigation"}>{open ? <X /> : <Menu />}</button></header>
    {open ? <button type="button" className="nav-scrim" aria-label="Close navigation" onClick={() => { setOpen(false); menuButtonRef.current?.focus(); }} /> : null}
    <aside ref={railRef} className={`rail${open ? " is-open" : ""}`} id="app-nav" role={open ? "dialog" : undefined} aria-modal={open || undefined} aria-label={open ? "UniJam navigation" : undefined}><Brand />
      {guest ? <div className="guest-rail-copy"><span className="utility">GUEST ACCESS</span><strong>{roomName}</strong><p>Your session only opens this room.</p></div> : <nav aria-label="Host workspace">{navItems.map((item) => { const active = pathname === item.href || item.href === "/connections" && pathname.startsWith("/connections/"); const Icon = item.icon; return <Link key={item.href} href={item.href} className={active ? "active" : ""} aria-current={active ? "page" : undefined} onClick={() => setOpen(false)}><Icon size={19} />{item.label}</Link>; })}</nav>}
      <div className="rail-bottom">{!guest && roomId && <Link href={`/room/${roomId}`} className="rail-live"><span className="live-dot" /> {roomName} <ArrowRight size={17} /></Link>}{guest ? <div className="rail-account"><span className="avatar">G</span><span><strong>{accountName}</strong><small>Room-scoped session</small></span></div> : <div className="rail-account-wrap"><button className="rail-account" type="button" aria-expanded={accountMenuOpen} aria-controls="account-menu" onClick={() => setAccountMenuOpen((value) => !value)}><span className="avatar">{initials(accountName)}</span><span><strong>{accountName}</strong><small>Passkey secured</small></span><ChevronDown size={16} aria-hidden="true" /></button>{accountMenuOpen ? <div className="rail-account-menu" id="account-menu"><button type="button" disabled={signingOut} onClick={() => void signOut()}><LogOut size={16} /> {signingOut ? "Signing out…" : "Sign out"}</button></div> : null}</div>}</div>
    </aside>
    <main className="workspace" id="main-content" aria-hidden={open || undefined}>{children}</main>
  </div>;
}

export function PageHeader({ eyebrow, title, description, actions, backHref }: { eyebrow: string; title: string; description?: string; actions?: ReactNode; backHref?: string }) {
  return <header className="page-header"><div>{backHref && <Link className="back-link" href={backHref}><ArrowLeft size={17} /> Back</Link>}<p className="eyebrow">{eyebrow}</p><h1>{title}</h1>{description && <p className="page-lede">{description}</p>}</div>{actions && <div className="page-actions">{actions}</div>}</header>;
}

export function StatusBanner({ tone = "info", title, children, action }: { tone?: "info" | "success" | "warning" | "danger"; title: string; children: ReactNode; action?: ReactNode }) {
  const Icon = tone === "success" ? CircleCheck : tone === "warning" || tone === "danger" ? CircleAlert : Signal;
  return <section className={`status-banner status-${tone}`} role={tone === "danger" ? "alert" : "status"}><Icon /><div><strong>{title}</strong><p>{children}</p></div>{action}</section>;
}

export function LoadingPanel({ label = "Loading room…" }: { label?: string }) {
  return <section className="state-panel" aria-live="polite" aria-busy="true"><span className="state-spinner" /><p className="eyebrow">CONNECTING</p><h1>{label}</h1><p>UniJam is asking the room authority for the latest state.</p></section>;
}

export function ErrorPanel({ title, message, onRetry, action }: { title: string; message: string; onRetry?: () => void; action?: ReactNode }) {
  return <section className="state-panel" role="alert"><span className="gate-icon"><WifiOff /></span><p className="eyebrow">ACCESS UNAVAILABLE</p><h1>{title}</h1><p>{message}</p>{onRetry && <button className="button button-primary" onClick={onRetry}>Try again</button>}{action}</section>;
}

export function SegmentedControl<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly { value: T; label: string }[]; onChange: (value: T) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (index + (event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
    onChange(options[next].value); refs.current[next]?.focus();
  }
  return <div className="segmented" role="radiogroup" aria-label={label}>{options.map((option, index) => <button key={option.value} ref={(node) => { refs.current[index] = node; }} type="button" role="radio" aria-checked={value === option.value} tabIndex={value === option.value ? 0 : -1} onClick={() => onChange(option.value)} onKeyDown={(event) => onKeyDown(event, index)}>{option.label}</button>)}</div>;
}

function QueueArtwork({ item }: { item: RoomOccurrence }) {
  const [failed, setFailed] = useState(false);
  if (!item.display?.artwork || failed) return <span className="queue-artwork artwork-fallback" aria-hidden="true"><Music2 /></span>;
  // Provider artwork remains direct and untransformed.
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="queue-artwork" src={item.display.artwork.url} width={item.display.artwork.width} height={item.display.artwork.height} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

export function LivingSetlist({ snapshot, guest, actorId, onRefresh }: { snapshot: RoomSnapshot; guest: boolean; actorId: string; onRefresh: () => void }) {
  const [announcement, setAnnouncement] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const staged = [...snapshot.occurrences.filter((item) => item.status === "staged")].sort((a, b) => a.position - b.position);
  const groups = [
    { key: "now", items: snapshot.occurrences.filter((item) => item.status === "now") },
    { key: "next", items: staged.slice(0, 1) },
    { key: "staged", items: staged.slice(1) },
    { key: "held", items: snapshot.occurrences.filter((item) => item.status === "held") },
    { key: "played", items: snapshot.occurrences.filter((item) => item.status === "played") },
  ] as const;
  const visibleCount = groups.reduce((total, group) => total + group.items.length, 0);
  const now = groups[0].items[0];
  async function command(id: string, action: string, payload: Record<string, unknown>, success: string) {
    setPendingId(id);
    try { await sendRoomCommand(snapshot.roomId, snapshot.seq, action, payload); setAnnouncement(success); onRefresh(); }
    catch (cause) { setAnnouncement(cause instanceof Error ? cause.message : "The change was not saved."); }
    finally { setPendingId(null); }
  }
  function submitter(item: RoomOccurrence): string {
    const suggestion = snapshot.suggestions[item.suggestionId];
    return suggestion ? snapshot.participants[suggestion.submittedBy]?.nickname ?? "Former participant" : "Room participant";
  }
  return <section className="setlist" aria-labelledby="setlist-title">
    <div className="section-heading"><div><p className="eyebrow">LIVING SETLIST</p><h2 id="setlist-title">Room queue</h2></div><span className="utility">{visibleCount} {visibleCount === 1 ? "SONG" : "SONGS"} · SEQ {snapshot.seq}</span></div>
    {announcement && <p className="setlist-feedback" role="status">{announcement}</p>}
    {visibleCount === 0 ? <div className="setlist-empty"><Music2 /><h3>No songs yet</h3><p>Approved picks will appear here in one continuous queue.</p></div> : <div className="setlist-spine">{groups.map((group) => group.items.length > 0 && <div className={`queue-group queue-${group.key}`} key={group.key}><div className="queue-label"><span className={group.key === "now" ? `cue-lamp${group.items[0]?.playbackConfirmedAtMs ? " is-on" : ""}` : "spine-node"} /><strong>{group.key}</strong></div><div className="queue-items">{group.items.map((item, index) => {
      const voted = item.voterIds.includes(actorId);
      return <article className="track-row" key={item.occurrenceId}>
        <span className="track-position utility">{group.key === "now" ? "LIVE" : group.key === "next" ? "UP" : String(index + 1).padStart(2, "0")}</span>
        <QueueArtwork item={item} />
        <div className="track-copy"><strong>{item.title}</strong><span>{item.display?.artists.length ? `${item.display.artists.join(", ")} · ` : ""}Picked by {submitter(item)} · {item.cosignerIds.length} co-signs</span><small>{item.display?.album ?? item.recordingId}{item.display?.explicit ? " · Explicit" : ""}</small>{item.display ? <a className="provider-text-link" href={item.display.providerUrl} target="_blank" rel="noreferrer">Open on {item.display.provider === "spotify" ? "Spotify" : "Apple Music"}<span className="sr-only"> (opens in a new tab)</span></a> : null}</div>
        <span className="track-duration utility">{item.voterIds.length} VOTES</span>
        {!(["played", "held"] as string[]).includes(group.key) && <button className={`cosign${voted ? " is-active" : ""}`} disabled={pendingId === item.occurrenceId} onClick={() => void command(item.occurrenceId, "queue.vote", { occurrenceId: item.occurrenceId, vote: !voted }, `${voted ? "Vote removed" : "Vote saved"} for ${item.title}`)} aria-label={`${voted ? "Remove vote from" : "Vote for"} ${item.title}`} aria-pressed={voted}><ThumbsUp size={16} /><span>{item.voterIds.length}</span></button>}
        {group.key === "played" && <CircleCheck className="played-check" aria-label="Played" />}
      </article>;
    })}</div></div>)}</div>}
    {!guest && now && <div className="setlist-controls"><div><strong>{now.playbackConfirmedAtMs ? "Playback confirmed" : `Did ${now.title} start?`}</strong><span>{now.playbackConfirmedAtMs ? "Advance when the track finishes, or skip it if playback stops." : "Confirm only after you hear it begin. Advance stays locked until then."}</span></div><div className="setlist-control-actions"><button className="button button-quiet" disabled={pendingId === now.occurrenceId} onClick={() => void command(now.occurrenceId, "queue.skip", { occurrenceId: now.occurrenceId }, `${now.title} was skipped`)}>Skip</button><button className="button button-primary" disabled={!now.playbackConfirmedAtMs || pendingId === now.occurrenceId} title={!now.playbackConfirmedAtMs ? "Confirm playback before advancing" : undefined} onClick={() => void command(now.occurrenceId, "queue.advance", { occurrenceId: now.occurrenceId }, `${now.title} moved to Played`)}>Advance <ArrowRight size={19} /></button><button className="button button-quiet" disabled={Boolean(now.playbackConfirmedAtMs) || pendingId === now.occurrenceId} onClick={() => void command(now.occurrenceId, "playback.confirm", { occurrenceId: now.occurrenceId }, `Playback confirmed for ${now.title}`)}>{now.playbackConfirmedAtMs ? <><Check size={19} /> Confirmed</> : "Confirm playback"}</button></div></div>}
  </section>;
}

export type GateState = "invalid" | "invalid-or-rotated" | "expired" | "rotated" | "ended" | "locked" | "offline" | "rate-limited" | "unsupported";
const gateCopy: Record<GateState, { title: string; body: string; action: string; href: string; icon: typeof WifiOff }> = {
  invalid: { title: "This invite isn’t valid", body: "Ask the host for the current room link. The link may have been copied incompletely.", action: "Try another invite", href: "/join", icon: Unplug },
  "invalid-or-rotated": { title: "This invite can’t open the room", body: "The link is invalid or the host replaced it. UniJam cannot safely distinguish those cases. Ask the host for the current invite.", action: "Try another invite", href: "/join", icon: RotateCcw },
  expired: { title: "This invite expired", body: "Ask the host to create a fresh invite.", action: "Return home", href: "/", icon: Clock3 },
  rotated: { title: "The host replaced this invite", body: "This link can no longer open the room. Ask the host for the new link.", action: "Return home", href: "/", icon: RotateCcw },
  ended: { title: "This room has ended", body: "The host closed this room. Guests can no longer join or contribute.", action: "Return home", href: "/", icon: LogOut },
  locked: { title: "The room is locked", body: "This room isn’t accepting new guests right now. The host can unlock it.", action: "Check again", href: "/join", icon: ShieldCheck },
  offline: { title: "You’re offline", body: "Reconnect to the internet, then try joining the room again.", action: "Try again", href: "/join", icon: WifiOff },
  "rate-limited": { title: "Too many attempts", body: "Joining is paused briefly to protect the room. Wait one minute, then try again.", action: "Try again", href: "/join", icon: Clock3 },
  unsupported: { title: "That music link isn’t supported", body: "Use a Spotify or Apple Music link, or enter a song title and artist.", action: "Return to the room", href: "/", icon: Music2 },
};
export function RoomGate({ state, onRetry }: { state: GateState; onRetry?: () => void }) { const copy = gateCopy[state]; const Icon = copy.icon; return <main className="gate"><Brand /><section><span className="gate-icon"><Icon /></span><p className="eyebrow">ROOM ACCESS</p><h1>{copy.title}</h1><p>{copy.body}</p>{onRetry ? <button className="button button-primary" onClick={onRetry}>{copy.action} <ArrowRight size={18} /></button> : <Link href={copy.href} className="button button-primary">{copy.action} <ArrowRight size={18} /></Link>}<small>Room details are never shown until an invite is accepted.</small></section></main>; }

export function CopyButton({ value, children = "Copy link" }: { value: string; children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  async function copy() { try { await navigator.clipboard.writeText(value); setCopied(true); window.setTimeout(() => setCopied(false), 1800); } catch { setCopied(false); } }
  return <button className="button button-quiet" onClick={() => void copy()}>{copied ? <Check size={18} /> : <Copy size={18} />}{copied ? "Copied" : children}</button>;
}

export { ArrowRight, Check, CircleAlert, CircleCheck, ExternalLink, KeyRound, Music2, Settings2, Share2, Sparkles, Users };
