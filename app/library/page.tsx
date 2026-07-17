"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Disc3, Library, LoaderCircle, Music2, Plus, Search, Unplug } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import { ErrorPanel, LoadingPanel, PageHeader, ProductShell, ProviderBrand, SegmentedControl, StatusBanner, useCurrentHost } from "@/app/components/product";

type Provider = "spotify" | "apple-music";
type Failure = { code: string; message: string; retryable?: boolean };
type Envelope<T> = { data: T | null; error: Failure | null; requestId?: string };
type LibraryTrack = {
  provider: "spotify" | "apple_music"; providerRecordingId: string; libraryItemId?: string;
  title: string; artists: string[]; album?: string; durationMs?: number; explicit?: boolean;
  artwork?: { url: string; width: number; height: number }; providerUrl: string; addedAt?: string;
};
type LibraryPage = { items: LibraryTrack[]; nextCursor: string | null; total?: number };
type Resolution = { status: "matched"; resolutionId: string; title: string; artists: string[] } | { status: "hold" | "no_match" };

const providers = [{ value: "spotify", label: "Spotify" }, { value: "apple-music", label: "Apple Music" }] as const;
const providerName = (provider: Provider) => provider === "spotify" ? "Spotify" : "Apple Music";
function durationLabel(durationMs?: number): string {
  if (durationMs === undefined) return "—:—";
  const seconds = Math.round(durationMs / 1_000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function TrackArtwork({ track }: { track: LibraryTrack }) {
  const [failed, setFailed] = useState(false);
  if (!track.artwork || failed) return <span className="library-artwork artwork-fallback" aria-hidden="true"><Music2 /></span>;
  // Provider artwork stays direct and untransformed.
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="library-artwork" src={track.artwork.url} width={track.artwork.width} height={track.artwork.height} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

export default function MusicLibraryPage() {
  const host = useCurrentHost();
  const searchParams = useSearchParams();
  const roomId = searchParams.get("roomId")?.trim().toUpperCase() ?? "";
  const [provider, setProvider] = useState<Provider>("spotify");
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [page, setPage] = useState<LibraryPage | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [addingId, setAddingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "warning"; title: string; message: string } | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async (cursor?: string, append = false) => {
    const requestId = ++requestRef.current;
    if (append) setLoadingMore(true);
    else setLoading(true);
    if (!append) { setFailure(null); setNotice(null); }
    try {
      const params = new URLSearchParams({ limit: "20" });
      if (submittedQuery) params.set("q", submittedQuery);
      if (cursor) params.set("cursor", cursor);
      const response = await fetch(`/api/v1/providers/${provider}/library?${params}`, { credentials: "include", cache: "no-store" });
      const body = await response.json() as Envelope<LibraryPage>;
      if (!response.ok || body.error || !body.data) throw body.error ?? { code: "LIBRARY_UNAVAILABLE", message: "Your music library could not be loaded." };
      if (requestId !== requestRef.current) return;
      setPage((current) => append && current ? { ...body.data!, items: [...current.items, ...body.data!.items] } : body.data);
    } catch (cause) {
      if (requestId !== requestRef.current) return;
      setFailure(cause as Failure); if (!append) setPage(null);
    } finally {
      if (requestId === requestRef.current) { setLoading(false); setLoadingMore(false); }
    }
  }, [provider, submittedQuery]);
  useEffect(() => {
    if (!host.data) return;
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [host.data, load]);

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSubmittedQuery(query.normalize("NFKC").trim());
  }

  async function addToRoom(track: LibraryTrack) {
    if (!roomId) return;
    setAddingId(track.providerRecordingId); setNotice(null);
    try {
      const resolved = await fetch(`/api/v1/rooms/${encodeURIComponent(roomId)}/resolve`, {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: track.providerUrl, provider }),
      });
      const resolution = await resolved.json() as Envelope<Resolution>;
      if (!resolved.ok || resolution.error || resolution.data?.status !== "matched") throw resolution.error ?? { code: "REVIEW_REQUIRED", message: "This recording needs review in the room before it can be added." };
      const command = await fetch(`/api/v1/rooms/${encodeURIComponent(roomId)}/commands`, {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId: `cmd_${crypto.randomUUID()}`, action: "suggestion.stage", payload: { suggestionId: `sug_${crypto.randomUUID()}`, resolutionId: resolution.data.resolutionId } }),
      });
      const result = await command.json() as Envelope<unknown>;
      if (!command.ok || result.error) throw result.error ?? { code: "ROOM_REJECTED", message: "The room did not accept this song." };
      setNotice({ tone: "success", title: "Added to the room", message: `${track.title} by ${track.artists.join(", ")} is now in room ${roomId}.` });
    } catch (cause) {
      const error = cause as Failure;
      setNotice({ tone: "warning", title: "Song not added", message: error.message ?? "This song could not be added to the room." });
    } finally { setAddingId(null); }
  }

  if (host.status === "loading") return <ProductShell><LoadingPanel label="Opening your music library…" /></ProductShell>;
  if (host.status === "error" || !host.data) return <ProductShell><ErrorPanel title="Member account required" message={host.error?.message ?? "Sign in with a passkey to browse your connected music library."} action={<Link className="button button-primary" href={`/host/sign-in?returnTo=${encodeURIComponent(roomId ? `/library?roomId=${roomId}` : "/library")}`}>Sign in</Link>} /></ProductShell>;

  const name = providerName(provider);
  const firstTrack = page?.items[0];
  return <ProductShell roomId={roomId || undefined} displayName={host.data.displayName}>
    <PageHeader eyebrow="YOUR MUSIC" title={roomId ? `Choose a song for room ${roomId}` : "Your music library"} description="Browse saved tracks or search one connected service at a time. Your private library is never copied into UniJam." backHref={roomId ? `/room/${roomId}` : "/host"} />
    {notice ? <StatusBanner tone={notice.tone} title={notice.title}>{notice.message}</StatusBanner> : null}
    <section className="library-deck" aria-labelledby="library-provider-title">
      <div className="library-controls"><div><p className="eyebrow">ACTIVE RECORD SHELF</p><h2 id="library-provider-title">Browse {name}</h2></div><SegmentedControl label="Music service" value={provider} options={providers} onChange={(value) => { setProvider(value); setQuery(""); setSubmittedQuery(""); setPage(null); setFailure(null); }} /></div>
      <div className={`provider-shelf provider-shelf-${provider}`}>
        <div className="provider-shelf-heading">{provider === "spotify" ? <ProviderBrand provider="spotify" background="light" purpose="connect" /> : firstTrack ? <ProviderBrand provider="apple-music" variant="listen-badge" background="light" purpose="attribution" href={firstTrack.providerUrl} label={`Listen to ${firstTrack.title} on Apple Music`} /> : <div className="apple-shelf-title"><Disc3 /><strong>Apple Music library</strong></div>}<p>{submittedQuery ? `Results for “${submittedQuery}”` : "Recently saved songs"}{page?.total !== undefined ? ` · ${page.total.toLocaleString()} tracks` : ""}</p></div>
        <form className="library-search" role="search" onSubmit={submitSearch}><label htmlFor="library-query"><span className="sr-only">Search {name}</span><Search aria-hidden="true" /><input id="library-query" type="search" value={query} maxLength={200} onChange={(event) => setQuery(event.target.value)} placeholder={provider === "spotify" ? "Find a saved song from Spotify’s best matches" : "Search songs, artists, or albums in Apple Music"} /></label><button className="button button-primary" disabled={loading}>{loading ? "Searching…" : "Search"}</button>{submittedQuery ? <button type="button" className="button button-quiet" onClick={() => { setQuery(""); setSubmittedQuery(""); }}>Saved tracks</button> : null}</form>
        {provider === "spotify" ? <p className="library-search-note">Spotify checks its best catalog matches against your saved tracks. If an older or less common save is missing, browse the saved shelf instead.</p> : null}
        {failure ? <div className="library-inline-state" role="alert"><Unplug /><div><strong>{failure.code === "PROVIDER_NOT_CONNECTED" ? `Connect ${name}` : failure.code === "PROVIDER_RECONNECT_REQUIRED" ? `Reconnect ${name}` : "Library unavailable"}</strong><p>{failure.message}</p><Link className="button button-primary" href={`/connections/${provider}?returnTo=${encodeURIComponent(roomId ? `/library?roomId=${roomId}` : "/library")}`}>{failure.code === "PROVIDER_RECONNECT_REQUIRED" ? "Reconnect" : "Open connection"}</Link></div></div> : null}
        {!failure && loading && !page ? <div className="library-inline-state" aria-live="polite"><LoaderCircle className="spinning" /><div><strong>Loading {name}</strong><p>Reading your provider library without storing a copy.</p></div></div> : null}
        {!failure && !loading && page?.items.length === 0 ? <div className="library-inline-state"><Library /><div><strong>{submittedQuery ? "No saved match found" : "No saved songs yet"}</strong><p>{submittedQuery ? provider === "spotify" ? "Spotify’s best catalog matches were not in your saved tracks. Browse the shelf or try the exact title and artist." : "Try a title, artist, or album with fewer words." : `Save songs in ${name}, then refresh this shelf.`}</p><button className="button button-quiet" onClick={() => void load()}>Refresh</button></div></div> : null}
        {page && page.items.length > 0 ? <ol className="library-track-list" aria-label={`${name} ${submittedQuery ? "search results" : "saved songs"}`}>{page.items.map((track, index) => <li key={`${track.providerRecordingId}-${index}`}><a className="library-art-link" href={track.providerUrl} target="_blank" rel="noreferrer" aria-label={`Open ${track.title} on ${name} in a new tab`}><TrackArtwork track={track} /></a><div className="library-track-copy"><a href={track.providerUrl} target="_blank" rel="noreferrer"><strong>{track.title}</strong><span className="sr-only"> (opens in a new tab)</span></a><span>{track.artists.join(", ")}</span><small>{track.album ?? "Album unavailable"}{track.explicit ? " · Explicit" : ""}</small></div><span className="library-duration">{durationLabel(track.durationMs)}</span><div className="library-track-actions">{roomId ? <button className="button button-primary" disabled={addingId !== null} onClick={() => void addToRoom(track)}>{addingId === track.providerRecordingId ? <><LoaderCircle className="spinning" /> Adding…</> : <><Plus /> Add to room</>}</button> : null}<a href={track.providerUrl} target="_blank" rel="noreferrer">Open on {providerName(provider)}<span className="sr-only"> (opens in a new tab)</span></a></div></li>)}</ol> : null}
        {page?.nextCursor ? <div className="library-load-more"><button className="button button-quiet" disabled={loadingMore} onClick={() => void load(page.nextCursor!, true)}>{loadingMore ? "Loading more…" : "Load more songs"}</button></div> : null}
      </div>
    </section>
  </ProductShell>;
}
