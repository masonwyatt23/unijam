import type { CatalogCandidate } from "../lib/catalog/resolver.ts";
import type {
  AppendPlaylistItemsRequest,
  CreatePrivatePlaylistRequest,
  ProviderAdapter,
  ProviderCatalogQuery,
  ProviderMutationReceipt,
  ProviderPlaylistSnapshot,
  ProviderRequestContext,
} from "../lib/providers/contracts.ts";
import { recoveryMarkerFromDescription } from "../lib/publishing/model.ts";
import { invalidProviderResponse } from "./errors.ts";
import { providerJson } from "./http.ts";
import { inferEdition, inferVersion, isRecord, numberValue, stringValue } from "./catalog-shape.ts";

const API = "https://api.spotify.com/v1";
const SPOTIFY_ID = /^[0-9A-Za-z]{22}$/;

export interface SpotifyOEmbedMetadata {
  readonly provider: "spotify";
  readonly providerRecordingId: string;
  readonly title: string;
  readonly metadataComplete: false;
}

export interface SpotifyAdapterOptions {
  readonly accessToken: string;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
}

function objectResponse(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}

function bearer(accessToken: string, json = false): HeadersInit {
  return {
    Authorization: `Bearer ${accessToken}`,
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

function spotifyPlaylistUrl(value: unknown, playlistId: string): string | undefined {
  const raw = stringValue(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.hostname !== "open.spotify.com" || url.pathname !== `/playlist/${playlistId}`) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

function spotifyCandidate(value: unknown): CatalogCandidate | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id);
  const title = stringValue(value.name);
  const artists = Array.isArray(value.artists)
    ? value.artists.flatMap((artist) => isRecord(artist) && stringValue(artist.name) ? [String(artist.name)] : [])
    : [];
  if (!id || !title || artists.length === 0) return null;
  const album = isRecord(value.album) ? stringValue(value.album.name) : undefined;
  const isrc = isRecord(value.external_ids) ? stringValue(value.external_ids.isrc) : undefined;
  const availableMarkets = Array.isArray(value.available_markets)
    ? value.available_markets.filter((market): market is string => typeof market === "string")
    : undefined;
  const isPlayable = typeof value.is_playable === "boolean" ? value.is_playable : undefined;
  const storefronts = isPlayable === false
    ? []
    : availableMarkets
      ? availableMarkets.map((market) => market.toUpperCase()).filter((market) => market === "US")
      : isPlayable === true ? ["US"] : undefined;
  return {
    provider: "spotify",
    providerRecordingId: id,
    title,
    artists,
    ...(album ? { album } : {}),
    ...(numberValue(value.duration_ms) === undefined ? {} : { durationMs: numberValue(value.duration_ms) }),
    ...(isrc ? { isrc } : {}),
    ...(typeof value.explicit === "boolean" ? { explicit: value.explicit } : {}),
    version: inferVersion(title, album),
    edition: inferEdition(album),
    ...(storefronts === undefined ? {} : { storefronts }),
  };
}

/**
 * Reads only Spotify's documented oEmbed link-preview contract. oEmbed does not
 * expose artist, ISRC, duration, or version, so callers must never auto-match
 * its title alone.
 */
export async function spotifyOEmbedMetadata(
  providerRecordingId: string,
  options: { readonly fetcher?: typeof fetch; readonly now?: () => number } = {},
): Promise<SpotifyOEmbedMetadata> {
  if (!SPOTIFY_ID.test(providerRecordingId)) throw new Error("invalid Spotify recording ID");
  const trackUrl = `https://open.spotify.com/track/${providerRecordingId}`;
  const body = await providerJson(
    `https://open.spotify.com/oembed?${new URLSearchParams({ url: trackUrl })}`,
    {},
    { provider: "spotify", fetcher: options.fetcher, now: options.now },
    objectResponse,
  );
  const title = stringValue(body.title)?.trim();
  const iframeUrl = stringValue(body.iframe_url) ?? (() => {
    const html = stringValue(body.html);
    const match = html?.match(/\bsrc=["']([^"']+)["']/i);
    return match?.[1];
  })();
  let iframe: URL;
  try { iframe = new URL(iframeUrl ?? ""); }
  catch { throw invalidProviderResponse("spotify"); }
  if (
    !title || title.length > 500 || body.provider_name !== "Spotify" ||
    body.provider_url !== "https://spotify.com" || body.type !== "rich" ||
    iframe.protocol !== "https:" || iframe.hostname !== "open.spotify.com" ||
    iframe.pathname !== `/embed/track/${providerRecordingId}`
  ) {
    throw invalidProviderResponse("spotify");
  }
  return { provider: "spotify", providerRecordingId, title, metadataComplete: false };
}

export class SpotifyAdapter implements ProviderAdapter {
  readonly provider = "spotify" as const;
  private readonly options: SpotifyAdapterOptions;

  constructor(options: SpotifyAdapterOptions) {
    if (!options.accessToken.trim()) throw new Error("Spotify access token is required");
    this.options = options;
  }

  private async json(path: string, init: RequestInit = {}, mutation = false): Promise<Record<string, unknown>> {
    return providerJson(
      `${API}${path}`,
      { ...init, headers: { ...bearer(this.options.accessToken, Boolean(init.body)), ...init.headers } },
      { provider: "spotify", fetcher: this.options.fetcher, now: this.options.now, mutation },
      objectResponse,
    );
  }

  async getRecording(
    _context: ProviderRequestContext,
    providerRecordingId: string,
  ): Promise<CatalogCandidate | null> {
    if (!SPOTIFY_ID.test(providerRecordingId)) throw new Error("invalid Spotify recording ID");
    return spotifyCandidate(await this.json(`/tracks/${providerRecordingId}?market=US`));
  }

  async lookupIsrc(
    _context: ProviderRequestContext,
    isrc: string,
  ): Promise<readonly CatalogCandidate[]> {
    const normalized = isrc.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    if (!/^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/.test(normalized)) throw new Error("invalid ISRC");
    const body = await this.json(`/search?${new URLSearchParams({ q: `isrc:${normalized}`, type: "track", market: "US", limit: "10" })}`);
    const items = isRecord(body.tracks) && Array.isArray(body.tracks.items) ? body.tracks.items : [];
    return items.flatMap((item) => {
      const candidate = spotifyCandidate(item);
      return candidate ? [candidate] : [];
    });
  }

  async search(
    _context: ProviderRequestContext,
    query: ProviderCatalogQuery,
  ): Promise<readonly CatalogCandidate[]> {
    // Development-mode apps have a hard maximum of 10 results as of the
    // February 2026 Web API contract. Extended-quota apps accept this too.
    const limit = Math.min(10, Math.max(1, Math.trunc(query.limit)));
    const terms = [`track:${query.title}`, ...query.artists.map((artist) => `artist:${artist}`), ...(query.album ? [`album:${query.album}`] : [])];
    const body = await this.json(`/search?${new URLSearchParams({ q: terms.join(" "), type: "track", market: "US", limit: String(limit) })}`);
    const items = isRecord(body.tracks) && Array.isArray(body.tracks.items) ? body.tracks.items : [];
    return items.flatMap((item) => {
      const candidate = spotifyCandidate(item);
      return candidate ? [candidate] : [];
    });
  }

  async createPrivatePlaylist(
    _context: ProviderRequestContext,
    request: CreatePrivatePlaylistRequest,
  ): Promise<ProviderPlaylistSnapshot> {
    const body = await this.json(
      "/me/playlists",
      { method: "POST", body: JSON.stringify({ name: request.name, description: request.description, public: false }) },
      true,
    );
    const playlistId = stringValue(body.id);
    if (!playlistId) throw invalidProviderResponse("spotify", true);
    const destinationUrl = spotifyPlaylistUrl(isRecord(body.external_urls) ? body.external_urls.spotify : undefined, playlistId);
    return {
      provider: "spotify",
      playlistId,
      ...(destinationUrl ? { destinationUrl } : {}),
      ...(stringValue(body.snapshot_id) ? { revisionToken: String(body.snapshot_id) } : {}),
      items: [],
      observedAtMs: (this.options.now ?? Date.now)(),
    };
  }

  async readPlaylist(
    _context: ProviderRequestContext,
    playlistId: string,
  ): Promise<ProviderPlaylistSnapshot> {
    if (!playlistId.trim()) throw new Error("playlist ID is required");
    const summary = await this.json(`/playlists/${encodeURIComponent(playlistId)}?fields=snapshot_id,external_urls.spotify,name,description,public,owner.id,items.total`);
    const currentUser = await this.json("/me");
    const revisionToken = stringValue(summary.snapshot_id);
    const description = stringValue(summary.description);
    const ownerId = isRecord(summary.owner) ? stringValue(summary.owner.id) : undefined;
    const currentUserId = stringValue(currentUser.id);
    const rawItemCount = isRecord(summary.items) ? numberValue(summary.items.total) : undefined;
    const destinationUrl = spotifyPlaylistUrl(isRecord(summary.external_urls) ? summary.external_urls.spotify : undefined, playlistId);
    const items: { providerRecordingId: string; position: number }[] = [];
    let next: string | null = `${API}/playlists/${encodeURIComponent(playlistId)}/items?market=US&limit=50`;
    for (let page = 0; next && page < 100; page += 1) {
      const url: URL = new URL(next);
      if (url.origin !== "https://api.spotify.com" || !url.pathname.startsWith("/v1/playlists/")) {
        throw invalidProviderResponse("spotify");
      }
      const body = await providerJson(url, { headers: bearer(this.options.accessToken) }, { provider: "spotify", fetcher: this.options.fetcher, now: this.options.now }, objectResponse);
      const pageItems = Array.isArray(body.items) ? body.items : [];
      for (const item of pageItems) {
        const currentItem = isRecord(item) && isRecord(item.item) ? item.item : undefined;
        const legacyTrack = isRecord(item) && isRecord(item.track) ? item.track : undefined;
        const track = currentItem?.type === "track" ? currentItem : legacyTrack;
        const id = track ? stringValue(track.id) : undefined;
        if (id) items.push({ providerRecordingId: id, position: items.length });
      }
      next = body.next === null ? null : stringValue(body.next) ?? null;
    }
    return {
      provider: "spotify",
      playlistId,
      ...(destinationUrl ? { destinationUrl } : {}),
      ...(stringValue(summary.name) ? { name: stringValue(summary.name) } : {}),
      ...(description ? { recoveryMarker: recoveryMarkerFromDescription(description) } : {}),
      ...(rawItemCount === undefined ? {} : { rawItemCount }),
      ...(typeof summary.public === "boolean" ? { isPrivate: summary.public === false } : {}),
      ownershipVerified: Boolean(ownerId && currentUserId && ownerId === currentUserId),
      ...(revisionToken ? { revisionToken } : {}),
      items,
      observedAtMs: (this.options.now ?? Date.now)(),
    };
  }

  async appendItems(
    _context: ProviderRequestContext,
    request: AppendPlaylistItemsRequest,
  ): Promise<ProviderMutationReceipt> {
    if (request.providerRecordingIds.length === 0 || request.providerRecordingIds.length > 100) {
      throw new Error("Spotify append requires 1-100 recording IDs");
    }
    if (request.providerRecordingIds.some((id) => !SPOTIFY_ID.test(id))) throw new Error("invalid Spotify recording ID");
    const body = await this.json(
      `/playlists/${encodeURIComponent(request.playlistId)}/items`,
      { method: "POST", body: JSON.stringify({ uris: request.providerRecordingIds.map((id) => `spotify:track:${id}`) }) },
      true,
    );
    const revisionToken = stringValue(body.snapshot_id);
    if (!revisionToken) throw invalidProviderResponse("spotify", true);
    return { provider: "spotify", playlistId: request.playlistId, revisionToken, acceptedCount: request.providerRecordingIds.length };
  }
}
