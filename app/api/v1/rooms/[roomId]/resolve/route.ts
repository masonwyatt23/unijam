import { env } from "cloudflare:workers";

import { parseCatalogInput } from "@/lib/catalog/input";
import { resolveUsCatalogRecording, type CatalogCandidate, type ResolutionRequest } from "@/lib/catalog/resolver";
import { apiError, apiResponse } from "@/lib/server/api-response";
import {
  normalizeCatalogText,
  parseConnectorCandidate,
  parseConnectorEnvelope,
  parseSpotifyOEmbedSource,
  resolutionRequestForCandidate,
  stableRecordingIdentity,
  titleOnlyReviewCandidates,
} from "@/lib/server/catalog-resolution";
import { catalogPrincipalForRoom } from "@/lib/server/catalog-principal";
import {
  catalogResolutionRateLimitResponse,
  withCatalogResolutionBudget,
} from "@/lib/server/catalog-resolution-rate-limit";
import { connectorJsonRequest, type ConnectorProxyEnv } from "@/lib/server/connector-proxy";
import { actorHeaders, authenticateRoomActor, normalizeV1RoomId, roomStub, type RoomAuthorityEnv } from "@/lib/server/room-authority";
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
  if (status === 403) return apiError("PILOT_NOT_ALLOWED", "This account is not enabled for the provider pilot", 403);
  if (status === 404) return apiError("PROVIDER_NOT_CONNECTED", "Connect this music service before resolving tracks", 409);
  if (status === 429) return apiError("PROVIDER_RATE_LIMITED", "The music service is rate limited; try again shortly", 429, true);
  return apiError("PROVIDER_UNAVAILABLE", "This music service could not resolve the track", status >= 500 ? 503 : 422, status >= 500);
}

async function persistMatch(
  db: D1Database,
  candidate: CatalogCandidate,
  method: "provider_id" | "metadata",
  evidence: readonly string[],
  options: { identityBasis?: "canonical" | "provider"; deterministic?: boolean } = {},
) {
  const identity = await stableRecordingIdentity(candidate, options.identityBasis);
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
      JSON.stringify({ evidence, deterministic: options.deterministic ?? true, storefront: "US" }), now, now,
    ),
  ]);
  return identity;
}

type RoomAccess = NonNullable<Awaited<ReturnType<typeof authenticateRoomActor>>>;

async function connectorData(runtime: ConnectorProxyEnv, path: string, body: Record<string, unknown>): Promise<unknown | Response> {
  const connector = await connectorJsonRequest(runtime, path, body);
  if (!connector.ok) return connectorFailure(connector.status);
  const envelope = parseConnectorEnvelope(await connector.json());
  if (!envelope || envelope.error) return apiError("PROVIDER_UNAVAILABLE", "This music service returned an invalid result", 502, true);
  return envelope.data;
}

async function registerCandidateGrant(input: {
  readonly db: D1Database;
  readonly roomEnv: RoomAuthorityEnv;
  readonly roomId: string;
  readonly access: RoomAccess;
  readonly candidate: CatalogCandidate;
  readonly method: "provider_id" | "metadata";
  readonly evidence: readonly string[];
  readonly identityBasis?: "canonical" | "provider";
  readonly deterministic?: boolean;
}): Promise<Response | {
  readonly resolutionId: string;
  readonly recordingId: string;
  readonly providerUrl: string;
}> {
  const identity = await persistMatch(input.db, input.candidate, input.method, input.evidence, {
    identityBasis: input.identityBasis,
    deterministic: input.deterministic,
  });
  const resolutionId = `res_${crypto.randomUUID()}`;
  const registrationHeaders = actorHeaders(input.access.actor, input.roomId);
  registrationHeaders.set("Content-Type", "application/json");
  registrationHeaders.set("X-UniJam-Resolution-Authority", "true");
  const registration = await roomStub(input.roomEnv, input.roomId).fetch(new Request("https://room.internal/internal/resolutions", {
    method: "POST",
    headers: registrationHeaders,
    body: JSON.stringify({
      resolutionId,
      recordingId: identity.recordingId,
      title: input.candidate.title,
      matchId: identity.matchId,
      provider: input.candidate.provider,
      providerRecordingId: input.candidate.providerRecordingId,
      method: input.method,
      explicit: input.candidate.explicit ?? null,
      evidence: input.evidence,
    }),
  }));
  if (!registration.ok) return apiError("RESOLUTION_AUTHORITY_FAILED", "The resolved recording could not be bound to this room", 503, true);
  return {
    resolutionId,
    recordingId: identity.recordingId,
    providerUrl: createProviderHandoffLinks(input.candidate.provider, input.candidate.providerRecordingId).universalUrl,
  };
}

export async function POST(request: Request, context: Context): Promise<Response> {
  if (!env.DB || !env.ROOM_OBJECTS || !env.CONNECTORS) return apiError("RESOLUTION_UNAVAILABLE", "Catalog resolution is unavailable", 503, true);
  const db = env.DB;
  const roomEnv = env as RoomAuthorityEnv;
  try {
    const roomId = normalizeV1RoomId((await context.params).roomId);
    const access = await authenticateRoomActor(roomEnv, request, roomId);
    if (!access) return apiError("UNAUTHENTICATED", "Join this room before resolving a contribution", 401);
    const body = await request.json() as { input?: unknown; provider?: unknown };
    if (typeof body.input !== "string") return apiError("INVALID_CATALOG_INPUT", "Enter a track link or search", 400);
    const intent = parseCatalogInput(body.input);
    if (intent.kind === "unsupported") {
      return apiError("UNSUPPORTED_SOURCE", "Use a Spotify link, Apple Music link, or plain track text", 422);
    }
    const requestedDestination = requestedProvider(body.provider);
    const provider = requestedDestination ?? (intent.kind === "provider_recording" ? intent.provider : null);
    if (!provider) return apiError("PROVIDER_REQUIRED", "Choose Spotify or Apple Music for this recording", 400);
    const publicProvider = provider === "apple_music" ? "apple-music" : provider;
    const catalogPrincipal = catalogPrincipalForRoom(access, provider);
    if (!catalogPrincipal) {
      return apiError(
        "LISTENER_CONNECTION_REQUIRED",
        "Create or sign in to your UniJam account, then connect Spotify to add Spotify tracks",
        409,
      );
    }
    const budgeted = await withCatalogResolutionBudget(db, {
      roomId,
      participantId: access.actor.participantId,
      sessionId: access.session.sessionId,
      now: Date.now(),
    }, async () => {
    const accountId = catalogPrincipal.kind === "account" ? catalogPrincipal.accountId : null;
    const catalogPath = catalogPrincipal.kind === "public" ? "/v1/catalog/public-query" : "/v1/catalog/query";
    const catalogIdentity = accountId === null ? {} : {
      accountId,
      connectionId: `${publicProvider}:${accountId}`,
    };
    const runtime = env as ConnectorProxyEnv;
    const crossProvider = intent.kind === "provider_recording" && intent.provider !== provider;
    let rawCandidateData: unknown;
    let resolutionRequest: ResolutionRequest;
    const method: "provider_id" | "metadata" = intent.kind === "provider_recording" && !crossProvider ? "provider_id" : "metadata";
    let mandatorySelection = false;
    let sourceAttribution: { provider: "spotify"; title: string; providerUrl: string } | undefined;
    let crossEvidence: string[] = [];

    if (crossProvider && intent.kind === "provider_recording") {
      const sourceData = await connectorData(runtime, "/v1/catalog/source", {
        provider: intent.provider,
        providerRecordingId: intent.providerRecordingId,
      });
      if (sourceData instanceof Response) return sourceData;
      if (intent.provider === "spotify") {
        const source = parseSpotifyOEmbedSource(sourceData, intent.providerRecordingId);
        if (!source || provider !== "apple_music") return apiError("PROVIDER_UNAVAILABLE", "Spotify returned invalid link metadata", 502, true);
        sourceAttribution = {
          provider: "spotify",
          title: source.title,
          providerUrl: createProviderHandoffLinks("spotify", source.providerRecordingId).universalUrl,
        };
        mandatorySelection = true;
        crossEvidence = ["spotify_oembed_title", "explicit_user_selection_required"];
        resolutionRequest = { provider, storefront: "US", title: source.title, artists: [] };
        rawCandidateData = await connectorData(runtime, catalogPath, {
          ...catalogIdentity,
          provider,
          mode: "search",
          query: { title: source.title, artists: [], limit: 10 },
        });
      } else {
        const source = parseConnectorCandidate(sourceData, "apple_music");
        if (!source || provider !== "spotify") return apiError("PROVIDER_UNAVAILABLE", "Apple Music returned invalid catalog metadata", 502, true);
        crossEvidence = ["apple_music_source_metadata"];
        resolutionRequest = {
          provider,
          storefront: "US",
          title: source.title,
          artists: source.artists,
          ...(source.album ? { album: source.album } : {}),
          ...(source.durationMs === undefined ? {} : { durationMs: source.durationMs }),
          ...(source.isrc ? { isrc: source.isrc } : {}),
          ...(source.explicit === undefined ? {} : { explicit: source.explicit }),
          ...(source.version ? { version: source.version } : {}),
          ...(source.edition ? { edition: source.edition } : {}),
        };
        rawCandidateData = source.isrc
          ? await connectorData(runtime, catalogPath, {
              ...catalogIdentity,
              provider,
              mode: "isrc",
              isrc: source.isrc,
            })
          : [];
        if (!(rawCandidateData instanceof Response) && (!Array.isArray(rawCandidateData) || rawCandidateData.length === 0)) {
          rawCandidateData = await connectorData(runtime, catalogPath, {
            ...catalogIdentity,
            provider,
            mode: "search",
            query: { title: source.title, artists: source.artists, album: source.album, limit: 10 },
          });
        }
      }
    } else {
      rawCandidateData = await connectorData(runtime, catalogPath, {
        ...catalogIdentity,
        provider,
        ...(intent.kind === "provider_recording"
          ? { mode: "recording_id", providerRecordingId: intent.providerRecordingId }
          : { mode: "search", query: { title: intent.title ?? intent.query, artists: intent.artists, limit: 10 } }),
      });
      resolutionRequest = intent.kind === "provider_recording"
        ? { provider, providerRecordingId: intent.providerRecordingId, storefront: "US", title: "", artists: [] }
        : { provider, storefront: "US", title: intent.title ?? intent.query, artists: intent.artists };
    }

    if (rawCandidateData instanceof Response) return rawCandidateData;
    const rawCandidates = intent.kind === "provider_recording" && !crossProvider
      ? [rawCandidateData]
      : Array.isArray(rawCandidateData) ? rawCandidateData : [];
    const candidates = rawCandidates.flatMap((value) => {
      const parsed = parseConnectorCandidate(value, provider);
      return parsed ? [parsed] : [];
    });
    if (intent.kind === "provider_recording" && !crossProvider && candidates[0]) {
      resolutionRequest = resolutionRequestForCandidate(candidates[0]);
    }
    if (mandatorySelection) {
      const ranked = titleOnlyReviewCandidates(sourceAttribution?.title ?? "", provider, candidates);
      if (ranked.length === 0) return apiResponse({ status: "no_match", storefront: "US", sourceAttribution });
      const selections = [];
      for (const entry of ranked) {
        const evidence = [...new Set([...entry.evidence, ...crossEvidence])];
        const grant = await registerCandidateGrant({
          db,
          roomEnv,
          roomId,
          access,
          candidate: entry.candidate,
          method: "metadata",
          evidence,
          identityBasis: "provider",
          deterministic: false,
        });
        if (grant instanceof Response) return grant;
        selections.push({
          ...entry,
          resolutionId: grant.resolutionId,
          candidate: { ...entry.candidate, providerUrl: grant.providerUrl },
        });
      }
      return apiResponse({
        status: "hold",
        storefront: "US",
        reasons: ["source_metadata_incomplete"],
        candidates: selections,
        sourceAttribution,
      });
    }
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
    const evidence = [...new Set([...resolution.match.evidence, ...crossEvidence])];
    const grant = await registerCandidateGrant({ db, roomEnv, roomId, access, candidate, method, evidence });
    if (grant instanceof Response) return grant;
    return apiResponse({
      status: "matched",
      storefront: "US",
      resolutionId: grant.resolutionId,
      recordingId: grant.recordingId,
      title: candidate.title,
      artists: candidate.artists,
      album: candidate.album ?? null,
      explicit: candidate.explicit ?? null,
      version: candidate.version ?? "unknown",
      provider: candidate.provider === "apple_music" ? "apple-music" : candidate.provider,
      providerRecordingId: candidate.providerRecordingId,
      providerUrl: grant.providerUrl,
      evidence,
    });
    });
    return budgeted.allowed ? budgeted.value : catalogResolutionRateLimitResponse(budgeted);
  } catch {
    return apiError("RESOLUTION_FAILED", "The contribution could not be resolved", 400);
  }
}
