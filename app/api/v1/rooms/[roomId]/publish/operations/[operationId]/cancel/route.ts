import { env } from "cloudflare:workers";
import { apiError } from "@/lib/server/api-response";
import { connectorJsonRequest, type ConnectorProxyEnv } from "@/lib/server/connector-proxy";
import { authorizeRoomOwner } from "@/lib/server/room-control-auth";
import { normalizeV1RoomId, type RoomAuthorityEnv } from "@/lib/server/room-authority";

type Context = { params: Promise<{ roomId: string; operationId: string }> };
export async function POST(request: Request, context: Context): Promise<Response> {
  if (!env.DB || !env.ROOM_OBJECTS || !env.CONNECTORS) return apiError("CONNECTOR_UNAVAILABLE", "Publishing service is unavailable", 503, true);
  const { roomId: rawRoomId, operationId } = await context.params;
  const roomId = normalizeV1RoomId(rawRoomId);
  if (!/^[a-zA-Z0-9._:-]{8,191}$/.test(operationId)) return apiError("INVALID_OPERATION", "Operation is invalid", 400);
  const host = await authorizeRoomOwner(env as RoomAuthorityEnv, request, roomId, true);
  if (!host) return apiError("RECENT_PASSKEY_REQUIRED", "Confirm a passkey before cancelling publishing", 403);
  return connectorJsonRequest(env as ConnectorProxyEnv, "/v1/publish/cancel", { accountId: host.account_id, operationId });
}
