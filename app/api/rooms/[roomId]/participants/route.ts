import {
  createOrResumeParticipantSession,
  ParticipantSessionError,
  readBearerToken,
} from "@/lib/server/participant-session";
import {
  authorizeLegacyRoomApi,
  authorizeRoomRequest,
  ensureRoomSchema,
  roomDatabase,
} from "@/lib/server/room-store";

type RouteContext = { params: Promise<{ roomId: string }> };

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    if (!authorizeLegacyRoomApi(request)) return json({ error: "Legacy room API is disabled" }, 404);
    const db = roomDatabase();
    if (!db) return json({ error: "Room persistence is not configured", mode: "local" }, 503);
    const roomId = (await context.params).roomId;
    const capabilityToken = readBearerToken(request);
    if (!capabilityToken) return json({ error: "Room capability is missing or invalid" }, 401);
    await ensureRoomSchema(db);
    const authorization = await authorizeRoomRequest(db, request, roomId);
    if (!authorization) return json({ error: "Room capability is missing or invalid" }, 401);
    const body = await request.json();
    const result = await createOrResumeParticipantSession(
      db,
      authorization,
      capabilityToken,
      body,
    );
    return json(result, result.created ? 201 : 200);
  } catch (error) {
    if (error instanceof ParticipantSessionError) {
      return json(
        { error: error.message, retryAfterSeconds: error.retryAfterSeconds },
        error.status,
        error.retryAfterSeconds ? { "Retry-After": String(error.retryAfterSeconds) } : undefined,
      );
    }
    if (error instanceof SyntaxError) return json({ error: "participant body must be valid JSON" }, 400);
    return json({ error: error instanceof Error ? error.message : "Unable to join room" }, 400);
  }
}
