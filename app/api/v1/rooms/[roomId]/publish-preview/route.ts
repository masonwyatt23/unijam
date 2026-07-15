import { env } from "cloudflare:workers";
import { apiError } from "@/lib/server/api-response";
import { connectorJsonRequest, normalizeProvider, type ConnectorProxyEnv } from "@/lib/server/connector-proxy";
import { authorizeRoomOwner, canonicalRoomSnapshot } from "@/lib/server/room-control-auth";
import { normalizeV1RoomId, type RoomAuthorityEnv } from "@/lib/server/room-authority";

type Context = { params: Promise<{ roomId: string }> };
export async function POST(request: Request, context: Context): Promise<Response> {
  if (!env.DB || !env.ROOM_OBJECTS || !env.CONNECTORS) return apiError("CONNECTOR_UNAVAILABLE", "Publishing service is unavailable", 503, true);
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
  const providerValue = provider === "apple-music" ? "apple_music" : provider;
  const items = await Promise.all(occurrences.map(async (item) => {
    const match = await env.DB!.prepare(
      "SELECT provider_recording_id FROM provider_matches WHERE recording_id = ? AND provider = ? AND storefront = 'us' AND status IN ('confirmed','matched') LIMIT 1",
    ).bind(item.recordingId, providerValue).first<{ provider_recording_id: string }>();
    return match ? { canonicalRecordingId: item.recordingId, providerRecordingId: match.provider_recording_id } : null;
  }));
  if (items.some((item) => item === null) || items.length === 0) return apiError("MATCH_REVIEW_REQUIRED", "Resolve every setlist recording before publishing", 409);
  return connectorJsonRequest(env as ConnectorProxyEnv, "/v1/publish/preview", {
    accountId: host.account_id, connectionId: `${provider}:${host.account_id}`, roomId, roomRevision: snapshot.seq ?? 0,
    provider: providerValue, playlistName, ...(typeof body.playlistDescription === "string" ? { playlistDescription: body.playlistDescription.slice(0, 300) } : {}), items,
  });
}
