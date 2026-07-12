import type { RoomCapabilityRole, StoredLiveRoomEvent } from "./live-room-events";

export type SnapshotService = "spotify" | "apple" | "ask";
export type SnapshotPhase = "idle" | "handoff" | "started";

export interface SnapshotParticipant {
  clientId: string;
  name: string;
  role: RoomCapabilityRole;
  service: SnapshotService;
  ready: boolean;
  lastSeenAtMs: number;
}

export interface SnapshotSuggestion {
  id: string;
  title: string;
  submittedBy: string;
  clientId: string;
  service: SnapshotService;
  status: "pending" | "approved";
}

export interface SnapshotActivity {
  sequence: number;
  text: string;
  createdAtMs: number;
}

export interface LiveRoomSnapshot {
  sequence: number;
  phase: SnapshotPhase;
  speakerService: "spotify" | "apple";
  nowTrackIndex: number;
  startedAtMs: number | null;
  reactionCount: number;
  participants: Record<string, SnapshotParticipant>;
  suggestions: Record<string, SnapshotSuggestion>;
  votes: Record<string, string[]>;
  activity: SnapshotActivity[];
}

export const createInitialLiveRoomSnapshot = (): LiveRoomSnapshot => ({
  sequence: 0,
  phase: "idle",
  speakerService: "spotify",
  nowTrackIndex: 0,
  startedAtMs: null,
  reactionCount: 0,
  participants: {},
  suggestions: {},
  votes: {},
  activity: [],
});

export function mergeRoomSnapshot(
  current: Readonly<Record<string, LiveRoomSnapshot>>,
  roomId: string,
  incoming: LiveRoomSnapshot,
  force = false,
): Record<string, LiveRoomSnapshot> {
  const previous = current[roomId];
  if (previous && (previous.sequence > incoming.sequence || (!force && previous.sequence === incoming.sequence))) {
    return current as Record<string, LiveRoomSnapshot>;
  }
  return { ...current, [roomId]: incoming };
}

const text = (payload: Readonly<Record<string, unknown>>, key: string): string =>
  typeof payload[key] === "string" ? String(payload[key]) : "";

const number = (payload: Readonly<Record<string, unknown>>, key: string): number | undefined =>
  typeof payload[key] === "number" ? Number(payload[key]) : undefined;

function activityText(event: StoredLiveRoomEvent): string {
  const service = text(event.payload, "service");
  switch (event.type) {
    case "participant_joined": return `${event.actorName} joined from ${service || "the shared link"}`;
    case "participant_service_changed": return `${event.actorName} switched their music-app lens to ${service}`;
    case "participant_left": return `${event.actorName} left the room`;
    case "ready_changed": return `${event.actorName} is ${event.payload.ready === true ? "ready" : "not ready"}`;
    case "reaction_added": return `${event.actorName} reacted to the current track`;
    case "suggestion_staged": return `${event.actorName} staged ${text(event.payload, "title")}`;
    case "suggestion_approved": return `${event.actorName} approved ${text(event.payload, "title")}`;
    case "suggestion_rejected": return `${event.actorName} passed on ${text(event.payload, "title")}`;
    case "vote_changed": return `${event.actorName} ${number(event.payload, "delta") === -1 ? "removed a vote" : "voted in the queue"}`;
    case "speaker_service_changed": return `${event.actorName} switched speaker duty to ${service}`;
    case "handoff_requested": return `${event.actorName} requested a ${service} handoff`;
    case "playback_confirmed": return `${event.actorName} confirmed the shared-speaker start`;
    case "track_advanced": return `${event.actorName} advanced the room`;
  }
}

export function reduceLiveRoomEvent(
  snapshot: LiveRoomSnapshot,
  event: StoredLiveRoomEvent,
): LiveRoomSnapshot {
  if (event.sequence <= snapshot.sequence) return snapshot;
  const participants = { ...snapshot.participants };
  const suggestions = { ...snapshot.suggestions };
  const votes = Object.fromEntries(Object.entries(snapshot.votes).map(([trackId, clientIds]) => [trackId, [...clientIds]]));
  const existingParticipant = participants[event.clientId];
  const payloadRole = text(event.payload, "role");
  const payloadService = text(event.payload, "service");
  participants[event.clientId] = {
    clientId: event.clientId,
    name: existingParticipant?.name ?? event.actorName,
    role: existingParticipant?.role ?? (payloadRole === "host" ? "host" : "guest"),
    service: payloadService === "spotify" || payloadService === "apple" || payloadService === "ask"
      ? payloadService
      : existingParticipant?.service ?? "ask",
    ready: existingParticipant?.ready ?? false,
    lastSeenAtMs: event.createdAtMs,
  };

  let phase = snapshot.phase;
  let speakerService = snapshot.speakerService;
  let nowTrackIndex = snapshot.nowTrackIndex;
  let startedAtMs = snapshot.startedAtMs;
  let reactionCount = snapshot.reactionCount;
  let includeActivity = true;

  switch (event.type) {
    case "participant_joined":
      break;
    case "participant_service_changed":
      break;
    case "participant_left":
      delete participants[event.clientId];
      break;
    case "ready_changed":
      if (participants[event.clientId].ready === (event.payload.ready === true)) includeActivity = false;
      participants[event.clientId] = { ...participants[event.clientId], ready: event.payload.ready === true };
      break;
    case "reaction_added":
      reactionCount += 1;
      break;
    case "suggestion_staged": {
      const id = text(event.payload, "suggestionId");
      const usedPicks = Object.values(suggestions).filter(({ clientId }) => clientId === event.clientId).length;
      if (!id || suggestions[id] || (participants[event.clientId].role === "guest" && usedPicks >= 3)) {
        includeActivity = false;
        break;
      }
      suggestions[id] = {
        id,
        title: text(event.payload, "title"),
        submittedBy: event.actorName,
        clientId: event.clientId,
        service: participants[event.clientId].service,
        status: "pending",
      };
      break;
    }
    case "suggestion_approved": {
      const id = text(event.payload, "suggestionId");
      const existing = suggestions[id];
      const usedPicks = Object.values(suggestions).filter(({ clientId }) => clientId === event.clientId).length;
      if (!id || existing?.status === "approved" || (!existing && participants[event.clientId].role === "guest" && usedPicks >= 3)) {
        includeActivity = false;
        break;
      }
      suggestions[id] = {
        id,
        title: existing?.title ?? text(event.payload, "title"),
        submittedBy: existing?.submittedBy ?? (text(event.payload, "submittedBy") || event.actorName),
        clientId: existing?.clientId ?? event.clientId,
        service: existing?.service ?? participants[event.clientId].service,
        status: "approved",
      };
      break;
    }
    case "suggestion_rejected": {
      const id = text(event.payload, "suggestionId");
      if (suggestions[id]?.status === "pending") delete suggestions[id];
      else includeActivity = false;
      break;
    }
    case "vote_changed": {
      const trackId = String(number(event.payload, "trackId") ?? "");
      const clients = new Set(votes[trackId] ?? []);
      const hadVote = clients.has(event.clientId);
      if (number(event.payload, "delta") === -1) {
        clients.delete(event.clientId);
        if (!hadVote) includeActivity = false;
      } else {
        clients.add(event.clientId);
        if (hadVote) includeActivity = false;
      }
      votes[trackId] = [...clients].sort();
      break;
    }
    case "speaker_service_changed":
      speakerService = payloadService === "apple" ? "apple" : "spotify";
      phase = "idle";
      startedAtMs = null;
      break;
    case "handoff_requested":
      if (payloadRole === "host") phase = "handoff";
      break;
    case "playback_confirmed":
      if (phase === "handoff") {
        phase = "started";
        startedAtMs = event.createdAtMs;
      } else includeActivity = false;
      break;
    case "track_advanced": {
      const nextIndex = number(event.payload, "trackIndex") ?? nowTrackIndex;
      if (nextIndex === nowTrackIndex) includeActivity = false;
      nowTrackIndex = nextIndex;
      phase = "idle";
      startedAtMs = null;
      reactionCount = 0;
      for (const clientId of Object.keys(participants)) {
        participants[clientId] = { ...participants[clientId], ready: false };
      }
      break;
    }
  }

  return {
    sequence: event.sequence,
    phase,
    speakerService,
    nowTrackIndex,
    startedAtMs,
    reactionCount,
    participants,
    suggestions,
    votes,
    activity: includeActivity
      ? [{ sequence: event.sequence, text: activityText(event), createdAtMs: event.createdAtMs }, ...snapshot.activity].slice(0, 30)
      : snapshot.activity,
  };
}

export function parseLiveRoomSnapshot(value: string | null | undefined): LiveRoomSnapshot {
  if (!value) return createInitialLiveRoomSnapshot();
  try {
    const parsed = JSON.parse(value) as LiveRoomSnapshot;
    if (!Number.isSafeInteger(parsed.sequence) || parsed.sequence < 0 || !parsed.participants || !parsed.suggestions || !parsed.votes) {
      return createInitialLiveRoomSnapshot();
    }
    return parsed;
  } catch {
    return createInitialLiveRoomSnapshot();
  }
}
