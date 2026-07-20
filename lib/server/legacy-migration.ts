import { assertBoundedJson, stableJson } from "../platform/protocol.ts";
import { hashOpaqueToken } from "./secure-token.ts";

export const LEGACY_CLAIM_WINDOW_MS = 90 * 24 * 60 * 60_000;
export const LEGACY_BEARER_WINDOW_MS = 30 * 24 * 60 * 60_000;

export type LegacyWindowState = "exchange" | "claim-only" | "read-only";

export function legacyWindowState(importedAtMs: number, now = Date.now()): LegacyWindowState {
  if (now <= importedAtMs + LEGACY_BEARER_WINDOW_MS) return "exchange";
  if (now <= importedAtMs + LEGACY_CLAIM_WINDOW_MS) return "claim-only";
  return "read-only";
}

export async function legacyExportHash(value: unknown): Promise<string> {
  return hashOpaqueToken(stableJson(value));
}

export function validateLegacyExport(value: unknown): { roomId: string; exportValue: Record<string, unknown> } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Legacy export is invalid");
  const exportValue = value as Record<string, unknown>;
  if (exportValue.version !== 1 || !exportValue.snapshot || typeof exportValue.snapshot !== "object" || !Array.isArray(exportValue.events)) {
    throw new Error("Legacy export is invalid");
  }
  const roomId = typeof exportValue.roomId === "string" ? exportValue.roomId.trim().toUpperCase() : "";
  if (!/^[A-Z0-9]{6,32}$/.test(roomId)) throw new Error("Legacy export is invalid");
  assertBoundedJson(exportValue, 32, 150_000);
  const serialized = stableJson(exportValue);
  if (serialized.length > 5_000_000) throw new Error("Legacy export is too large");
  return { roomId, exportValue };
}

export function legacyImportWriteResult(changes: number, existingHash: string | null, incomingHash: string): "created" | "duplicate" | "conflict" {
  if (changes === 1) return "created";
  return existingHash === incomingHash ? "duplicate" : "conflict";
}
