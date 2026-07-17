import { env } from "cloudflare:workers";

import { parseCatalogInput } from "@/lib/catalog/input";
import { resolveUsCatalogRecording, type CatalogCandidate, type ResolutionRequest } from "@/lib/catalog/resolver";
import { apiError, apiResponse } from "@/lib/server/api-response";
import {
  parseConnectorCandidate,
  parseConnectorEnvelope,
  parseSpotifyOEmbedSource,
  resolutionRequestForCandidate,
  stableRecordingIdentity,
  titleOnlyReviewCandidates,
} from "@/lib/server/catalog-resolution";
import { catalogPrincipalForRoom } from "@/lib/server/catalog-principal";
import {
  persistCanonicalRecordingMatches,
  providerCorrectionAuthority,
  ProviderMatchConflictError,
  type ProviderMatchEdge,
  type ProviderMatchMethod,
} from "@/lib/server/provider-match";
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
  method: ProviderMatchMethod,
  evidence: readonly string[],
  options: {
    identityBasis?: "canonical" | "provider";
    deterministic?: boolean;
    related?: readonly ProviderMatchEdge[];
    review?: { accountId: string; roomId: string; participantId: string };
  } = {},
) {
  return persistCanonicalRecordingMatches({
    db,
    candidate,
    identityBasis: options.identityBasis,
    primary: { method, evidence, deterministic: options.deterministic ?? true },
    related: options.related,
    review: options.review,
  });
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
  readonly method: ProviderMatchMethod;
  readonly evidence: readonly string[];
  readonly identityBasis?: "canonical" | "provider";
  readonly deterministic?: boolean;
  readonly related?: readonly ProviderMatchEdge[];
}): Promise<Response | {
  readonly resolutionId: string;
  readonly recordingId: string;
  readonly providerUrl: string;
}> {
  let identity: Awaited<ReturnType<typeof persistMatch>>;
  const correctionAuthority = input.method === "user_correction"
    ? providerCorrectionAuthority({
        accountId: input.access.session.accountId,
        roomId: input.roomId,
        participantId: input.access.actor.participantId,
      })
    : null;
  const roomLocalCorrection = correctionAuthority?.kind === "room_local";
  const evidence = roomLocalCorrection
    ? [...new Set([...input.evidence, "room_local_guest_selection"])]
    : input.evidence;
  try {
    identity = roomLocalCorrection
      ? await stableRecordingIdentity(input.candidate, input.identityBasis ?? "provider")
      : await persistMatch(input.db, input.candidate, input.method, evidence, {
          identityBasis: input.identityBasis,
          deterministic: input.deterministic,
          related: input.related,
          ...(correctionAuthority?.kind === "reviewed"
            ? { review: correctionAuthority.review }
            : {}),
        });
  } catch (error) {
    if (error instanceof ProviderMatchConflictError) {
      return apiError("PROVIDER_MATCH_CONFLICT", "This provider recording is already bound to a different reviewed match", 409);
    }
    throw error;
  }
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
      artists: input.candidate.artists,
      album: input.candidate.album ?? null,
      durationMs: input.candidate.durationMs ?? null,
      artwork: input.candidate.artwork ?? null,
      matchId: identity.matchId,
      provider: input.candidate.provider,
      providerRecordingId: input.candidate.providerRecordingId,
      method: input.method,
      explicit: input.candidate.explicit ?? null,
      evidence,
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
    const body = await request.json() as { input?: unknown; provider?: unknown; selection?: unknown };
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
    const selectedProviderRecordingId = typeof body.selection === "string" ? body.selection.trim() : null;
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
    let sourceAttribution: { provider: "spotify"; providerRecordingId: string; title: string; providerUrl: string } | undefined;
    let completeSourceCandidate: CatalogCandidate | undefined;
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
          providerRecordingId: source.providerRecordingId,
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
        completeSourceCandidate = source;
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
      if (selectedProviderRecordingId) {
        const selected = ranked.find(({ candidate }) => candidate.providerRecordingId === selectedProviderRecordingId);
        if (!selected) return apiError("INVALID_MATCH_SELECTION", "Choose one of the current reviewed recordings", 409);
        const evidence = [...new Set([...selected.evidence, ...crossEvidence, "participant_selected"] )];
        const related: ProviderMatchEdge[] = sourceAttribution ? [{
          candidate: { provider: "spotify", providerRecordingId: sourceAttribution.providerRecordingId },
          method: "user_correction",
          evidence: ["spotify_oembed_title", "participant_selected_cross_provider_match"],
          deterministic: false,
        }] : [];
        const grant = await registerCandidateGrant({
          db, roomEnv, roomId, access, candidate: selected.candidate,
          method: "user_correction", evidence, identityBasis: "provider", deterministic: false, related,
        });
        if (grant instanceof Response) return grant;
        return apiResponse({
          status: "matched", storefront: "US", resolutionId: grant.resolutionId, recordingId: grant.recordingId,
          title: selected.candidate.title, artists: selected.candidate.artists, album: selected.candidate.album ?? null,
          explicit: selected.candidate.explicit ?? null, version: selected.candidate.version ?? "unknown",
          provider: "apple-music", providerRecordingId: selected.candidate.providerRecordingId,
          providerUrl: grant.providerUrl, evidence,
        });
      }
      return apiResponse({
        status: "hold",
        storefront: "US",
        reasons: ["source_metadata_incomplete"],
        candidates: ranked.map((entry) => ({
          ...entry,
          candidate: {
            ...entry.candidate,
            providerUrl: createProviderHandoffLinks(entry.candidate.provider, entry.candidate.providerRecordingId).universalUrl,
          },
        })),
        sourceAttribution,
      });
    }
    const resolution = resolveUsCatalogRecording(resolutionRequest, candidates);
    if (resolution.status === "hold") {
      const actionable = resolution.candidates.filter(({ candidate }) =>
        candidate.storefronts?.some((storefront) => storefront.toUpperCase() === "US"),
      );
      if (selectedProviderRecordingId) {
        const selected = actionable.find(({ candidate }) => candidate.providerRecordingId === selectedProviderRecordingId);
        if (!selected) return apiError("INVALID_MATCH_SELECTION", "Choose one of the current US recordings", 409);
        const evidence = [...new Set([...selected.evidence, ...crossEvidence, "participant_selected"] )];
        const related: ProviderMatchEdge[] = completeSourceCandidate ? [{
          candidate: completeSourceCandidate,
          method: "user_correction",
          evidence: ["cross_provider_source", "participant_selected"],
          deterministic: false,
        }] : [];
        const grant = await registerCandidateGrant({
          db, roomEnv, roomId, access, candidate: selected.candidate,
          method: "user_correction", evidence, deterministic: false, related,
        });
        if (grant instanceof Response) return grant;
        return apiResponse({
          status: "matched", storefront: "US", resolutionId: grant.resolutionId, recordingId: grant.recordingId,
          title: selected.candidate.title, artists: selected.candidate.artists, album: selected.candidate.album ?? null,
          explicit: selected.candidate.explicit ?? null, version: selected.candidate.version ?? "unknown",
          provider: selected.candidate.provider === "apple_music" ? "apple-music" : "spotify",
          providerRecordingId: selected.candidate.providerRecordingId, providerUrl: grant.providerUrl, evidence,
        });
      }
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
    const related: ProviderMatchEdge[] = completeSourceCandidate ? [{
      candidate: completeSourceCandidate,
      method: "metadata",
      evidence: ["cross_provider_source", ...crossEvidence],
      deterministic: true,
    }] : [];
    const grant = await registerCandidateGrant({ db, roomEnv, roomId, access, candidate, method, evidence, related });
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
