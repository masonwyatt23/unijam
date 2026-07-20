import { env } from "cloudflare:workers";

import { apiError, apiResponse } from "@/lib/server/api-response";
import { LEGACY_BEARER_WINDOW_MS, LEGACY_CLAIM_WINDOW_MS, legacyExportHash, legacyImportWriteResult, validateLegacyExport } from "@/lib/server/legacy-migration";
import { authorizeLegacyRoomApi } from "@/lib/server/room-store";
import { hashOpaqueToken } from "@/lib/server/secure-token";

export async function POST(request: Request): Promise<Response> {
  if (!env.DB || !authorizeLegacyRoomApi(request)) return apiError("MIGRATION_NOT_FOUND", "Migration endpoint is unavailable", 404);
  try {
    const body = await request.json() as { export?: unknown; hostCapability?: unknown; guestCapability?: unknown };
    const parsed = validateLegacyExport(body.export);
    if (typeof body.hostCapability !== "string" || body.hostCapability.length < 32) return apiError("INVALID_EXPORT", "Legacy export is invalid", 400);
    const now = Date.now();
    const exportHash = await legacyExportHash(parsed.exportValue);
    const write = await env.DB.prepare(
      `INSERT INTO legacy_room_imports
       (legacy_room_id, export_hash, export_json, legacy_host_capability_hash, legacy_guest_capability_hash, status, imported_at_ms, claim_deadline_ms, bearer_exchange_deadline_ms)
       VALUES (?, ?, ?, ?, ?, 'imported', ?, ?, ?)
       ON CONFLICT(legacy_room_id) DO UPDATE SET export_hash = excluded.export_hash, export_json = excluded.export_json
       WHERE legacy_room_imports.status = 'imported' AND legacy_room_imports.export_hash = excluded.export_hash`,
    ).bind(
      parsed.roomId, exportHash, JSON.stringify(parsed.exportValue), await hashOpaqueToken(body.hostCapability),
      typeof body.guestCapability === "string" ? await hashOpaqueToken(body.guestCapability) : null,
      now, now + LEGACY_CLAIM_WINDOW_MS, now + LEGACY_BEARER_WINDOW_MS,
    ).run();
    if ((write.meta.changes ?? 0) !== 1) {
      const existing = await env.DB.prepare("SELECT export_hash FROM legacy_room_imports WHERE legacy_room_id = ? LIMIT 1")
        .bind(parsed.roomId).first<{ export_hash: string }>();
      if (legacyImportWriteResult(write.meta.changes ?? 0, existing?.export_hash ?? null, exportHash) === "duplicate") {
        return apiResponse({ legacyRoomId: parsed.roomId, exportHash, duplicate: true });
      }
      return apiError("EXPORT_HASH_CONFLICT", "A different export already exists for this legacy room", 409);
    }
    return apiResponse({ legacyRoomId: parsed.roomId, exportHash, claimDeadlineMs: now + LEGACY_CLAIM_WINDOW_MS, bearerExchangeDeadlineMs: now + LEGACY_BEARER_WINDOW_MS }, { status: 201 });
  } catch {
    return apiError("INVALID_EXPORT", "Legacy export is invalid", 400);
  }
}
