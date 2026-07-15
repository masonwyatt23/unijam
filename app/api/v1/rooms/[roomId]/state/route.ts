import { env } from "cloudflare:workers";

import { apiError, apiResponse } from "@/lib/server/api-response";
import { authenticateRoomActor, forwardRoomAuthority, normalizeV1RoomId, type RoomAuthorityEnv } from "@/lib/server/room-authority";

type RouteContext = { params: Promise<{ roomId: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  if (!env.DB || !env.ROOM_OBJECTS) return apiError("PLATFORM_UNAVAILABLE", "Room authority is unavailable", 503, true);
  try {
    const roomId = normalizeV1RoomId((await context.params).roomId);
    const runtime = env as RoomAuthorityEnv;
    const authorization = await authenticateRoomActor(runtime, request, roomId);
    if (!authorization) return apiError("UNAUTHENTICATED", "Room session is missing or expired", 401);
    const response = await forwardRoomAuthority(runtime, request, roomId, "/state");
    if (response.status === 401) return apiError("UNAUTHENTICATED", "Room session is missing or expired", 401);
    const body = await response.json();
    if (!response.ok) return apiError("ROOM_STATE_FAILED", "Unable to read canonical room state", response.status, response.status >= 500);
    return apiResponse({ ...body as object, actor: authorization.actor });
  } catch {
    return apiError("INVALID_ROOM", "Room is invalid", 400);
  }
}
