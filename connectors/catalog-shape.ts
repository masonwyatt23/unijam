import type { TrackVersion } from "../lib/room-engine.ts";

export function inferVersion(...values: readonly (string | undefined)[]): TrackVersion {
  const text = values.filter(Boolean).join(" ").toLowerCase();
  if (/\blive\b/.test(text)) return "live";
  if (/\bremix\b|\bmix\b/.test(text)) return "remix";
  if (/\bacoustic\b|\bunplugged\b/.test(text)) return "acoustic";
  if (/\binstrumental\b/.test(text)) return "instrumental";
  if (/\bradio edit\b|\bsingle edit\b/.test(text)) return "radio_edit";
  return "studio";
}

export function inferEdition(
  value: string | undefined,
): "standard" | "deluxe" | "expanded" | "unknown" {
  const text = (value ?? "").toLowerCase();
  if (/\bdeluxe\b/.test(text)) return "deluxe";
  if (/\bexpanded\b|\banniversary\b/.test(text)) return "expanded";
  return text ? "standard" : "unknown";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
