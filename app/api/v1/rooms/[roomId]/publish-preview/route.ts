import { env } from "cloudflare:workers";
import { apiError } from "@/lib/server/api-response";
import { connectorJsonRequest, normalizeProvider, type ConnectorProxyEnv } from "@/lib/server/connector-proxy";
import { publishPreviewLimitMessage } from "@/lib/publishing/limits";
import {
  backfillPreviewProviderMatches,
  backfillProviderMatch,
  loadProviderMatches,
} from "@/lib/server/provider-match";
import { authorizeRoomOwner, canonicalRoomSnapshot } from "@/lib/server/room-control-auth";
import { normalizeV1RoomId, type RoomAuthorityEnv } from "@/lib/server/room-authority";

type Context = { params: Promise<{ roomId: string }> };
export async function POST(request: Request, context: Context): Promise<Response> {
  if (!env.DB || !env.ROOM_OBJECTS || !env.CONNECTORS) return apiError("CONNECTOR_UNAVAILABLE", "Publishing service is unavailable", 503, true);
  const db = env.DB;
  const roomId = normalizeV1RoomId((await context.params).roomId);
  const host = await authorizeRoomOwner(env as RoomAuthorityEnv, request, roomId);
  if (!host) return apiError("UNAUTHORIZED_ROOM", "Room owner session is required", 403);
  const body = await request.json() as { provider?: unknown; playlistName?: unknown; playlistDescription?: unknown };
  let provider;
  try { provider = normalizeProvider(String(body.provider ?? "")); }
  catch { return apiError("UNSUPPORTED_PROVIDER", "Provider is unsupported", 400); }
  const playlistName = typeof body.playlistName === "string" ? body.playlistName.trim() : "";
  if (!playlistName || playlistName.length > 100) return apiError("INVALID_DESTINATION", "Playlist name is required", 400);
  const runtime = env as RoomAuthorityEnv;
  const snapshot = await canonicalRoomSnapshot(runtime, roomId) as { seq?: number; occurrences?: Array<{ occurrenceId: string; recordingId: string; status: string }> };
  const occurrences = (snapshot.occurrences ?? []).filter((item) => !["held", "skipped"].includes(item.status));
  if (occurrences.length === 0) return apiError("MATCH_REVIEW_REQUIRED", "Resolve every setlist recording before publishing", 409);
  const limitMessage = publishPreviewLimitMessage(occurrences.length);
  if (limitMessage) return apiError("PUBLISH_ITEM_LIMIT_EXCEEDED", limitMessage, 422);
  const providerValue = provider === "apple-music" ? "apple_music" : provider;
  const recordingIds = occurrences.map(({ recordingId }) => recordingId);
  const existing = await loadProviderMatches(db, recordingIds, providerValue);
  const backfilled = await backfillPreviewProviderMatches({
    recordingIds,
    existing,
    backfill: (recordingId) => backfillProviderMatch({
        db,
        runtime: env as ConnectorProxyEnv,
        recordingId,
        provider: providerValue,
        principal: providerValue === "apple_music" ? { kind: "public" } : { kind: "account", accountId: host.account_id },
      }),
  });
  if (backfilled.status === "provider_error") return backfilled.response;
  if (backfilled.status === "review") {
    return apiError("MATCH_REVIEW_REQUIRED", "Review every destination recording before publishing", 409);
  }
  if (backfilled.status === "partial") {
    return apiError(
      "MATCH_BACKFILL_IN_PROGRESS",
      "Destination matching made bounded progress; retry the preview to continue",
      409,
      true,
    );
  }
  const items = occurrences.map((item) => ({
    canonicalRecordingId: item.recordingId,
    providerRecordingId: backfilled.matches.get(item.recordingId)!,
  }));
  return connectorJsonRequest(env as ConnectorProxyEnv, "/v1/publish/preview", {
    accountId: host.account_id, connectionId: `${provider}:${host.account_id}`, roomId, roomRevision: snapshot.seq ?? 0,
    provider: providerValue, playlistName, ...(typeof body.playlistDescription === "string" ? { playlistDescription: body.playlistDescription.slice(0, 300) } : {}), items,
  });
}
