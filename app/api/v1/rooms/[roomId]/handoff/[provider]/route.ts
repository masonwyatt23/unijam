import { env } from "cloudflare:workers";

import { createProviderHandoffLinks } from "@/lib/providers/handoff";
import { apiError, apiResponse } from "@/lib/server/api-response";
import { catalogPrincipalForRoom } from "@/lib/server/catalog-principal";
import type { ConnectorProxyEnv } from "@/lib/server/connector-proxy";
import { backfillProviderMatch } from "@/lib/server/provider-match";
import { canonicalRoomSnapshot } from "@/lib/server/room-control-auth";
import { authenticateRoomActor, normalizeV1RoomId, type RoomAuthorityEnv } from "@/lib/server/room-authority";
import type { MusicProvider } from "@/lib/provider-state-engine";

type Context = { params: Promise<{ roomId: string; provider: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  if (!env.DB || !env.ROOM_OBJECTS) return apiError("PLATFORM_UNAVAILABLE", "Handoff is unavailable", 503, true);
  const { roomId: rawRoomId, provider: rawProvider } = await context.params;
  const roomId = normalizeV1RoomId(rawRoomId);
  const provider: MusicProvider | null = rawProvider === "spotify" ? "spotify" : rawProvider === "apple-music" ? "apple_music" : null;
  if (!provider) return apiError("UNSUPPORTED_PROVIDER", "Provider is unsupported", 404);
  const access = await authenticateRoomActor(env as RoomAuthorityEnv, request, roomId);
  if (!access) return apiError("UNAUTHENTICATED", "Join this room before opening a handoff", 401);
  const snapshot = await canonicalRoomSnapshot(env as RoomAuthorityEnv, roomId) as {
    occurrences?: Array<{ occurrenceId: string; recordingId: string; title: string; status: string; display?: { artists: string[]; album?: string; durationMs?: number; explicit?: boolean; provider: MusicProvider; providerUrl: string; artwork?: { url: string; width: number; height: number } } }>;
  };
  const occurrence = snapshot.occurrences?.find((item) => item.status === "now");
  if (!occurrence) return apiError("NOTHING_PLAYING", "There is no Now occurrence to hand off", 409);
  let match = await env.DB.prepare(
    `SELECT provider_recording_id FROM provider_matches
     WHERE recording_id = ? AND provider = ? AND storefront = 'us' AND status IN ('confirmed','matched') LIMIT 1`,
  ).bind(occurrence.recordingId, provider).first<{ provider_recording_id: string }>();
  if (!match) {
    const principal = catalogPrincipalForRoom(access, provider);
    if (!principal) {
      return apiError("LISTENER_CONNECTION_REQUIRED", "Connect your own Spotify account before resolving this handoff", 409);
    }
    const backfill = await backfillProviderMatch({
      db: env.DB,
      runtime: env as ConnectorProxyEnv,
      recordingId: occurrence.recordingId,
      provider,
      principal,
    });
    if (backfill.status === "provider_error") return backfill.response;
    if (backfill.status === "review") {
      return apiError("MATCH_REVIEW_REQUIRED", `This recording needs a reviewed ${provider === "spotify" ? "Spotify" : "Apple Music"} match`, 409);
    }
    match = { provider_recording_id: backfill.providerRecordingId };
  }
  try {
    return apiResponse({
      occurrenceId: occurrence.occurrenceId,
      recordingId: occurrence.recordingId,
      title: occurrence.title,
      provider,
      ...(occurrence.display?.provider === provider ? { display: occurrence.display } : {}),
      links: createProviderHandoffLinks(provider, match.provider_recording_id),
    });
  } catch {
    return apiError("INVALID_PROVIDER_MATCH", "The provider match cannot produce a safe handoff", 409);
  }
}
