import type { CatalogCandidate, ResolutionRequest } from "../catalog/resolver.ts";
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

export async function stableRecordingIdentity(candidate: CatalogCandidate): Promise<{
  recordingId: string;
  matchId: string;
}> {
  const normalizedIsrc = candidate.isrc?.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const recordingBasis = normalizedIsrc
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
