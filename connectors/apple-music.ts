import type { CatalogCandidate } from "../lib/catalog/resolver.ts";
import type {
  AppendPlaylistItemsRequest,
  CreatePrivatePlaylistRequest,
  ProviderAdapter,
  ProviderCatalogQuery,
  ProviderLibraryPage,
  ProviderLibraryPageRequest,
  ProviderLibrarySearchRequest,
  ProviderLibraryTrack,
  ProviderMutationReceipt,
  ProviderPlaylistSnapshot,
  ProviderRequestContext,
} from "../lib/providers/contracts.ts";
import { recoveryMarkerFromDescription } from "../lib/publishing/model.ts";
import { inferEdition, inferVersion, isRecord, numberValue, stringValue } from "./catalog-shape.ts";
import { invalidProviderResponse } from "./errors.ts";
import { providerFetch, providerJson } from "./http.ts";
import { encodeBase64Url } from "./storage.ts";

const API = "https://api.music.apple.com/v1";
const APPLE_CATALOG_ID = /^[0-9]+$/;
const APPLE_LIBRARY_ID = /^[0-9A-Za-z._-]+$/;
const APPLE_CURSOR = /^[0-9A-Za-z._~-]{1,200}$/;

export interface AppleMusicAdapterOptions {
  readonly developerToken: string;
  readonly musicUserToken?: string;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
}

function objectResponse(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}

function appleMusicPlaylistUrl(value: unknown): string | undefined {
  const raw = stringValue(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname === "music.apple.com" && url.pathname.startsWith("/us/playlist/")
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function appleMusicSongUrl(id: string): string {
  return `https://music.apple.com/us/song/${id}`;
}

function appleMusicArtwork(value: unknown): { url: string; width: number; height: number } | undefined {
  if (!isRecord(value)) return undefined;
  const template = stringValue(value.url);
  const maxWidth = numberValue(value.width);
  const maxHeight = numberValue(value.height);
  if (!template || maxWidth === undefined || maxHeight === undefined || !Number.isSafeInteger(maxWidth) || !Number.isSafeInteger(maxHeight) || maxWidth <= 0 || maxHeight <= 0 || maxWidth > 10_000 || maxHeight > 10_000) {
    return undefined;
  }
  try {
    const parsed = new URL(template);
    if (
      parsed.protocol !== "https:" || !/^(?:is[0-9]+-ssl\.)?mzstatic\.com$/.test(parsed.hostname) ||
      parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash ||
      !parsed.pathname.startsWith("/image/thumb/") ||
      (template.match(/\{w\}/g)?.length ?? 0) !== 1 || (template.match(/\{h\}/g)?.length ?? 0) !== 1
    ) return undefined;
    const size = Math.min(300, maxWidth, maxHeight);
    const resolved = new URL(template.replace("{w}", String(size)).replace("{h}", String(size)));
    return { url: resolved.href, width: size, height: size };
  } catch {
    return undefined;
  }
}

function appleCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined;
  if (!APPLE_CURSOR.test(cursor)) throw new Error("invalid Apple Music library cursor");
  return cursor;
}

function appleNextCursor(value: unknown, expectedPath: string): string | null {
  if (value === null || value === undefined) return null;
  const raw = stringValue(value);
  if (!raw) throw invalidProviderResponse("apple_music");
  let url: URL;
  try { url = new URL(raw, API); }
  catch { throw invalidProviderResponse("apple_music"); }
  const offset = url.searchParams.get("offset");
  if (url.origin !== new URL(API).origin || url.pathname !== expectedPath || !offset || !APPLE_CURSOR.test(offset)) {
    throw invalidProviderResponse("apple_music");
  }
  return offset;
}

function appleMusicDescription(value: unknown): string | undefined {
  return stringValue(value) ?? (isRecord(value) ? stringValue(value.standard) : undefined);
}

function songCandidate(value: unknown): CatalogCandidate | null {
  if (!isRecord(value) || value.type !== "songs") return null;
  const id = stringValue(value.id);
  const attributes = isRecord(value.attributes) ? value.attributes : undefined;
  const title = attributes ? stringValue(attributes.name) : undefined;
  const artist = attributes ? stringValue(attributes.artistName) : undefined;
  if (!id || !title || !artist) return null;
  const album = stringValue(attributes?.albumName);
  const durationMs = numberValue(attributes?.durationInMillis);
  const isrc = stringValue(attributes?.isrc);
  const artwork = appleMusicArtwork(attributes?.artwork);
  return {
    provider: "apple_music",
    providerRecordingId: id,
    title,
    artists: [artist],
    ...(album ? { album } : {}),
    ...(artwork ? { artwork } : {}),
    providerUrl: appleMusicSongUrl(id),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(isrc ? { isrc } : {}),
    ...(attributes?.contentRating === "explicit" ? { explicit: true } : attributes?.contentRating === "clean" ? { explicit: false } : {}),
    version: inferVersion(title, album),
    edition: inferEdition(album),
    storefronts: ["US"],
  };
}

function appleLibraryTrack(value: unknown): ProviderLibraryTrack | null {
  if (!isRecord(value) || value.type !== "library-songs") return null;
  const libraryItemId = stringValue(value.id);
  const attributes = isRecord(value.attributes) ? value.attributes : undefined;
  const playParams = attributes && isRecord(attributes.playParams) ? attributes.playParams : undefined;
  const catalogId = stringValue(playParams?.catalogId);
  const title = stringValue(attributes?.name);
  const artist = stringValue(attributes?.artistName);
  if (!libraryItemId || !APPLE_LIBRARY_ID.test(libraryItemId) || !catalogId || !APPLE_CATALOG_ID.test(catalogId) || !title || !artist) return null;
  const album = stringValue(attributes?.albumName);
  const durationMs = numberValue(attributes?.durationInMillis);
  const artwork = appleMusicArtwork(attributes?.artwork);
  const addedAt = stringValue(attributes?.dateAdded);
  return {
    provider: "apple_music",
    providerRecordingId: catalogId,
    libraryItemId,
    title,
    artists: [artist],
    ...(album ? { album } : {}),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(attributes?.contentRating === "explicit" ? { explicit: true } : attributes?.contentRating === "clean" ? { explicit: false } : {}),
    ...(artwork ? { artwork } : {}),
    providerUrl: appleMusicSongUrl(catalogId),
    ...(addedAt && Number.isFinite(Date.parse(addedAt)) ? { addedAt } : {}),
  };
}

export class AppleMusicAdapter implements ProviderAdapter {
  readonly provider = "apple_music" as const;
  private readonly options: AppleMusicAdapterOptions;

  constructor(options: AppleMusicAdapterOptions) {
    if (!options.developerToken.trim()) throw new Error("Apple developer token is required");
    this.options = options;
  }

  private headers(json = false, personalized = false): HeadersInit {
    if (personalized && !this.options.musicUserToken) throw new Error("Music User Token is required");
    return {
      Authorization: `Bearer ${this.options.developerToken}`,
      ...(personalized ? { "Music-User-Token": this.options.musicUserToken! } : {}),
      ...(json ? { "Content-Type": "application/json" } : {}),
    };
  }

  private async json(
    path: string,
    init: RequestInit = {},
    mutation = false,
    personalized = false,
  ): Promise<Record<string, unknown>> {
    return providerJson(
      `${API}${path}`,
      { ...init, headers: { ...this.headers(Boolean(init.body), personalized), ...init.headers } },
      { provider: "apple_music", fetcher: this.options.fetcher, now: this.options.now, mutation },
      objectResponse,
    );
  }

  async validateMusicUserToken(): Promise<"US"> {
    const body = await this.json("/me/storefront", {}, false, true);
    const data = Array.isArray(body.data) ? body.data : [];
    const storefront = data[0] && isRecord(data[0]) ? stringValue(data[0].id) : undefined;
    if (storefront?.toLowerCase() !== "us") {
      if (storefront) throw new Error("Apple Music pilot requires the US storefront");
      throw invalidProviderResponse("apple_music");
    }
    return "US";
  }

  async getRecording(
    _context: ProviderRequestContext,
    providerRecordingId: string,
  ): Promise<CatalogCandidate | null> {
    if (!APPLE_CATALOG_ID.test(providerRecordingId)) throw new Error("invalid Apple Music recording ID");
    const body = await this.json(`/catalog/us/songs/${providerRecordingId}`);
    return Array.isArray(body.data) ? songCandidate(body.data[0]) : null;
  }

  async lookupIsrc(
    _context: ProviderRequestContext,
    isrc: string,
  ): Promise<readonly CatalogCandidate[]> {
    const normalized = isrc.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    if (!/^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/.test(normalized)) throw new Error("invalid ISRC");
    const body = await this.json(`/catalog/us/songs?${new URLSearchParams({ "filter[isrc]": normalized, limit: "25" })}`);
    return (Array.isArray(body.data) ? body.data : []).flatMap((item) => {
      const candidate = songCandidate(item);
      return candidate ? [candidate] : [];
    });
  }

  async search(
    _context: ProviderRequestContext,
    query: ProviderCatalogQuery,
  ): Promise<readonly CatalogCandidate[]> {
    const limit = Math.min(25, Math.max(1, Math.trunc(query.limit)));
    const term = [query.title, ...query.artists, query.album].filter(Boolean).join(" ");
    const body = await this.json(`/catalog/us/search?${new URLSearchParams({ term, types: "songs", limit: String(limit) })}`);
    const songs = isRecord(body.results) && isRecord(body.results.songs) && Array.isArray(body.results.songs.data)
      ? body.results.songs.data
      : [];
    return songs.flatMap((item) => {
      const candidate = songCandidate(item);
      return candidate ? [candidate] : [];
    });
  }

  async libraryTracks(
    _context: ProviderRequestContext,
    request: ProviderLibraryPageRequest,
  ): Promise<ProviderLibraryPage> {
    const limit = Math.min(20, Math.max(1, Math.trunc(request.limit)));
    const cursor = appleCursor(request.cursor);
    const body = await this.json(`/me/library/songs?${new URLSearchParams({ limit: String(limit), ...(cursor ? { offset: cursor } : {}) })}`, {}, false, true);
    const items = (Array.isArray(body.data) ? body.data : []).flatMap((item) => {
      const track = appleLibraryTrack(item);
      return track ? [track] : [];
    });
    const meta = isRecord(body.meta) ? body.meta : undefined;
    const total = numberValue(meta?.total);
    return {
      items,
      nextCursor: appleNextCursor(body.next, "/v1/me/library/songs"),
      ...(total !== undefined && Number.isSafeInteger(total) && total >= 0 ? { total } : {}),
    };
  }

  async searchLibrary(
    _context: ProviderRequestContext,
    request: ProviderLibrarySearchRequest,
  ): Promise<ProviderLibraryPage> {
    const query = request.query.trim();
    if (!query || query.length > 200) throw new Error("invalid Apple Music library search query");
    const limit = Math.min(20, Math.max(1, Math.trunc(request.limit)));
    const cursor = appleCursor(request.cursor);
    const body = await this.json(`/me/library/search?${new URLSearchParams({ term: query, types: "library-songs", limit: String(limit), ...(cursor ? { offset: cursor } : {}) })}`, {}, false, true);
    const results = isRecord(body.results) ? body.results : undefined;
    const songs = results && isRecord(results["library-songs"]) ? results["library-songs"] : undefined;
    const items = songs && Array.isArray(songs.data) ? songs.data.flatMap((item) => {
      const track = appleLibraryTrack(item);
      return track ? [track] : [];
    }) : [];
    return {
      items,
      nextCursor: appleNextCursor(songs?.next, "/v1/me/library/search"),
    };
  }

  async createPrivatePlaylist(
    _context: ProviderRequestContext,
    request: CreatePrivatePlaylistRequest,
  ): Promise<ProviderPlaylistSnapshot> {
    const body = await this.json(
      "/me/library/playlists",
      { method: "POST", body: JSON.stringify({ attributes: { name: request.name, description: request.description } }) },
      true,
      true,
    );
    const data = Array.isArray(body.data) ? body.data : [];
    const playlistId = data[0] && isRecord(data[0]) ? stringValue(data[0].id) : undefined;
    if (!playlistId) throw invalidProviderResponse("apple_music", true);
    const attributes = data[0] && isRecord(data[0]) && isRecord(data[0].attributes) ? data[0].attributes : undefined;
    const destinationUrl = appleMusicPlaylistUrl(attributes?.url);
    return {
      provider: "apple_music",
      playlistId,
      ...(destinationUrl ? { destinationUrl } : {}),
      items: [],
      observedAtMs: (this.options.now ?? Date.now)(),
    };
  }

  async readPlaylist(
    _context: ProviderRequestContext,
    playlistId: string,
  ): Promise<ProviderPlaylistSnapshot> {
    if (!playlistId.trim()) throw new Error("playlist ID is required");
    const summary = await this.json(`/me/library/playlists/${encodeURIComponent(playlistId)}`, {}, false, true);
    const summaryData = Array.isArray(summary.data) && isRecord(summary.data[0]) ? summary.data[0] : undefined;
    const attributes = summaryData && isRecord(summaryData.attributes) ? summaryData.attributes : undefined;
    const description = appleMusicDescription(attributes?.description);
    const items: { providerRecordingId: string; position: number }[] = [];
    let rawItemCount = 0;
    let next: string | null = `${API}/me/library/playlists/${encodeURIComponent(playlistId)}/tracks?limit=100`;
    for (let page = 0; next && page < 100; page += 1) {
      const url: URL = new URL(next, API);
      if (url.origin !== "https://api.music.apple.com" || !url.pathname.startsWith("/v1/me/library/playlists/")) {
        throw invalidProviderResponse("apple_music");
      }
      const body = await providerJson(url, { headers: this.headers(false, true) }, { provider: "apple_music", fetcher: this.options.fetcher, now: this.options.now }, objectResponse);
      for (const item of Array.isArray(body.data) ? body.data : []) {
        rawItemCount += 1;
        const itemAttributes = isRecord(item) && isRecord(item.attributes) ? item.attributes : undefined;
        const playParams = itemAttributes && isRecord(itemAttributes.playParams) ? itemAttributes.playParams : undefined;
        const catalogId = stringValue(playParams?.catalogId);
        if (!catalogId || !APPLE_CATALOG_ID.test(catalogId)) throw invalidProviderResponse("apple_music");
        items.push({ providerRecordingId: catalogId, position: items.length });
      }
      next = body.next === null ? null : stringValue(body.next) ?? null;
    }
    return {
      provider: "apple_music",
      playlistId,
      ...(stringValue(attributes?.url) && appleMusicPlaylistUrl(attributes?.url) ? { destinationUrl: appleMusicPlaylistUrl(attributes?.url) } : {}),
      ...(stringValue(attributes?.name) ? { name: stringValue(attributes?.name) } : {}),
      ...(description ? { recoveryMarker: recoveryMarkerFromDescription(description) } : {}),
      rawItemCount,
      ...(typeof attributes?.isPublic === "boolean" ? { isPrivate: attributes.isPublic === false } : {}),
      ownershipVerified: attributes?.canEdit === true,
      items,
      observedAtMs: (this.options.now ?? Date.now)(),
    };
  }

  async appendItems(
    _context: ProviderRequestContext,
    request: AppendPlaylistItemsRequest,
  ): Promise<ProviderMutationReceipt> {
    if (request.providerRecordingIds.length === 0 || request.providerRecordingIds.length > 100) {
      throw new Error("Apple Music append requires 1-100 recording IDs");
    }
    if (request.providerRecordingIds.some((id) => !APPLE_CATALOG_ID.test(id))) throw new Error("invalid Apple Music recording ID");
    await providerFetch(
      `${API}/me/library/playlists/${encodeURIComponent(request.playlistId)}/tracks`,
      {
        method: "POST",
        headers: this.headers(true, true),
        body: JSON.stringify({ data: request.providerRecordingIds.map((id) => ({ id, type: "songs" })) }),
      },
      { provider: "apple_music", fetcher: this.options.fetcher, now: this.options.now, mutation: true },
    );
    return { provider: "apple_music", playlistId: request.playlistId, acceptedCount: request.providerRecordingIds.length };
  }
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

/** Creates a short-lived Apple developer JWT; private key material stays in the connector. */
export async function createAppleDeveloperToken(input: {
  readonly teamId: string;
  readonly keyId: string;
  readonly privateKeyJwk: JsonWebKey;
  readonly nowMs: number;
  readonly lifetimeSeconds?: number;
  /** Restricts a browser-exposed token to one exact MusicKit web origin. */
  readonly origin?: string;
}): Promise<string> {
  const lifetime = input.lifetimeSeconds ?? 900;
  if (!Number.isInteger(lifetime) || lifetime < 60 || lifetime > 3_600) throw new Error("Apple developer token lifetime must be 60-3600 seconds");
  const issuedAt = Math.floor(input.nowMs / 1_000);
  const header = encodeBase64Url(new TextEncoder().encode(JSON.stringify({ alg: "ES256", kid: input.keyId, typ: "JWT" })));
  let origin: string | undefined;
  if (input.origin !== undefined) {
    const url = new URL(input.origin);
    if (
      url.toString() !== `${url.origin}/` ||
      url.protocol !== "https:" ||
      (url.hostname !== "unijam.ashlr.ai" && url.hostname !== "staging.unijam.ashlr.ai")
    ) {
      throw new Error("Apple developer token origin must be an exact UniJam HTTPS origin");
    }
    origin = url.origin;
  }
  const claims = encodeBase64Url(new TextEncoder().encode(JSON.stringify({
    iss: input.teamId,
    iat: issuedAt,
    exp: issuedAt + lifetime,
    ...(origin ? { origin: [origin] } : {}),
  })));
  const signingInput = `${header}.${claims}`;
  const key = await crypto.subtle.importKey("jwk", input.privateKeyJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, asArrayBuffer(new TextEncoder().encode(signingInput)));
  return `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`;
}
