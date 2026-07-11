/** Shared wire contract for durable, replayable live-room events. */

export const LIVE_ROOM_EVENT_TYPES = [
  "participant_joined",
  "ready_changed",
  "reaction_added",
  "suggestion_staged",
  "suggestion_approved",
  "suggestion_rejected",
  "vote_changed",
  "speaker_service_changed",
  "handoff_requested",
  "playback_confirmed",
  "track_advanced",
] as const;

export type LiveRoomEventType = (typeof LIVE_ROOM_EVENT_TYPES)[number];
export type RoomCapabilityRole = "host" | "guest";

export type LiveRoomEventPayload = Readonly<Record<string, unknown>>;

export interface LiveRoomEventInput {
  readonly eventId: string;
  readonly clientId: string;
  readonly actorName: string;
  readonly type: LiveRoomEventType;
  readonly payload: LiveRoomEventPayload;
}

export interface StoredLiveRoomEvent extends LiveRoomEventInput {
  readonly sequence: number;
  readonly roomId: string;
  readonly createdAtMs: number;
}

const eventTypes = new Set<string>(LIVE_ROOM_EVENT_TYPES);
const safeIdentifier = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const hostOnlyEventTypes = new Set<LiveRoomEventType>([
  "suggestion_approved",
  "suggestion_rejected",
  "speaker_service_changed",
  "playback_confirmed",
  "track_advanced",
]);

export function normalizeRoomId(value: string): string {
  const roomId = value.trim().toLowerCase();
  if (!safeIdentifier.test(roomId)) {
    throw new Error("roomId must be a safe 1–128 character identifier");
  }
  return roomId;
}

function requireIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !safeIdentifier.test(value.trim())) {
    throw new Error(`${field} must be a safe identifier`);
  }
  return value.trim();
}

function requireText(value: unknown, field: string, maximum: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > maximum) {
    throw new Error(`${field} must contain 1–${maximum} characters`);
  }
  return text;
}

function requireInteger(value: unknown, field: string, minimum = 0, maximum = 1_000_000): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return Number(value);
}

function requireService(value: unknown): "spotify" | "apple" | "ask" {
  if (value !== "spotify" && value !== "apple" && value !== "ask") {
    throw new Error("service must be spotify, apple, or ask");
  }
  return value;
}

export function canRolePublishEvent(role: RoomCapabilityRole, type: LiveRoomEventType): boolean {
  return role === "host" || !hostOnlyEventTypes.has(type);
}

export function validateLiveRoomEventPayload(
  type: LiveRoomEventType,
  value: unknown,
  role?: RoomCapabilityRole,
): LiveRoomEventPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("payload must be an object");
  }
  if (role && !canRolePublishEvent(role, type)) {
    throw new Error("this capability cannot publish that event type");
  }
  const payload = value as Record<string, unknown>;
  switch (type) {
    case "participant_joined":
      return { role: role ?? (payload.role === "host" ? "host" : "guest"), service: requireService(payload.service) };
    case "ready_changed":
      if (typeof payload.ready !== "boolean") throw new Error("ready must be boolean");
      return { ready: payload.ready, trackId: requireInteger(payload.trackId, "trackId", 1) };
    case "reaction_added": {
      const reaction = payload.reaction;
      if (reaction !== "heart" && reaction !== "spark" && reaction !== "smile") {
        throw new Error("reaction is not supported");
      }
      return { trackId: requireInteger(payload.trackId, "trackId", 1), reaction };
    }
    case "suggestion_staged":
      return {
        suggestionId: requireIdentifier(payload.suggestionId, "suggestionId"),
        title: requireText(payload.title, "title", 300),
        service: requireService(payload.service),
      };
    case "suggestion_approved":
      return {
        suggestionId: requireIdentifier(payload.suggestionId, "suggestionId"),
        title: requireText(payload.title, "title", 300),
        submittedBy: requireText(payload.submittedBy, "submittedBy", 48),
        service: requireService(payload.service),
      };
    case "suggestion_rejected":
      return {
        suggestionId: requireIdentifier(payload.suggestionId, "suggestionId"),
        title: requireText(payload.title, "title", 300),
      };
    case "vote_changed": {
      const delta = requireInteger(payload.delta, "delta", -1, 1);
      if (delta === 0) throw new Error("delta must be -1 or 1");
      return { trackId: requireInteger(payload.trackId, "trackId", 1), delta };
    }
    case "speaker_service_changed": {
      const service = requireService(payload.service);
      if (service === "ask") throw new Error("speaker service cannot be ask");
      return { service };
    }
    case "handoff_requested": {
      const service = requireService(payload.service);
      if (service === "ask") throw new Error("handoff service cannot be ask");
      return {
        role: role ?? (payload.role === "host" ? "host" : "guest"),
        service,
        trackId: requireInteger(payload.trackId, "trackId", 1),
      };
    }
    case "playback_confirmed": {
      const service = requireService(payload.service);
      if (service === "ask") throw new Error("playback service cannot be ask");
      return { service, trackId: requireInteger(payload.trackId, "trackId", 1) };
    }
    case "track_advanced":
      return { trackIndex: requireInteger(payload.trackIndex, "trackIndex", 0, 9_999) };
  }
}

export function validateLiveRoomEventInput(value: unknown): LiveRoomEventInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("event body must be an object");
  }
  const candidate = value as Record<string, unknown>;
  const eventId = requireIdentifier(candidate.eventId, "eventId");
  const clientId = requireIdentifier(candidate.clientId, "clientId");
  const actorName = typeof candidate.actorName === "string" ? candidate.actorName.trim() : "";
  if (!actorName || actorName.length > 48) {
    throw new Error("actorName must contain 1–48 characters");
  }
  if (typeof candidate.type !== "string" || !eventTypes.has(candidate.type)) {
    throw new Error("event type is not supported");
  }
  const type = candidate.type as LiveRoomEventType;
  const payload = validateLiveRoomEventPayload(type, candidate.payload);
  if (JSON.stringify(payload).length > 4_096) {
    throw new Error("payload is too large");
  }
  return {
    eventId,
    clientId,
    actorName,
    type,
    payload,
  };
}

export function parseEventCursor(value: string | null): number {
  if (!value) return 0;
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new Error("after must be a non-negative safe integer");
  }
  return cursor;
}
