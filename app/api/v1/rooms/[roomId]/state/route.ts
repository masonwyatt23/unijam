import { env } from "cloudflare:workers";

import { apiError, apiResponse } from "@/lib/server/api-response";
import { authenticateRoomActor, normalizeV1RoomId, roomStub, type RoomAuthorityEnv } from "@/lib/server/room-authority";

type RouteContext = { params: Promise<{ roomId: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  if (!env.DB || !env.ROOM_OBJECTS) return apiError("PLATFORM_UNAVAILABLE", "Room authority is unavailable", 503, true);
  try {
    const roomId = normalizeV1RoomId((await context.params).roomId);
    const runtime = env as RoomAuthorityEnv;
    // Ended rooms remain readable only to their owning host for recap and
    // publishing. Live commands, catalog resolution, handoff, and WebSockets
    // continue to use the active-room-only authorization default.
    const authorization = await authenticateRoomActor(runtime, request, roomId, { allowEndedOwner: true });
    if (!authorization) return apiError("UNAUTHENTICATED", "Room session is missing or expired", 401);
    const response = await roomStub(runtime, roomId).fetch(new Request("https://room.internal/state"));
    const body = await response.json();
    if (!response.ok) return apiError("ROOM_STATE_FAILED", "Unable to read canonical room state", response.status, response.status >= 500);
    return apiResponse({ ...body as object, actor: authorization.actor });
  } catch {
    return apiError("INVALID_ROOM", "Room is invalid", 400);
  }
}
