import { env } from "cloudflare:workers";
import { apiError } from "@/lib/server/api-response";
import { connectorJsonRequest, type ConnectorProxyEnv } from "@/lib/server/connector-proxy";
import { authorizeRoomOwner } from "@/lib/server/room-control-auth";
import { normalizeV1RoomId, type RoomAuthorityEnv } from "@/lib/server/room-authority";

type Context = { params: Promise<{ roomId: string }> };
export async function POST(request: Request, context: Context): Promise<Response> {
  if (!env.DB || !env.ROOM_OBJECTS || !env.CONNECTORS) return apiError("CONNECTOR_UNAVAILABLE", "Publishing service is unavailable", 503, true);
  const roomId = normalizeV1RoomId((await context.params).roomId);
  const host = await authorizeRoomOwner(env as RoomAuthorityEnv, request, roomId, true);
  if (!host) return apiError("RECENT_PASSKEY_REQUIRED", "Confirm a passkey before publishing", 403);
  const body = await request.json() as { previewId?: unknown; payloadFingerprint?: unknown };
  if (typeof body.previewId !== "string" || typeof body.payloadFingerprint !== "string") return apiError("INVALID_CONFIRMATION", "Immutable publish preview is required", 400);
  return connectorJsonRequest(env as ConnectorProxyEnv, "/v1/publish/confirm", {
    accountId: host.account_id, previewId: body.previewId, payloadFingerprint: body.payloadFingerprint, confirmedAtMs: Date.now(),
  });
}
