import { env } from "cloudflare:workers";

import { parseCatalogInput } from "@/lib/catalog/input";
import { resolveUsCatalogRecording, type CatalogCandidate, type ResolutionRequest } from "@/lib/catalog/resolver";
import { apiError, apiResponse } from "@/lib/server/api-response";
import {
  normalizeCatalogText,
  parseConnectorCandidate,
  parseConnectorEnvelope,
  resolutionRequestForCandidate,
  stableRecordingIdentity,
} from "@/lib/server/catalog-resolution";
import { connectorJsonRequest, type ConnectorProxyEnv } from "@/lib/server/connector-proxy";
import { authenticateRoomActor, normalizeV1RoomId, type RoomAuthorityEnv } from "@/lib/server/room-authority";
import { createProviderHandoffLinks } from "@/lib/providers/handoff";
import type { MusicProvider } from "@/lib/provider-state-engine";

type Context = { params: Promise<{ roomId: string }> };

function requestedProvider(value: unknown): MusicProvider | null {
  if (value === "spotify") return "spotify";
  if (value === "apple_music" || value === "apple-music") return "apple_music";
  return null;
}

function connectorFailure(status: number): Response {
  if (status === 401) return apiError("PROVIDER_RECONNECT_REQUIRED", "Reconnect this music service before resolving tracks", 401);
  if (status === 403) return apiError("PILOT_NOT_ALLOWED", "This host is not enabled for the provider pilot", 403);
  if (status === 404) return apiError("PROVIDER_NOT_CONNECTED", "Connect this music service before resolving tracks", 409);
  if (status === 429) return apiError("PROVIDER_RATE_LIMITED", "The music service is rate limited; try again shortly", 429, true);
  return apiError("PROVIDER_UNAVAILABLE", "This music service could not resolve the track", status >= 500 ? 503 : 422, status >= 500);
}

async function persistMatch(db: D1Database, candidate: CatalogCandidate, method: "provider_id" | "metadata", evidence: readonly string[]) {
  const identity = await stableRecordingIdentity(candidate);
  const now = Date.now();
  const normalizedTitle = normalizeCatalogText(candidate.title);
  const normalizedArtist = normalizeCatalogText(candidate.artists.join(", "));
  await db.batch([
    db.prepare(
      `INSERT INTO canonical_recordings
       (recording_id, isrc, normalized_title, normalized_artist, album, duration_ms, explicit, version_label, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(recording_id) DO UPDATE SET
         isrc = COALESCE(canonical_recordings.isrc, excluded.isrc),
         normalized_title = excluded.normalized_title,
         normalized_artist = excluded.normalized_artist,
         album = COALESCE(excluded.album, canonical_recordings.album),
         duration_ms = COALESCE(excluded.duration_ms, canonical_recordings.duration_ms),
         explicit = COALESCE(excluded.explicit, canonical_recordings.explicit),
         version_label = COALESCE(excluded.version_label, canonical_recordings.version_label),
         updated_at_ms = excluded.updated_at_ms`,
    ).bind(
      identity.recordingId, candidate.isrc ?? null, normalizedTitle, normalizedArtist, candidate.album ?? null,
      candidate.durationMs ?? null, candidate.explicit === undefined ? null : candidate.explicit ? 1 : 0,
      candidate.version ?? null, now, now,
    ),
    db.prepare(
      `INSERT INTO provider_matches
       (match_id, recording_id, provider, storefront, provider_recording_id, method, confidence_basis_json, status, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, 'us', ?, ?, ?, 'matched', ?, ?)
       ON CONFLICT(recording_id, provider, storefront) DO UPDATE SET
         provider_recording_id = excluded.provider_recording_id,
         method = excluded.method,
         confidence_basis_json = excluded.confidence_basis_json,
         status = 'matched',
         updated_at_ms = excluded.updated_at_ms`,
    ).bind(
      identity.matchId, identity.recordingId, candidate.provider, candidate.providerRecordingId, method,
      JSON.stringify({ evidence, deterministic: true, storefront: "US" }), now, now,
    ),
  ]);
  return identity.recordingId;
}

export async function POST(request: Request, context: Context): Promise<Response> {
  if (!env.DB || !env.ROOM_OBJECTS || !env.CONNECTORS) return apiError("RESOLUTION_UNAVAILABLE", "Catalog resolution is unavailable", 503, true);
  try {
    const roomId = normalizeV1RoomId((await context.params).roomId);
    const access = await authenticateRoomActor(env as RoomAuthorityEnv, request, roomId);
    if (!access) return apiError("UNAUTHENTICATED", "Join this room before resolving a contribution", 401);
    const body = await request.json() as { input?: unknown; provider?: unknown };
    if (typeof body.input !== "string") return apiError("INVALID_CATALOG_INPUT", "Enter a track link or search", 400);
    const intent = parseCatalogInput(body.input);
    if (intent.kind === "unsupported") {
      return apiError("UNSUPPORTED_SOURCE", "Use a Spotify link, Apple Music link, or plain track text", 422);
    }
    const provider = intent.kind === "provider_recording" ? intent.provider : requestedProvider(body.provider);
    if (!provider) return apiError("PROVIDER_REQUIRED", "Choose Spotify or Apple Music for text search", 400);
    const publicProvider = provider === "apple_music" ? "apple-music" : provider;
    const queryBody: Record<string, unknown> = {
      accountId: access.registry.owner_account_id,
      connectionId: `${publicProvider}:${access.registry.owner_account_id}`,
      provider,
      ...(intent.kind === "provider_recording"
        ? { mode: "recording_id", providerRecordingId: intent.providerRecordingId }
        : { mode: "search", query: { title: intent.title ?? intent.query, artists: intent.artists, limit: 10 } }),
    };
    const connector = await connectorJsonRequest(env as ConnectorProxyEnv, "/v1/catalog/query", queryBody);
    if (!connector.ok) return connectorFailure(connector.status);
    const envelope = parseConnectorEnvelope(await connector.json());
    if (!envelope || envelope.error) return apiError("PROVIDER_UNAVAILABLE", "This music service returned an invalid result", 502, true);
    const rawCandidates = intent.kind === "provider_recording" ? [envelope.data] : Array.isArray(envelope.data) ? envelope.data : [];
    const candidates = rawCandidates.flatMap((value) => {
      const parsed = parseConnectorCandidate(value, provider);
      return parsed ? [parsed] : [];
    });
    const resolutionRequest: ResolutionRequest = intent.kind === "provider_recording" && candidates[0]
      ? resolutionRequestForCandidate(candidates[0])
      : { provider, storefront: "US", title: intent.kind === "text_search" ? intent.title ?? intent.query : "", artists: intent.kind === "text_search" ? intent.artists : [] };
    const resolution = resolveUsCatalogRecording(resolutionRequest, candidates);
    if (resolution.status === "hold") {
      return apiResponse({
        ...resolution,
        candidates: resolution.candidates.map((entry) => ({
          ...entry,
          candidate: {
            ...entry.candidate,
            providerUrl: createProviderHandoffLinks(entry.candidate.provider, entry.candidate.providerRecordingId).universalUrl,
          },
        })),
      });
    }
    if (resolution.status === "no_match") return apiResponse(resolution);
    const candidate = resolution.match.candidate;
    const providerUrl = createProviderHandoffLinks(candidate.provider, candidate.providerRecordingId).universalUrl;
    const recordingId = await persistMatch(env.DB, candidate, intent.kind === "provider_recording" ? "provider_id" : "metadata", resolution.match.evidence);
    return apiResponse({
      status: "matched",
      storefront: "US",
      recordingId,
      title: candidate.title,
      artists: candidate.artists,
      album: candidate.album ?? null,
      explicit: candidate.explicit ?? null,
      version: candidate.version ?? "unknown",
      provider: candidate.provider === "apple_music" ? "apple-music" : candidate.provider,
      providerRecordingId: candidate.providerRecordingId,
      providerUrl,
      evidence: resolution.match.evidence,
    });
  } catch {
    return apiError("RESOLUTION_FAILED", "The contribution could not be resolved", 400);
  }
}
