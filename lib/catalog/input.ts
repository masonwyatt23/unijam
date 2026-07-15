import type { MusicProvider } from "../provider-state-engine.ts";

const SPOTIFY_TRACK_ID = /^[0-9A-Za-z]{22}$/;
const APPLE_MUSIC_ID = /^[0-9]+$/;
const MAX_TEXT_LENGTH = 500;

export type CatalogInputKind = "url" | "uri" | "text";

export interface ProviderRecordingIntent {
  readonly kind: "provider_recording";
  readonly inputKind: Exclude<CatalogInputKind, "text">;
  readonly provider: MusicProvider;
  readonly providerRecordingId: string;
  readonly storefront: "US";
  readonly source: string;
}

export interface TextRecordingIntent {
  readonly kind: "text_search";
  readonly inputKind: "text";
  readonly query: string;
  readonly title?: string;
  readonly artists: readonly string[];
  readonly storefront: "US";
  readonly source: string;
}

export interface UnsupportedCatalogInput {
  readonly kind: "unsupported";
  readonly reason:
    | "empty"
    | "too_long"
    | "unsupported_service"
    | "unsupported_provider_resource"
    | "invalid_provider_reference";
  readonly source: string;
}

export type CatalogInputIntent =
  | ProviderRecordingIntent
  | TextRecordingIntent
  | UnsupportedCatalogInput;

function providerIntent(
  provider: MusicProvider,
  providerRecordingId: string,
  inputKind: "url" | "uri",
  source: string,
): ProviderRecordingIntent {
  return Object.freeze({
    kind: "provider_recording",
    inputKind,
    provider,
    providerRecordingId,
    storefront: "US",
    source,
  });
}

function unsupported(
  reason: UnsupportedCatalogInput["reason"],
  source: string,
): UnsupportedCatalogInput {
  return Object.freeze({ kind: "unsupported", reason, source });
}

function parseSpotifyUri(source: string): CatalogInputIntent | undefined {
  if (!source.toLowerCase().startsWith("spotify:")) return undefined;
  const match = /^spotify:track:([0-9A-Za-z]{22})$/i.exec(source);
  return match
    ? providerIntent("spotify", match[1], "uri", source)
    : unsupported("unsupported_provider_resource", source);
}

function parseAppleMusicUri(source: string): CatalogInputIntent | undefined {
  if (!source.toLowerCase().startsWith("applemusic:")) return undefined;
  const match = /^applemusic:song:([0-9]+)$/i.exec(source);
  return match
    ? providerIntent("apple_music", match[1], "uri", source)
    : unsupported("unsupported_provider_resource", source);
}

function parseProviderUrl(source: string): CatalogInputIntent | undefined {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return undefined;
  }

  const isAppleNativeUri =
    url.protocol === "music:" && url.hostname.toLowerCase() === "music.apple.com";
  if (
    (url.protocol !== "https:" && !isAppleNativeUri) ||
    url.username ||
    url.password ||
    url.port
  ) {
    return unsupported("invalid_provider_reference", source);
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname === "open.spotify.com") {
    const parts = url.pathname.split("/").filter(Boolean);
    const offset = parts[0]?.startsWith("intl-") ? 1 : 0;
    if (parts[offset] !== "track" || parts.length !== offset + 2) {
      return unsupported("unsupported_provider_resource", source);
    }
    return SPOTIFY_TRACK_ID.test(parts[offset + 1])
      ? providerIntent("spotify", parts[offset + 1], "url", source)
      : unsupported("invalid_provider_reference", source);
  }

  if (hostname === "music.apple.com") {
    const parts = url.pathname.split("/").filter(Boolean);
    const storefront = parts[0]?.toLowerCase();
    if (storefront !== "us") {
      return unsupported("invalid_provider_reference", source);
    }
    const relationship = parts[1];
    const songId =
      relationship === "album" ? url.searchParams.get("i") :
      relationship === "song" ? parts.at(-1) : null;
    return songId && APPLE_MUSIC_ID.test(songId)
      ? providerIntent("apple_music", songId, isAppleNativeUri ? "uri" : "url", source)
      : unsupported("unsupported_provider_resource", source);
  }

  if (/spotify|apple|music/i.test(hostname)) {
    return unsupported("invalid_provider_reference", source);
  }
  return unsupported("unsupported_service", source);
}

/** Parses only catalog-safe Spotify, Apple Music, and neutral text inputs. */
export function parseCatalogInput(value: string): CatalogInputIntent {
  const source = value.trim();
  if (!source) return unsupported("empty", source);
  if (source.length > MAX_TEXT_LENGTH) return unsupported("too_long", source);

  const spotify = parseSpotifyUri(source);
  if (spotify) return spotify;
  const apple = parseAppleMusicUri(source);
  if (apple) return apple;

  if (/^(https?|music):/i.test(source)) {
    return parseProviderUrl(source) ?? unsupported("unsupported_service", source);
  }
  if (/^(tidal|youtube(?:music)?|soundcloud|deezer):/i.test(source)) {
    return unsupported("unsupported_service", source);
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
    return unsupported("unsupported_service", source);
  }

  const separator = source.match(/^(.{1,200}?)\s+[\-–—]\s+(.{1,200})$/);
  return Object.freeze({
    kind: "text_search",
    inputKind: "text",
    query: source.replace(/\s+/g, " "),
    ...(separator ? { artists: Object.freeze([separator[1].trim()]), title: separator[2].trim() } : { artists: Object.freeze([]) }),
    storefront: "US",
    source,
  });
}
