import { env } from "cloudflare:workers";

import { apiError, apiResponse } from "@/lib/server/api-response";
import { forwardRoomAuthority, normalizeV1RoomId, type RoomAuthorityEnv } from "@/lib/server/room-authority";

type RouteContext = { params: Promise<{ roomId: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  if (!env.DB || !env.ROOM_OBJECTS) return apiError("PLATFORM_UNAVAILABLE", "Room authority is unavailable", 503, true);
  try {
    const roomId = normalizeV1RoomId((await context.params).roomId);
    const response = await forwardRoomAuthority(env as RoomAuthorityEnv, request, roomId, "/commands");
    const body = await response.json() as { type?: string; code?: string; message?: string; retryable?: boolean };
    if (response.status === 401) return apiError("UNAUTHENTICATED", "Room session is missing or expired", 401);
    if (!response.ok || body.type === "error") {
      return apiError(body.code ?? "COMMAND_REJECTED", body.message ?? "Room command was rejected", response.status, body.retryable);
    }
    return apiResponse(body);
  } catch {
    return apiError("INVALID_COMMAND", "Command is invalid", 400);
  }
}
