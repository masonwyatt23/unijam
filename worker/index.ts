/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { forwardRoomAuthority, normalizeV1RoomId, type RoomAuthorityEnv } from "../lib/server/room-authority.ts";
import { RoomDurableObject } from "./room-durable-object.ts";
import { isExactSameOriginRequest, isExactSameOriginWebSocket, withSecurityHeaders, type SecurityEnvironment } from "../lib/server/security-headers.ts";
import { apiError } from "../lib/server/api-response.ts";
import { expiredRoomProjectionDeletion, ROOM_DETAIL_RETENTION_MS } from "../lib/platform/retention.ts";

interface Env extends Cloudflare.Env {
  DB: D1Database;
  ROOM_OBJECTS: DurableObjectNamespace;
  ROOM_PROJECTION_QUEUE?: Queue;
  APP_ORIGIN: string;
  ASSETS: Fetcher;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const environment = (env.APP_ENV ?? "development") as SecurityEnvironment;
    const expectedOrigin = environment === "development" ? url.origin : env.APP_ORIGIN;

    const websocketMatch = url.pathname.match(/^\/api\/v1\/rooms\/([^/]+)\/websocket$/);
    if (websocketMatch && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      if (!isExactSameOriginWebSocket(request, expectedOrigin)) {
        return withSecurityHeaders(apiError("ORIGIN_FORBIDDEN", "WebSocket origin is not allowed", 403), environment);
      }
      try {
        return forwardRoomAuthority(env as RoomAuthorityEnv, request, normalizeV1RoomId(websocketMatch[1]), "/websocket");
      } catch {
        return new Response("Invalid room", { status: 400 });
      }
    }

    if (!isExactSameOriginRequest(request, expectedOrigin)) {
      return withSecurityHeaders(apiError("ORIGIN_FORBIDDEN", "Request origin is not allowed", 403), environment);
    }
    if (url.pathname.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) {
      const declaredLength = Number(request.headers.get("Content-Length") ?? 0);
      const maximum = url.pathname === "/api/v1/migration/import" ? 5_250_000
        : url.pathname.endsWith("/commands") ? 65_536
          : 262_144;
      if (Number.isFinite(declaredLength) && declaredLength > maximum) {
        return withSecurityHeaders(apiError("PAYLOAD_TOO_LARGE", "Request payload exceeds the allowed size", 413), environment);
      }
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      const response = await handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
      return withSecurityHeaders(response, environment);
    }

    try {
      return withSecurityHeaders(await handler.fetch(request, env, ctx), environment);
    } catch {
      return withSecurityHeaders(apiError("INTERNAL_ERROR", "The request could not be completed", 500, true), environment);
    }
  },

  async queue(batch: MessageBatch, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        const body = message.body as {
          event?: { eventId?: string };
          snapshot?: { roomId?: string; seq?: number };
        };
        const eventId = body.event?.eventId;
        const roomId = body.snapshot?.roomId;
        const sequence = body.snapshot?.seq;
        if (!eventId || !roomId || !Number.isSafeInteger(sequence)) throw new Error("Projection message is malformed");
        const now = Date.now();
        const statements = [
          env.DB.prepare("INSERT OR IGNORE INTO room_projection_receipts (event_id, room_id, received_at_ms) VALUES (?, ?, ?)")
            .bind(eventId, roomId, now),
          env.DB.prepare(
            `INSERT INTO room_projections (room_id, sequence, snapshot_json, projected_at_ms, source_event_id)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(room_id) DO UPDATE SET
               sequence = excluded.sequence, snapshot_json = excluded.snapshot_json,
               projected_at_ms = excluded.projected_at_ms, source_event_id = excluded.source_event_id
             WHERE excluded.sequence > room_projections.sequence`,
          ).bind(roomId, sequence, JSON.stringify(body.snapshot), now, eventId),
        ];
        const event = body.event as { type?: string; payload?: { participantId?: string; role?: string } };
        if (event.type === "participant.moderated" && event.payload?.participantId && ["cohost", "guest", "viewer"].includes(event.payload.role ?? "")) {
          statements.push(env.DB.prepare("UPDATE guest_sessions SET role = ?, last_seen_at_ms = ? WHERE room_id = ? AND participant_id = ? AND revoked_at_ms IS NULL")
            .bind(event.payload.role, now, roomId, event.payload.participantId));
        }
        await env.DB.batch(statements);
        message.ack();
      } catch {
        message.retry({ delaySeconds: 30 });
      }
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const now = Date.now();
    const retentionCutoff = now - ROOM_DETAIL_RETENTION_MS;
    ctx.waitUntil(env.DB.batch([
      env.DB.prepare("DELETE FROM passkey_challenges WHERE expires_at_ms <= ?").bind(now),
      env.DB.prepare("DELETE FROM auth_rate_buckets WHERE expires_at_ms <= ?").bind(now),
      env.DB.prepare("DELETE FROM host_sessions WHERE expires_at_ms <= ? OR revoked_at_ms IS NOT NULL").bind(now),
      env.DB.prepare("DELETE FROM guest_sessions WHERE expires_at_ms <= ? OR revoked_at_ms IS NOT NULL").bind(now),
      env.DB.prepare("DELETE FROM room_projection_receipts WHERE received_at_ms < ?").bind(retentionCutoff),
      expiredRoomProjectionDeletion(env.DB, retentionCutoff),
      env.DB.prepare("UPDATE legacy_room_imports SET status = 'read_only', read_only_at_ms = ? WHERE status = 'imported' AND claim_deadline_ms < ?").bind(now, now),
    ]).then(() => undefined));
  },
};

export default worker;
export { RoomDurableObject };
