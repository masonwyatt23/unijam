import { env } from "cloudflare:workers";
import { apiError, apiResponse } from "@/lib/server/api-response";
import { hashOpaqueToken, timingSafeEqual } from "@/lib/server/secure-token";

type Context = { params: Promise<{ legacyRoomId: string }> };
export async function GET(request: Request, context: Context): Promise<Response> {
  if (!env.DB) return apiError("MIGRATION_NOT_FOUND", "Legacy export is unavailable", 404);
  const legacyRoomId = (await context.params).legacyRoomId.trim().toUpperCase();
  const token = request.headers.get("Authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return apiError("MIGRATION_NOT_FOUND", "Legacy export is unavailable", 404);
  const row = await env.DB.prepare("SELECT export_hash, export_json, legacy_host_capability_hash, status FROM legacy_room_imports WHERE legacy_room_id = ? AND deleted_at_ms IS NULL LIMIT 1")
    .bind(legacyRoomId).first<{ export_hash: string; export_json: string; legacy_host_capability_hash: string; status: string }>();
  if (!row || !timingSafeEqual(await hashOpaqueToken(token), row.legacy_host_capability_hash)) return apiError("MIGRATION_NOT_FOUND", "Legacy export is unavailable", 404);
  return apiResponse({ legacyRoomId, exportHash: row.export_hash, state: row.status === "claimed" ? "claimed" : "read-only", export: JSON.parse(row.export_json) });
}
