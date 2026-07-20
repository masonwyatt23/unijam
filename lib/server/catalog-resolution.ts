import type { CatalogCandidate, ResolutionRequest, ScoredCatalogCandidate } from "../catalog/resolver.ts";
import type { MusicProvider } from "../provider-state-engine.ts";
import { hashOpaqueToken } from "./secure-token.ts";

type ConnectorEnvelope = {
  data?: unknown;
  error?: { code?: unknown; message?: unknown; retryAtMs?: unknown } | null;
  requestId?: unknown;
};

const VERSION_VALUES = new Set(["studio", "live", "remix", "acoustic", "radio_edit", "unknown"]);
const EDITION_VALUES = new Set(["standard", "deluxe", "expanded", "unknown"]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validatedProviderUrl(provider: MusicProvider, providerRecordingId: string, value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    const expectedPath = provider === "spotify" ? `/track/${providerRecordingId}` : `/us/song/${providerRecordingId}`;
    const expectedHost = provider === "spotify" ? "open.spotify.com" : "music.apple.com";
    return url.protocol === "https:" && url.hostname === expectedHost && url.pathname === expectedPath &&
      !url.username && !url.password && !url.port && !url.search && !url.hash
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function validatedArtwork(provider: MusicProvider, value: unknown) {
  const source = record(value);
  if (!source || typeof source.url !== "string" || !Number.isSafeInteger(source.width) || !Number.isSafeInteger(source.height)) return undefined;
  const width = Number(source.width);
  const height = Number(source.height);
  if (width <= 0 || height <= 0 || width > 10_000 || height > 10_000) return undefined;
  try {
    const url = new URL(source.url);
    const validSpotify = provider === "spotify" && url.hostname === "i.scdn.co" && /^\/image\/[0-9A-Za-z]+$/.test(url.pathname);
    const validApple = provider === "apple_music" && /^(?:is[0-9]+-ssl\.)?mzstatic\.com$/.test(url.hostname) && url.pathname.startsWith("/image/thumb/");
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || (!validSpotify && !validApple)) return undefined;
    return { url: url.href, width, height };
  } catch {
    return undefined;
  }
}

export function parseConnectorCandidate(value: unknown, provider: MusicProvider): CatalogCandidate | null {
  const source = record(value);
  if (!source || source.provider !== provider) return null;
  const providerRecordingId = typeof source.providerRecordingId === "string" ? source.providerRecordingId.trim() : "";
  const title = typeof source.title === "string" ? source.title.trim() : "";
  const artists = Array.isArray(source.artists)
    ? source.artists.filter((artist): artist is string => typeof artist === "string").map((artist) => artist.trim()).filter(Boolean)
    : [];
  if (!providerRecordingId || !title || artists.length === 0) return null;
  const storefronts = Array.isArray(source.storefronts)
    ? source.storefronts.filter((storefront): storefront is string => typeof storefront === "string")
    : undefined;
  const artwork = validatedArtwork(provider, source.artwork);
  const providerUrl = validatedProviderUrl(provider, providerRecordingId, source.providerUrl);
  const version = typeof source.version === "string" && VERSION_VALUES.has(source.version)
    ? source.version as CatalogCandidate["version"]
    : undefined;
  const edition = typeof source.edition === "string" && EDITION_VALUES.has(source.edition)
    ? source.edition as CatalogCandidate["edition"]
    : undefined;
  return {
    provider,
    providerRecordingId,
    title,
    artists,
    ...(typeof source.album === "string" && source.album.trim() ? { album: source.album.trim() } : {}),
    ...(typeof source.durationMs === "number" && Number.isSafeInteger(source.durationMs) && source.durationMs >= 0 ? { durationMs: source.durationMs } : {}),
    ...(typeof source.isrc === "string" && source.isrc.trim() ? { isrc: source.isrc.trim().toUpperCase() } : {}),
    ...(typeof source.explicit === "boolean" ? { explicit: source.explicit } : {}),
    ...(version ? { version } : {}),
    ...(edition ? { edition } : {}),
    ...(artwork ? { artwork } : {}),
    ...(providerUrl ? { providerUrl } : {}),
    ...(storefronts ? { storefronts } : {}),
  };
}

export function parseConnectorEnvelope(value: unknown): ConnectorEnvelope | null {
  const envelope = record(value);
  return envelope ? envelope as ConnectorEnvelope : null;
}

export function parseSpotifyOEmbedSource(value: unknown, expectedRecordingId: string): {
  readonly provider: "spotify";
  readonly providerRecordingId: string;
  readonly title: string;
  readonly metadataComplete: false;
} | null {
  const source = record(value);
  if (
    !source || source.provider !== "spotify" || source.providerRecordingId !== expectedRecordingId ||
    source.metadataComplete !== false || typeof source.title !== "string"
  ) return null;
  const title = source.title.trim();
  return title && title.length <= 500
    ? { provider: "spotify", providerRecordingId: expectedRecordingId, title, metadataComplete: false }
    : null;
}

export function resolutionRequestForCandidate(candidate: CatalogCandidate): ResolutionRequest {
  return {
    provider: candidate.provider,
    providerRecordingId: candidate.providerRecordingId,
    storefront: "US",
    title: candidate.title,
    artists: candidate.artists,
    ...(candidate.album ? { album: candidate.album } : {}),
    ...(candidate.durationMs === undefined ? {} : { durationMs: candidate.durationMs }),
    ...(candidate.isrc ? { isrc: candidate.isrc } : {}),
    ...(candidate.explicit === undefined ? {} : { explicit: candidate.explicit }),
    ...(candidate.version ? { version: candidate.version } : {}),
    ...(candidate.edition ? { edition: candidate.edition } : {}),
  };
}

export async function stableRecordingIdentity(
  candidate: CatalogCandidate,
  basis: "canonical" | "provider" = "canonical",
): Promise<{
  recordingId: string;
  matchId: string;
}> {
  const normalizedIsrc = candidate.isrc?.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const recordingBasis = basis === "canonical" && normalizedIsrc
    ? `isrc:${normalizedIsrc}`
    : `${candidate.provider}:${candidate.providerRecordingId}`;
  const [recordingHash, matchHash] = await Promise.all([
    hashOpaqueToken(`unijam-recording-v1:${recordingBasis}`),
    hashOpaqueToken(`unijam-provider-match-v1:${candidate.provider}:${candidate.providerRecordingId}`),
  ]);
  return { recordingId: `rec_${recordingHash.slice(0, 32)}`, matchId: `match_${matchHash.slice(0, 32)}` };
}

export function normalizeCatalogText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function reviewTokens(value: string): Set<string> {
  return new Set(value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean));
}

function titleReviewScore(sourceTitle: string, candidateTitle: string): number {
  const source = reviewTokens(sourceTitle);
  const candidate = reviewTokens(candidateTitle);
  if (source.size === 0 || candidate.size === 0) return 0;
  let shared = 0;
  for (const token of source) if (candidate.has(token)) shared += 1;
  return shared / new Set([...source, ...candidate]).size;
}

/**
 * Lists at most three US catalog choices for an incomplete, title-only source.
 * This intentionally returns candidates rather than a CatalogResolution so no
 * score can ever be interpreted as permission to auto-match or auto-stage.
 */
export function titleOnlyReviewCandidates(
  sourceTitle: string,
  provider: MusicProvider,
  candidates: readonly CatalogCandidate[],
): readonly ScoredCatalogCandidate[] {
  const seen = new Set<string>();
  return candidates
    .flatMap((candidate): ScoredCatalogCandidate[] => {
      if (candidate.provider !== provider || seen.has(candidate.providerRecordingId)) return [];
      if (!candidate.storefronts?.some((storefront) => storefront.toUpperCase() === "US")) return [];
      const score = titleReviewScore(sourceTitle, candidate.title);
      if (score < 0.5) return [];
      seen.add(candidate.providerRecordingId);
      return [{ candidate, score: Math.round(score * 10_000) / 10_000, evidence: score === 1 ? ["title"] : [], conflicts: [] }];
    })
    .sort((left, right) => right.score - left.score || left.candidate.providerRecordingId.localeCompare(right.candidate.providerRecordingId))
    .slice(0, 3);
}
