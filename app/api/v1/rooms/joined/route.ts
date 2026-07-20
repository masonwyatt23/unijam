import { env } from "cloudflare:workers";

import { apiError, apiResponse, redactedInternalError } from "@/lib/server/api-response";
import { authenticateHost } from "@/lib/server/host-session";
import { listJoinedRooms } from "@/lib/server/room-membership";

export async function GET(request: Request): Promise<Response> {
  if (!env.DB) return apiError("PLATFORM_UNAVAILABLE", "Room history is unavailable", 503, true);
  const account = await authenticateHost(env.DB, request);
  if (!account) return apiError("UNAUTHENTICATED", "Sign in with a passkey to view joined rooms", 401);
  try {
    return apiResponse({ rooms: await listJoinedRooms(env.DB, account.account_id) });
  } catch (error) {
    return redactedInternalError(error, "ROOM_HISTORY_UNAVAILABLE", "Joined rooms could not be loaded", 503, true);
  }
}
