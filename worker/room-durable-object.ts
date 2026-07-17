import { DurableObject } from "cloudflare:workers";

import {
  ROOM_EVENT_RETENTION,
  commandIntent,
  newStableId,
  parseRoomCommand,
  parseRoomHello,
  roomActionRateLimit,
  shouldResetRoomState,
  type RoomActor,
  type RoomCommandAck,
  type RoomEvent,
  type RoomProtocolError,
} from "../lib/platform/protocol.ts";
import { legacyExportHash, validateLegacyExport } from "../lib/server/legacy-migration.ts";
import { BoundedBodyError, readBoundedJson } from "../lib/server/bounded-body.ts";

type RoomRules = {
  contributionLimit: number;
  approvalMode: "host" | "open";
  explicitContent: "allow" | "hold";
  versionPreference: "original" | "any";
  locked: boolean;
  speakerDuty: "host" | "shared";
};

type Suggestion = {
  suggestionId: string;
  recordingId: string;
  title: string;
  submittedBy: string;
  status: "pending" | "approved" | "held" | "rejected";
  resolutionId?: string;
  provenance?: ResolutionProvenance;
  display?: RecordingDisplay;
  occurrenceId?: string;
};

type RecordingDisplay = {
  artists: string[];
  album?: string;
  durationMs?: number;
  explicit?: boolean;
  provider: "spotify" | "apple_music";
  providerUrl: string;
  artwork?: { url: string; width: number; height: number };
};

type ResolutionProvenance = {
  matchId: string;
  provider: "spotify" | "apple_music";
  providerRecordingId: string;
  storefront: "US";
  method: "provider_id" | "metadata" | "user_correction";
  evidence: string[];
};

type ResolutionGrantRow = {
  resolution_id: string;
  recording_id: string;
  title: string;
  participant_id: string;
  explicit: number | null;
  display_json: string;
  provenance_json: string;
  expires_at_ms: number;
  consumed_suggestion_id: string | null;
};

type Occurrence = {
  occurrenceId: string;
  recordingId: string;
  suggestionId: string;
  title: string;
  display?: RecordingDisplay;
  status: "now" | "staged" | "held" | "played" | "skipped";
  position: number;
  cosignerIds: string[];
  voterIds: string[];
  playbackConfirmedAtMs?: number;
};

type RoomSnapshot = {
  roomId: string;
  seq: number;
  inviteEpoch: number;
  lifecycle: "active" | "ended";
  rules: RoomRules;
  participants: Record<string, RoomActor & { ready: boolean }>;
  suggestions: Record<string, Suggestion>;
  occurrences: Occurrence[];
  updatedAtMs: number;
};

type RoomEnv = Cloudflare.Env & {
  DB?: D1Database;
  ANALYTICS?: AnalyticsEngineDataset;
  ROOM_PROJECTION_QUEUE?: Queue;
};

type CommandRow = { intent_json: string; result_json: string };
type MetadataRow = { sequence: number; min_retained_seq: number; snapshot_json: string };
type SocketAttachment = {
  actor: RoomActor;
  roomId: string;
  sessionKind: "host" | "guest";
  sessionId: string;
  expiresAtMs: number;
  inviteEpoch: number;
  clientInstanceId?: string;
};

class RoomCommandRejection extends Error {
  constructor(message: string, readonly code = "COMMAND_REJECTED") {
    super(message);
    this.name = "RoomCommandRejection";
  }
}

const defaultRules: RoomRules = {
  contributionLimit: 3,
  approvalMode: "host",
  explicitContent: "hold",
  versionPreference: "original",
  locked: false,
  speakerDuty: "host",
};

const hostActions = new Set([
  "suggestion.approve", "suggestion.reject", "queue.reorder", "queue.advance", "queue.skip",
  "playback.confirm", "room.rules.update", "room.end", "room.invite.rotate", "participant.moderate",
  "handoff.confirm", "legacy.import",
]);

function protocolError(code: string, message: string, latestSeq: number, commandId?: string, retryable = false): RoomProtocolError {
  return { type: "error", code, message, retryable, latestSeq, ...(commandId ? { commandId } : {}) };
}

function requiredId(payload: Record<string, unknown>, key: string, prefix?: string): string {
  const value = typeof payload[key] === "string" ? String(payload[key]).trim() : "";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,191}$/.test(value) || (prefix && !value.startsWith(prefix))) {
    throw new Error(`${key} is malformed`);
  }
  return value;
}

function requiredText(payload: Record<string, unknown>, key: string, max = 300): string {
  const value = typeof payload[key] === "string" ? String(payload[key]).trim() : "";
  if (!value || value.length > max) throw new Error(`${key} is malformed`);
  return value;
}

function recordingDisplay(input: Record<string, unknown>, provider: RecordingDisplay["provider"], providerRecordingId: string): RecordingDisplay {
  const artists = Array.isArray(input.artists)
    ? input.artists.map((artist) => typeof artist === "string" ? artist.trim() : "").filter(Boolean)
    : [];
  if (artists.length === 0 || artists.length > 20 || artists.some((artist) => artist.length > 200)) throw new Error("artists are malformed");
  const album = typeof input.album === "string" && input.album.trim() ? input.album.trim() : undefined;
  if (album && album.length > 300) throw new Error("album is malformed");
  const durationMs = typeof input.durationMs === "number" && Number.isSafeInteger(input.durationMs) && input.durationMs >= 0 ? input.durationMs : undefined;
  const explicit = typeof input.explicit === "boolean" ? input.explicit : undefined;
  const providerUrl = provider === "spotify"
    ? `https://open.spotify.com/track/${providerRecordingId}`
    : `https://music.apple.com/us/song/-/${providerRecordingId}`;
  let artwork: RecordingDisplay["artwork"];
  if (input.artwork && typeof input.artwork === "object" && !Array.isArray(input.artwork)) {
    const candidate = input.artwork as Record<string, unknown>;
    const width = Number(candidate.width); const height = Number(candidate.height);
    const url = new URL(typeof candidate.url === "string" ? candidate.url : "");
    const approved = provider === "spotify"
      ? url.protocol === "https:" && url.hostname === "i.scdn.co" && url.pathname.startsWith("/image/")
      : url.protocol === "https:" && url.hostname.endsWith(".mzstatic.com");
    if (!approved || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 4_000 || height > 4_000) {
      throw new Error("artwork is malformed");
    }
    artwork = { url: url.href, width, height };
  }
  return { artists, ...(album ? { album } : {}), ...(durationMs === undefined ? {} : { durationMs }), ...(explicit === undefined ? {} : { explicit }), provider, providerUrl, ...(artwork ? { artwork } : {}) };
}

function storedRecordingDisplay(value: string): RecordingDisplay | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<RecordingDisplay>;
    return Array.isArray(parsed.artists) && parsed.artists.length > 0 &&
      (parsed.provider === "spotify" || parsed.provider === "apple_music") && typeof parsed.providerUrl === "string"
      ? parsed as RecordingDisplay
      : undefined;
  } catch { return undefined; }
}

function legacyFingerprint(value: string): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193) >>> 0;
    right = Math.imul(right ^ code, 0x85ebca6b) >>> 0;
  }
  return `${left.toString(16).padStart(8, "0")}${right.toString(16).padStart(8, "0")}`;
}

function legacyStableId(prefix: "sug_" | "rec_" | "occ_", value: string): string {
  return `${prefix}legacy_${legacyFingerprint(value)}`;
}

function normalizedLegacyTitle(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function hydrateLegacyActiveState(current: RoomSnapshot, exportValue: Record<string, unknown>): {
  snapshot: RoomSnapshot;
  rulesHydrated: boolean;
  occurrenceCount: number;
} {
  const snapshot = structuredClone(current);
  const legacySnapshot = exportValue.snapshot && typeof exportValue.snapshot === "object" && !Array.isArray(exportValue.snapshot)
    ? exportValue.snapshot as Record<string, unknown>
    : {};
  const legacySettings = exportValue.settings && typeof exportValue.settings === "object" && !Array.isArray(exportValue.settings)
    ? exportValue.settings as Record<string, unknown>
    : {};
  const candidateRules = {
    ...(legacySettings.rules && typeof legacySettings.rules === "object" ? legacySettings.rules as object : legacySettings),
    ...(legacySnapshot.rules && typeof legacySnapshot.rules === "object" ? legacySnapshot.rules as object : {}),
  } as Record<string, unknown>;
  let rulesHydrated = false;
  const contributionLimit = Number(candidateRules.contributionLimit);
  if (Number.isSafeInteger(contributionLimit) && contributionLimit >= 0 && contributionLimit <= 20) {
    snapshot.rules.contributionLimit = contributionLimit;
    rulesHydrated = true;
  } else if (typeof candidateRules.guestCanContribute === "boolean") {
    snapshot.rules.contributionLimit = candidateRules.guestCanContribute ? defaultRules.contributionLimit : 0;
    rulesHydrated = true;
  }
  if (candidateRules.approvalMode === "host" || candidateRules.approvalMode === "open") {
    snapshot.rules.approvalMode = candidateRules.approvalMode;
    rulesHydrated = true;
  } else if (typeof candidateRules.hostApproval === "boolean") {
    snapshot.rules.approvalMode = candidateRules.hostApproval ? "host" : "open";
    rulesHydrated = true;
  }
  if (candidateRules.explicitContent === "allow" || candidateRules.explicitContent === "hold") {
    snapshot.rules.explicitContent = candidateRules.explicitContent;
    rulesHydrated = true;
  }
  if (candidateRules.versionPreference === "original" || candidateRules.versionPreference === "any") {
    snapshot.rules.versionPreference = candidateRules.versionPreference;
    rulesHydrated = true;
  }
  if (candidateRules.speakerDuty === "host" || candidateRules.speakerDuty === "shared") {
    snapshot.rules.speakerDuty = candidateRules.speakerDuty;
    rulesHydrated = true;
  }
  if (typeof candidateRules.locked === "boolean") {
    snapshot.rules.locked = candidateRules.locked;
    rulesHydrated = true;
  }

  const legacySuggestions = legacySnapshot.suggestions && typeof legacySnapshot.suggestions === "object" && !Array.isArray(legacySnapshot.suggestions)
    ? legacySnapshot.suggestions as Record<string, unknown>
    : {};
  const importedSuggestions: Record<string, Suggestion> = {};
  const suggestionOrder: string[] = [];
  const legacyRoomId = typeof exportValue.roomId === "string" ? exportValue.roomId : snapshot.roomId;
  for (const [key, raw] of Object.entries(legacySuggestions)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const value = raw as Record<string, unknown>;
    const sourceSuggestionId = typeof value.suggestionId === "string"
      ? value.suggestionId
      : typeof value.id === "string" ? value.id : key;
    const title = typeof value.title === "string" ? value.title.trim() : "";
    if (!title || title.length > 300) continue;
    const suggestionId = /^sug_[a-zA-Z0-9._:-]{4,187}$/.test(sourceSuggestionId)
      ? sourceSuggestionId
      : legacyStableId("sug_", `${legacyRoomId}:${key}:${sourceSuggestionId}`);
    const service = value.service === "spotify" || value.service === "apple" ? value.service : "unknown";
    const recordingId = typeof value.recordingId === "string" && /^rec_[a-zA-Z0-9._:-]{4,187}$/.test(value.recordingId)
      ? value.recordingId
      : legacyStableId("rec_", `${service}:${normalizedLegacyTitle(title)}`);
    const status = ["pending", "approved", "held", "rejected"].includes(String(value.status))
      ? value.status as Suggestion["status"] : "held";
    if (importedSuggestions[suggestionId] &&
      (importedSuggestions[suggestionId].recordingId !== recordingId || normalizedLegacyTitle(importedSuggestions[suggestionId].title) !== normalizedLegacyTitle(title))) continue;
    importedSuggestions[suggestionId] = { suggestionId, recordingId, title, submittedBy: "legacy_deleted", status };
    suggestionOrder.push(suggestionId);
  }

  const importedOccurrences: Occurrence[] = [];
  const seenOccurrences = new Set<string>();
  const seenActiveRecordings = new Set<string>();
  const legacyOccurrences = Array.isArray(legacySnapshot.occurrences) ? legacySnapshot.occurrences : [];
  for (const raw of legacyOccurrences.slice(0, 2_000)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const value = raw as Record<string, unknown>;
    const occurrenceId = typeof value.occurrenceId === "string" ? value.occurrenceId : "";
    const recordingId = typeof value.recordingId === "string" ? value.recordingId : "";
    const suggestionId = typeof value.suggestionId === "string" ? value.suggestionId : "";
    const title = typeof value.title === "string" ? value.title.trim() : "";
    const status = value.status;
    if (!/^occ_[a-zA-Z0-9._:-]{4,187}$/.test(occurrenceId) || !/^rec_[a-zA-Z0-9._:-]{4,187}$/.test(recordingId) ||
      !/^sug_[a-zA-Z0-9._:-]{4,187}$/.test(suggestionId) || !title || title.length > 300 ||
      !["now", "staged", "held", "played", "skipped"].includes(String(status)) || seenOccurrences.has(occurrenceId)) continue;
    if (["now", "staged", "held"].includes(String(status)) && seenActiveRecordings.has(recordingId)) continue;
    const existingSuggestion = importedSuggestions[suggestionId];
    if (existingSuggestion &&
      (existingSuggestion.recordingId !== recordingId || normalizedLegacyTitle(existingSuggestion.title) !== normalizedLegacyTitle(title))) continue;
    seenOccurrences.add(occurrenceId);
    if (["now", "staged", "held"].includes(String(status))) seenActiveRecordings.add(recordingId);
    if (!existingSuggestion) {
      importedSuggestions[suggestionId] = { suggestionId, recordingId, title, submittedBy: "legacy_deleted", status: status === "held" ? "held" : "approved", occurrenceId };
    } else {
      importedSuggestions[suggestionId].occurrenceId = occurrenceId;
    }
    importedOccurrences.push({
      occurrenceId, recordingId, suggestionId, title, status: status as Occurrence["status"],
      position: Number.isSafeInteger(value.position) ? Number(value.position) : importedOccurrences.length,
      cosignerIds: [], voterIds: [],
      ...(Number.isSafeInteger(value.playbackConfirmedAtMs) ? { playbackConfirmedAtMs: Number(value.playbackConfirmedAtMs) } : {}),
    });
  }

  // The Sites alpha predates recording/occurrence IDs. Reconstruct its approved
  // queue deterministically in insertion order; identities and votes are not migrated.
  if (importedOccurrences.length === 0 && suggestionOrder.length > 0) {
    const approved = suggestionOrder
      .map((suggestionId) => importedSuggestions[suggestionId])
      .filter((suggestion): suggestion is Suggestion => suggestion?.status === "approved");
    const nowTrackIndex = Number.isSafeInteger(legacySnapshot.nowTrackIndex) && Number(legacySnapshot.nowTrackIndex) >= 0
      ? Number(legacySnapshot.nowTrackIndex) : 0;
    const occurrenceByRecording = new Map<string, string>();
    for (let index = 0; index < approved.length; index += 1) {
      const suggestion = approved[index];
      const existingOccurrenceId = occurrenceByRecording.get(suggestion.recordingId);
      if (existingOccurrenceId) {
        suggestion.occurrenceId = existingOccurrenceId;
        continue;
      }
      const occurrenceId = legacyStableId("occ_", `${legacyRoomId}:${suggestion.suggestionId}`);
      occurrenceByRecording.set(suggestion.recordingId, occurrenceId);
      suggestion.occurrenceId = occurrenceId;
      importedOccurrences.push({
        occurrenceId,
        recordingId: suggestion.recordingId,
        suggestionId: suggestion.suggestionId,
        title: suggestion.title,
        status: index < nowTrackIndex ? "played" : index === nowTrackIndex ? "now" : "staged",
        position: importedOccurrences.length,
        cosignerIds: [],
        voterIds: [],
      });
    }
  }
  if (Object.keys(importedSuggestions).length > 0) {
    snapshot.suggestions = importedSuggestions;
  }
  if (importedOccurrences.length > 0) {
    snapshot.occurrences = importedOccurrences.sort((left, right) => left.position - right.position);
  }
  snapshot.participants = Object.fromEntries(
    Object.entries(snapshot.participants).filter(([, participant]) => participant.role === "host"),
  );
  return { snapshot, rulesHydrated, occurrenceCount: importedOccurrences.length };
}

export class RoomDurableObject extends DurableObject<RoomEnv> {
  constructor(ctx: DurableObjectState, env: RoomEnv) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS metadata (room_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, min_retained_seq INTEGER NOT NULL DEFAULT 0, snapshot_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS participants (participant_id TEXT PRIMARY KEY, role TEXT NOT NULL, nickname TEXT NOT NULL, ready INTEGER NOT NULL DEFAULT 0, joined_at_ms INTEGER NOT NULL, last_seen_at_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS command_results (command_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, intent_json TEXT NOT NULL, result_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, event_id TEXT UNIQUE NOT NULL, command_id TEXT NOT NULL, event_type TEXT NOT NULL, actor_id TEXT NOT NULL, payload_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS events_command_idx ON events(command_id);
      CREATE TABLE IF NOT EXISTS suggestions (suggestion_id TEXT PRIMARY KEY, recording_id TEXT NOT NULL, submitter_id TEXT NOT NULL, status TEXT NOT NULL, occurrence_id TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS resolution_grants (resolution_id TEXT PRIMARY KEY, recording_id TEXT NOT NULL, title TEXT NOT NULL, participant_id TEXT NOT NULL, explicit INTEGER, provenance_json TEXT NOT NULL, expires_at_ms INTEGER NOT NULL, consumed_suggestion_id TEXT, created_at_ms INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS resolution_grants_participant_expiry_idx ON resolution_grants(participant_id, expires_at_ms);
      CREATE TABLE IF NOT EXISTS occurrences (occurrence_id TEXT PRIMARY KEY, recording_id TEXT NOT NULL, suggestion_id TEXT NOT NULL, status TEXT NOT NULL, position INTEGER NOT NULL, playback_confirmed_at_ms INTEGER, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS occurrences_active_recording_idx ON occurrences(recording_id) WHERE status IN ('now','staged','held');
      CREATE TABLE IF NOT EXISTS votes (occurrence_id TEXT NOT NULL, participant_id TEXT NOT NULL, created_at_ms INTEGER NOT NULL, PRIMARY KEY(occurrence_id, participant_id));
      CREATE TABLE IF NOT EXISTS cosignatures (occurrence_id TEXT NOT NULL, participant_id TEXT NOT NULL, created_at_ms INTEGER NOT NULL, PRIMARY KEY(occurrence_id, participant_id));
      CREATE TABLE IF NOT EXISTS destinations (destination_id TEXT PRIMARY KEY, provider TEXT NOT NULL, preview_hash TEXT NOT NULL, status TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (operation_id TEXT PRIMARY KEY, destination_id TEXT NOT NULL, status TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS rate_buckets (scope TEXT NOT NULL, bucket_start_ms INTEGER NOT NULL, request_count INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL, PRIMARY KEY(scope, bucket_start_ms));
      CREATE TABLE IF NOT EXISTS outbox (outbox_id TEXT PRIMARY KEY, event_id TEXT UNIQUE NOT NULL, payload_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL, delivered_at_ms INTEGER);
      CREATE TABLE IF NOT EXISTS legacy_imports (legacy_room_id TEXT PRIMARY KEY, export_hash TEXT UNIQUE NOT NULL, export_json TEXT NOT NULL, snapshot_json TEXT NOT NULL, events_json TEXT NOT NULL, settings_json TEXT, history_json TEXT, imported_at_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS account_deletions (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), purged_at_ms INTEGER NOT NULL);
    `);
    const resolutionColumns = this.ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(resolution_grants)").toArray();
    if (!resolutionColumns.some(({ name }) => name === "display_json")) {
      this.ctx.storage.sql.exec("ALTER TABLE resolution_grants ADD COLUMN display_json TEXT NOT NULL DEFAULT '{}'");
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const actor = this.actorFromRequest(request);
    if (url.pathname === "/internal/account-delete" && request.method === "POST") return this.purgeForAccountDeletion(request, actor);
    if (url.pathname === "/internal/initialize" && request.method === "POST") return this.initialize(request, actor);
    if (url.pathname === "/internal/resolutions" && request.method === "POST") return this.registerResolution(request, actor);
    if (url.pathname === "/internal/legacy-import" && request.method === "POST") return this.importLegacyExport(request, actor);
    if (url.pathname === "/state" && request.method === "GET") return this.stateResponse(url);
    if (url.pathname === "/commands" && request.method === "POST") {
      if (!actor) return Response.json(protocolError("UNAUTHORIZED", "Room session is missing", this.latestSeq()), { status: 401 });
      const startedAt = Date.now();
      const result = this.processCommand(await request.json(), actor, request.headers.get("X-UniJam-Control-Action") === "true");
      this.env.ANALYTICS?.writeDataPoint({
        blobs: ["room_command", result.type === "ack" ? "accepted" : result.code, actor.role],
        doubles: [Date.now() - startedAt, result.type === "ack" ? result.seq : result.latestSeq],
      });
      if (result.type === "ack") this.ctx.waitUntil(this.afterCommit(result));
      return Response.json(result, { status: result.type === "ack" ? 200 : this.errorStatus(result.code), headers: { "Cache-Control": "no-store" } });
    }
    if (url.pathname === "/websocket" && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      if (!actor) return new Response("Unauthorized", { status: 401 });
      const attachment = this.socketAttachmentFromRequest(request, actor);
      if (!attachment) return new Response("Unauthorized", { status: 401 });
      return this.openWebSocket(attachment);
    }
    return new Response("Not found", { status: 404 });
  }

  private actorFromRequest(request: Request): RoomActor | null {
    const participantId = request.headers.get("X-UniJam-Participant-Id");
    const role = request.headers.get("X-UniJam-Role");
    const nickname = request.headers.get("X-UniJam-Nickname");
    if (!participantId || !nickname || !role || !["host", "cohost", "guest", "viewer"].includes(role)) return null;
    return { participantId, nickname, role: role as RoomActor["role"] };
  }

  private socketAttachmentFromRequest(request: Request, actor: RoomActor): SocketAttachment | null {
    const sessionKind = request.headers.get("X-UniJam-Session-Kind");
    const sessionId = request.headers.get("X-UniJam-Session-Id") ?? "";
    const expiresAtMs = Number(request.headers.get("X-UniJam-Session-Expires-At"));
    const inviteEpoch = Number(request.headers.get("X-UniJam-Invite-Epoch"));
    if ((sessionKind !== "host" && sessionKind !== "guest") || !/^[a-zA-Z0-9-]{8,191}$/.test(sessionId) ||
      !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= Date.now() || !Number.isSafeInteger(inviteEpoch) || inviteEpoch < 1) return null;
    return { actor, roomId: this.metadataRoomId(), sessionKind, sessionId, expiresAtMs, inviteEpoch };
  }

  private initialize(request: Request, actor: RoomActor | null): Response {
    if (!actor || actor.role !== "host") return Response.json(protocolError("FORBIDDEN", "Only a host can initialize a room", this.latestSeq()), { status: 403 });
    const roomId = request.headers.get("X-UniJam-Room-Id") ?? "";
    if (!/^[A-Z0-9]{6,16}$/.test(roomId)) return Response.json(protocolError("INVALID_ROOM", "Room ID is malformed", 0), { status: 400 });
    const existing = this.metadata();
    if (existing) return Response.json(JSON.parse(existing.snapshot_json));
    const now = Date.now();
    const snapshot: RoomSnapshot = {
      roomId,
      seq: 0,
      inviteEpoch: 1,
      lifecycle: "active",
      rules: defaultRules,
      participants: { [actor.participantId]: { ...actor, ready: false } },
      suggestions: {},
      occurrences: [],
      updatedAtMs: now,
    };
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("INSERT INTO metadata (room_id, sequence, min_retained_seq, snapshot_json, updated_at_ms) VALUES (?, 0, 0, ?, ?)", roomId, JSON.stringify(snapshot), now);
      this.ctx.storage.sql.exec(
        "INSERT INTO participants (participant_id, role, nickname, ready, joined_at_ms, last_seen_at_ms) VALUES (?, 'host', ?, 0, ?, ?)",
        actor.participantId,
        actor.nickname,
        now,
        now,
      );
    });
    return Response.json(snapshot, { status: 201 });
  }

  private purgeForAccountDeletion(request: Request, actor: RoomActor | null): Response {
    if (!actor || actor.role !== "host" || request.headers.get("X-UniJam-Account-Deletion") !== "true") {
      return Response.json(protocolError("FORBIDDEN", "Only the account deletion coordinator can purge a room", this.latestSeq()), { status: 403 });
    }
    const prior = this.ctx.storage.sql.exec<{ purged_at_ms: number }>(
      "SELECT purged_at_ms FROM account_deletions WHERE singleton = 1 LIMIT 1",
    ).toArray()[0];
    if (prior) return Response.json({ purged: true, duplicate: true, purgedAtMs: prior.purged_at_ms });
    const metadata = this.metadata();
    if (!metadata) return Response.json({ purged: true, duplicate: true });
    const roomId = request.headers.get("X-UniJam-Room-Id") ?? "";
    const snapshot = JSON.parse(metadata.snapshot_json) as RoomSnapshot;
    if (snapshot.roomId !== roomId || snapshot.participants[actor.participantId]?.role !== "host") {
      return Response.json(protocolError("FORBIDDEN", "Account deletion authority does not own this room", metadata.sequence), { status: 403 });
    }
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`
        DELETE FROM participants;
        DELETE FROM command_results;
        DELETE FROM events;
        DELETE FROM suggestions;
        DELETE FROM resolution_grants;
        DELETE FROM occurrences;
        DELETE FROM votes;
        DELETE FROM cosignatures;
        DELETE FROM destinations;
        DELETE FROM operations;
        DELETE FROM rate_buckets;
        DELETE FROM outbox;
        DELETE FROM legacy_imports;
        DELETE FROM metadata;
      `);
      this.ctx.storage.sql.exec("INSERT INTO account_deletions (singleton, purged_at_ms) VALUES (1, ?)", now);
    });
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.close(1008, "Account deleted"); } catch { /* stale socket */ }
    }
    return Response.json({ purged: true, duplicate: false, purgedAtMs: now });
  }

  private async registerResolution(request: Request, actor: RoomActor | null): Promise<Response> {
    const metadata = this.metadata();
    if (!metadata) return Response.json(protocolError("ROOM_NOT_INITIALIZED", "Room has not been initialized", 0), { status: 404 });
    if (!actor || request.headers.get("X-UniJam-Resolution-Authority") !== "true") {
      return Response.json(protocolError("FORBIDDEN", "Only the catalog resolver can register a recording", metadata.sequence), { status: 403 });
    }
    const snapshot = JSON.parse(metadata.snapshot_json) as RoomSnapshot;
    const participant = snapshot.participants[actor.participantId];
    if (!participant || snapshot.lifecycle !== "active") {
      return Response.json(protocolError("FORBIDDEN", "The resolver participant is not active in this room", metadata.sequence), { status: 403 });
    }
    let body: unknown;
    try { body = await readBoundedJson(request, 16_384); }
    catch { return Response.json(protocolError("INVALID_RESOLUTION", "Resolved recording provenance is invalid", metadata.sequence), { status: 400 }); }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json(protocolError("INVALID_RESOLUTION", "Resolved recording provenance is invalid", metadata.sequence), { status: 400 });
    }
    const input = body as Record<string, unknown>;
    try {
      const resolutionId = requiredId(input, "resolutionId", "res_");
      const recordingId = requiredId(input, "recordingId", "rec_");
      const title = requiredText(input, "title");
      const matchId = requiredId(input, "matchId", "match_");
      const provider = input.provider;
      const method = input.method;
      const providerRecordingId = requiredText(input, "providerRecordingId", 200);
      const explicit = input.explicit;
      const rawEvidence = input.evidence;
      if ((provider !== "spotify" && provider !== "apple_music") ||
        (method !== "provider_id" && method !== "metadata" && method !== "user_correction") ||
        (explicit !== null && typeof explicit !== "boolean") || !Array.isArray(rawEvidence) || rawEvidence.length === 0 || rawEvidence.length > 16) {
        throw new Error("Resolved recording provenance is malformed");
      }
      const evidence = rawEvidence.map((entry) => {
        if (typeof entry !== "string" || !entry.trim() || entry.trim().length > 120) throw new Error("Resolution evidence is malformed");
        return entry.trim();
      });
      const provenance: ResolutionProvenance = { matchId, provider, providerRecordingId, storefront: "US", method, evidence };
      const provenanceJson = JSON.stringify(provenance);
      const displayJson = JSON.stringify(recordingDisplay(input, provider, providerRecordingId));
      const existing = this.ctx.storage.sql.exec<ResolutionGrantRow>(
        "SELECT resolution_id, recording_id, title, participant_id, explicit, display_json, provenance_json, expires_at_ms, consumed_suggestion_id FROM resolution_grants WHERE resolution_id = ? LIMIT 1",
        resolutionId,
      ).toArray()[0];
      if (existing) {
        const same = existing.recording_id === recordingId && existing.title === title && existing.participant_id === actor.participantId &&
          existing.explicit === (explicit === null ? null : explicit ? 1 : 0) && existing.display_json === displayJson && existing.provenance_json === provenanceJson;
        if (!same) return Response.json(protocolError("RESOLUTION_ID_CONFLICT", "resolutionId was already registered with different provenance", metadata.sequence), { status: 409 });
        return Response.json({ resolutionId, duplicate: true, expiresAtMs: existing.expires_at_ms });
      }
      const now = Date.now();
      const expiresAtMs = now + 15 * 60_000;
      this.ctx.storage.sql.exec("DELETE FROM resolution_grants WHERE expires_at_ms <= ? AND consumed_suggestion_id IS NULL", now);
      this.ctx.storage.sql.exec(
        `INSERT INTO resolution_grants
         (resolution_id, recording_id, title, participant_id, explicit, display_json, provenance_json, expires_at_ms, consumed_suggestion_id, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        resolutionId,
        recordingId,
        title,
        actor.participantId,
        explicit === null ? null : explicit ? 1 : 0,
        displayJson,
        provenanceJson,
        expiresAtMs,
        now,
      );
      return Response.json({ resolutionId, duplicate: false, expiresAtMs }, { status: 201 });
    } catch {
      return Response.json(protocolError("INVALID_RESOLUTION", "Resolved recording provenance is invalid", metadata.sequence), { status: 400 });
    }
  }

  private async importLegacyExport(request: Request, actor: RoomActor | null): Promise<Response> {
    if (!actor || actor.role !== "host" || request.headers.get("X-UniJam-Control-Action") !== "true") {
      return Response.json(protocolError("FORBIDDEN", "Only the room owner can import a legacy room", this.latestSeq()), { status: 403 });
    }
    let body: unknown;
    try { body = await readBoundedJson(request, 5_250_000); }
    catch (error) {
      const tooLarge = error instanceof BoundedBodyError && error.status === 413;
      return Response.json(protocolError(
        tooLarge ? "LEGACY_EXPORT_TOO_LARGE" : "INVALID_LEGACY_EXPORT",
        tooLarge ? "Legacy export exceeds the import limit" : "Legacy export is invalid",
        this.latestSeq(),
      ), { status: tooLarge ? 413 : 400 });
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json(protocolError("INVALID_LEGACY_EXPORT", "Legacy export is invalid", this.latestSeq()), { status: 400 });
    }
    const source = body as Record<string, unknown>;
    let parsed: ReturnType<typeof validateLegacyExport>;
    try { parsed = validateLegacyExport(source.export); }
    catch { return Response.json(protocolError("INVALID_LEGACY_EXPORT", "Legacy export is invalid", this.latestSeq()), { status: 400 }); }
    const suppliedHash = typeof source.exportHash === "string" ? source.exportHash : "";
    const actualHash = await legacyExportHash(parsed.exportValue);
    if (!suppliedHash || suppliedHash !== actualHash) {
      return Response.json(protocolError("LEGACY_EXPORT_HASH_MISMATCH", "Legacy export integrity check failed", this.latestSeq()), { status: 409 });
    }
    const metadata = this.metadata();
    if (!metadata) return Response.json(protocolError("ROOM_NOT_INITIALIZED", "Room has not been initialized", 0), { status: 404 });
    const prior = this.ctx.storage.sql.exec<{ export_hash: string }>(
      "SELECT export_hash FROM legacy_imports WHERE legacy_room_id = ? LIMIT 1", parsed.roomId,
    ).toArray()[0];
    if (prior) {
      if (prior.export_hash !== actualHash) {
        return Response.json(protocolError("LEGACY_EXPORT_CONFLICT", "A different legacy export was already imported", metadata.sequence), { status: 409 });
      }
      return Response.json({ imported: true, duplicate: true, legacyRoomId: parsed.roomId, exportHash: actualHash, seq: metadata.sequence });
    }
    const now = Date.now();
    const eventId = newStableId("evt");
    const commandId = `legacy_import_${actualHash.slice(0, 24)}`;
    const currentSnapshot = JSON.parse(metadata.snapshot_json) as RoomSnapshot;
    currentSnapshot.inviteEpoch ??= 1;
    if (Object.keys(currentSnapshot.suggestions).length > 0 || currentSnapshot.occurrences.length > 0) {
      return Response.json(protocolError("LEGACY_TARGET_NOT_EMPTY", "Legacy rooms can only be claimed into an empty room", metadata.sequence), { status: 409 });
    }
    const hydration = hydrateLegacyActiveState(currentSnapshot, parsed.exportValue);
    const snapshot = hydration.snapshot;
    const event: RoomEvent = {
      eventId,
      seq: metadata.sequence + 1,
      commandId,
      type: "legacy.imported",
      actor,
      payload: {
        legacyRoomId: parsed.roomId,
        exportHash: actualHash,
        eventCount: Array.isArray(parsed.exportValue.events) ? parsed.exportValue.events.length : 0,
        fullPayloadStored: true,
        rulesHydrated: hydration.rulesHydrated,
        occurrenceCount: hydration.occurrenceCount,
      },
      createdAtMs: now,
    };
    snapshot.seq = event.seq;
    snapshot.updatedAtMs = now;
    this.ctx.storage.transactionSync(() => {
      const exportValue = parsed.exportValue;
      this.ctx.storage.sql.exec(
        `INSERT INTO legacy_imports
         (legacy_room_id, export_hash, export_json, snapshot_json, events_json, settings_json, history_json, imported_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        parsed.roomId,
        actualHash,
        JSON.stringify(exportValue),
        JSON.stringify(exportValue.snapshot),
        JSON.stringify(exportValue.events),
        exportValue.settings === undefined ? null : JSON.stringify(exportValue.settings),
        exportValue.history === undefined ? null : JSON.stringify(exportValue.history),
        now,
      );
      for (const suggestion of Object.values(snapshot.suggestions)) {
        this.ctx.storage.sql.exec(
          `INSERT INTO suggestions (suggestion_id, recording_id, submitter_id, status, occurrence_id, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          suggestion.suggestionId, suggestion.recordingId, suggestion.submittedBy, suggestion.status, suggestion.occurrenceId ?? null, now, now,
        );
      }
      for (const occurrence of snapshot.occurrences) {
        this.ctx.storage.sql.exec(
          `INSERT INTO occurrences
           (occurrence_id, recording_id, suggestion_id, status, position, playback_confirmed_at_ms, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          occurrence.occurrenceId, occurrence.recordingId, occurrence.suggestionId, occurrence.status, occurrence.position,
          occurrence.playbackConfirmedAtMs ?? null, now, now,
        );
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO events (seq, event_id, command_id, event_type, actor_id, payload_json, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
        event.seq, event.eventId, event.commandId, event.type, actor.participantId, JSON.stringify(event.payload), event.createdAtMs,
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO outbox (outbox_id, event_id, payload_json, created_at_ms) VALUES (?, ?, ?, ?)",
        newStableId("out"), event.eventId, JSON.stringify({ event, snapshot }), now,
      );
      this.ctx.storage.sql.exec(
        "UPDATE metadata SET sequence = ?, snapshot_json = ?, updated_at_ms = ?",
        snapshot.seq, JSON.stringify(snapshot), now,
      );
    });
    const ack: RoomCommandAck = { type: "ack", commandId, seq: event.seq, duplicate: false, events: [event] };
    this.ctx.waitUntil(this.afterCommit(ack));
    return Response.json({ imported: true, duplicate: false, legacyRoomId: parsed.roomId, exportHash: actualHash, seq: event.seq });
  }

  private metadata(): MetadataRow | null {
    return this.ctx.storage.sql.exec<MetadataRow>("SELECT sequence, min_retained_seq, snapshot_json FROM metadata LIMIT 1").toArray()[0] ?? null;
  }

  private latestSeq(): number {
    return this.metadata()?.sequence ?? 0;
  }

  private stateResponse(url: URL): Response {
    const metadata = this.metadata();
    if (!metadata) return Response.json(protocolError("ROOM_NOT_INITIALIZED", "Room has not been initialized", 0), { status: 404 });
    const cursor = url.searchParams.get("after");
    const after = Number(cursor ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) return Response.json(protocolError("INVALID_CURSOR", "after is invalid", metadata.sequence), { status: 400 });
    if (shouldResetRoomState(cursor, after, metadata.min_retained_seq)) {
      return Response.json({ type: "snapshot", reset: true, snapshot: JSON.parse(metadata.snapshot_json), latestSeq: metadata.sequence });
    }
    const events = [...this.ctx.storage.sql.exec<{
      seq: number; event_id: string; command_id: string; event_type: string; actor_id: string; payload_json: string; created_at_ms: number;
    }>("SELECT seq, event_id, command_id, event_type, actor_id, payload_json, created_at_ms FROM events WHERE seq > ? ORDER BY seq LIMIT 500", after)].map((row) => ({
      seq: row.seq, eventId: row.event_id, commandId: row.command_id, type: row.event_type,
      actor: { participantId: row.actor_id }, payload: JSON.parse(row.payload_json), createdAtMs: row.created_at_ms,
    }));
    return Response.json({ type: "events", reset: false, events, latestSeq: metadata.sequence, hasMore: events.length === 500 });
  }

  private processCommand(raw: unknown, actor: RoomActor, allowControlAction = false): RoomCommandAck | RoomProtocolError {
    const latestSeq = this.latestSeq();
    let command;
    try { command = parseRoomCommand(raw); }
    catch (error) { return protocolError("INVALID_COMMAND", error instanceof Error ? error.message : "Command is invalid", latestSeq); }
    const metadata = this.metadata();
    if (!metadata) return protocolError("ROOM_NOT_INITIALIZED", "Room has not been initialized", 0, command.commandId);
    const snapshot = JSON.parse(metadata.snapshot_json) as RoomSnapshot;
    let canonicalActor = actor;
    if (actor.role !== "host") {
      const participant = snapshot.participants[actor.participantId];
      if (!participant && command.action !== "participant.join") {
        return protocolError("FORBIDDEN", "Join the room before sending commands", metadata.sequence, command.commandId);
      }
      // D1 is an asynchronous projection. Existing non-host authority and
      // display identity therefore come only from the canonical room snapshot,
      // never from a potentially stale forwarded session role. An absent actor
      // may join, but a stale co-host projection cannot carry authority back in.
      canonicalActor = participant
        ? { participantId: participant.participantId, role: participant.role, nickname: participant.nickname }
        : { ...actor, role: actor.role === "viewer" ? "viewer" : "guest" };
    }
    const intent = commandIntent(command, canonicalActor);
    const existing = this.ctx.storage.sql.exec<CommandRow>("SELECT intent_json, result_json FROM command_results WHERE command_id = ? LIMIT 1", command.commandId).toArray()[0];
    if (existing) {
      if (existing.intent_json !== intent) return protocolError("COMMAND_ID_CONFLICT", "commandId was already used for different intent", latestSeq, command.commandId);
      const original = JSON.parse(existing.result_json) as RoomCommandAck;
      return { ...original, duplicate: true };
    }
    if (command.expectedSeq !== undefined && command.expectedSeq !== metadata.sequence) {
      return protocolError("STALE_SEQUENCE", "Room state changed; apply the latest state and retry", metadata.sequence, command.commandId, true);
    }
    if (hostActions.has(command.action) && canonicalActor.role !== "host" && canonicalActor.role !== "cohost") {
      return protocolError("FORBIDDEN", "This command requires host authority", metadata.sequence, command.commandId);
    }
    if ((command.action === "room.invite.rotate" || command.action === "room.end" || command.action === "legacy.import") && !allowControlAction) {
      return protocolError("CONTROL_ENDPOINT_REQUIRED", "Use the passkey-confirmed room control endpoint", metadata.sequence, command.commandId);
    }
    const rateLimit = this.consumeCommandRateLimit(canonicalActor, command.action);
    if (rateLimit) return protocolError("RATE_LIMITED", "Room activity is moving too quickly", metadata.sequence, command.commandId, true);
    let result: RoomCommandAck | RoomProtocolError;
    try {
      result = this.ctx.storage.transactionSync(() => this.applyCommand(command, canonicalActor, metadata, intent));
    } catch (error) {
      result = protocolError(
        error instanceof RoomCommandRejection ? error.code : "COMMAND_REJECTED",
        error instanceof RoomCommandRejection ? error.message : "Command was rejected",
        metadata.sequence,
        command.commandId,
      );
    }
    return result;
  }

  private applyCommand(
    command: ReturnType<typeof parseRoomCommand>, actor: RoomActor, metadata: MetadataRow, intent: string,
  ): RoomCommandAck {
    const now = Date.now();
    const snapshot = JSON.parse(metadata.snapshot_json) as RoomSnapshot;
    snapshot.inviteEpoch ??= 1;
    if (snapshot.lifecycle === "ended" && command.action !== "participant.leave") throw new Error("This room has ended");
    if (snapshot.rules.locked && actor.role === "guest" && command.action === "suggestion.stage") throw new Error("This room is locked");
    if (actor.role === "viewer" && !["participant.join", "participant.leave"].includes(command.action)) throw new Error("This invite is view-only");
    const pending: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const emit = (type: string, payload: Record<string, unknown>) => pending.push({ type, payload });

    switch (command.action) {
      case "participant.join":
        if ((actor.role === "guest" || actor.role === "viewer") && snapshot.rules.locked) {
          throw new RoomCommandRejection("This room is locked", "ROOM_LOCKED");
        }
        if (!snapshot.participants[actor.participantId] && Object.keys(snapshot.participants).length >= 25) {
          throw new RoomCommandRejection("This room has reached the 25-participant pilot limit", "ROOM_FULL");
        }
        snapshot.participants[actor.participantId] = { ...actor, ready: false };
        this.ctx.storage.sql.exec(
          `INSERT INTO participants (participant_id, role, nickname, ready, joined_at_ms, last_seen_at_ms) VALUES (?, ?, ?, 0, ?, ?)
           ON CONFLICT(participant_id) DO UPDATE SET role=excluded.role, nickname=excluded.nickname, last_seen_at_ms=excluded.last_seen_at_ms`,
          actor.participantId, actor.role, actor.nickname, now, now,
        );
        emit("participant.joined", {});
        break;
      case "participant.leave":
        delete snapshot.participants[actor.participantId];
        this.ctx.storage.sql.exec("DELETE FROM participants WHERE participant_id = ?", actor.participantId);
        emit("participant.left", {});
        break;
      case "participant.ready": {
        const participant = snapshot.participants[actor.participantId];
        if (!participant) throw new Error("Join the room before changing readiness");
        const ready = command.payload.ready;
        if (typeof ready !== "boolean") throw new Error("ready must be boolean");
        participant.ready = ready;
        this.ctx.storage.sql.exec("UPDATE participants SET ready = ?, last_seen_at_ms = ? WHERE participant_id = ?", ready ? 1 : 0, now, actor.participantId);
        emit("participant.ready_changed", { ready });
        break;
      }
      case "participant.moderate": {
        const participantId = requiredId(command.payload, "participantId");
        const role = command.payload.role;
        if (role !== "cohost" && role !== "guest" && role !== "viewer") throw new Error("Moderation role is unsupported");
        const participant = snapshot.participants[participantId];
        if (!participant || participant.role === "host") throw new Error("Participant cannot be moderated");
        participant.role = role;
        this.ctx.storage.sql.exec("UPDATE participants SET role = ?, last_seen_at_ms = ? WHERE participant_id = ?", role, now, participantId);
        emit("participant.moderated", { participantId, role });
        break;
      }
      case "suggestion.stage": {
        const suggestionId = requiredId(command.payload, "suggestionId", "sug_");
        const resolutionId = requiredId(command.payload, "resolutionId", "res_");
        if ("recordingId" in command.payload || "title" in command.payload || "held" in command.payload) {
          throw new RoomCommandRejection("Canonical recording fields must come from the catalog resolver");
        }
        if (snapshot.suggestions[suggestionId]) throw new Error("suggestionId already exists");
        const resolution = this.ctx.storage.sql.exec<ResolutionGrantRow>(
          "SELECT resolution_id, recording_id, title, participant_id, explicit, display_json, provenance_json, expires_at_ms, consumed_suggestion_id FROM resolution_grants WHERE resolution_id = ? LIMIT 1",
          resolutionId,
        ).toArray()[0];
        if (!resolution || resolution.participant_id !== actor.participantId || resolution.expires_at_ms <= now || resolution.consumed_suggestion_id) {
          throw new RoomCommandRejection("Use a current recording resolved for this participant");
        }
        const recordingId = resolution.recording_id;
        const title = resolution.title;
        const provenance = JSON.parse(resolution.provenance_json) as ResolutionProvenance;
        const display = storedRecordingDisplay(resolution.display_json);
        const used = Object.values(snapshot.suggestions).filter((suggestion) => suggestion.submittedBy === actor.participantId && suggestion.status !== "rejected").length;
        if (actor.role === "guest" && used >= snapshot.rules.contributionLimit) throw new Error("Contribution limit reached");
        const status = resolution.explicit === 1 && snapshot.rules.explicitContent === "hold"
          ? "held"
          : snapshot.rules.approvalMode === "open" ? "approved" : "pending";
        snapshot.suggestions[suggestionId] = { suggestionId, recordingId, title, submittedBy: actor.participantId, status, resolutionId, provenance, ...(display ? { display } : {}) };
        this.ctx.storage.sql.exec("UPDATE resolution_grants SET consumed_suggestion_id = ? WHERE resolution_id = ? AND consumed_suggestion_id IS NULL", suggestionId, resolutionId);
        this.ctx.storage.sql.exec("INSERT INTO suggestions (suggestion_id, recording_id, submitter_id, status, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?)", suggestionId, recordingId, actor.participantId, status, now, now);
        emit(status === "held" ? "suggestion.held" : "suggestion.staged", { suggestionId, recordingId, title, status, resolutionId, provenance });
        if (status === "approved") this.approveSuggestion(snapshot, snapshot.suggestions[suggestionId], actor, now, emit);
        break;
      }
      case "suggestion.approve": {
        const suggestionId = requiredId(command.payload, "suggestionId", "sug_");
        const suggestion = snapshot.suggestions[suggestionId];
        if (!suggestion || !["pending", "held"].includes(suggestion.status)) throw new Error("Only a pending or held suggestion can be approved");
        this.approveSuggestion(snapshot, suggestion, actor, now, emit);
        break;
      }
      case "suggestion.reject": {
        const suggestionId = requiredId(command.payload, "suggestionId", "sug_");
        const suggestion = snapshot.suggestions[suggestionId];
        if (!suggestion || suggestion.status === "approved") throw new Error("Suggestion cannot be rejected");
        suggestion.status = "rejected";
        this.ctx.storage.sql.exec("UPDATE suggestions SET status = 'rejected', updated_at_ms = ? WHERE suggestion_id = ?", now, suggestionId);
        emit("suggestion.rejected", { suggestionId });
        break;
      }
      case "queue.vote": {
        const occurrenceId = requiredId(command.payload, "occurrenceId", "occ_");
        const occurrence = snapshot.occurrences.find((item) => item.occurrenceId === occurrenceId && !["played", "skipped"].includes(item.status));
        if (!occurrence) throw new Error("Queue occurrence is no longer active");
        const vote = command.payload.vote;
        if (typeof vote !== "boolean") throw new Error("vote must be boolean");
        const voters = new Set(occurrence.voterIds);
        if (voters.has(actor.participantId) === vote) throw new Error(vote ? "Vote already exists" : "Vote does not exist");
        if (vote) {
          voters.add(actor.participantId);
          this.ctx.storage.sql.exec("INSERT INTO votes (occurrence_id, participant_id, created_at_ms) VALUES (?, ?, ?)", occurrenceId, actor.participantId, now);
        } else {
          voters.delete(actor.participantId);
          this.ctx.storage.sql.exec("DELETE FROM votes WHERE occurrence_id = ? AND participant_id = ?", occurrenceId, actor.participantId);
        }
        occurrence.voterIds = [...voters].sort();
        emit("queue.vote_changed", { occurrenceId, vote });
        break;
      }
      case "queue.reorder": {
        const ids = command.payload.occurrenceIds;
        if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) throw new Error("occurrenceIds must be an array");
        const active = snapshot.occurrences.filter((item) => item.status === "staged");
        if (new Set(ids).size !== active.length || active.some((item) => !ids.includes(item.occurrenceId))) throw new Error("Reorder must include every staged occurrence once");
        const positions = new Map(ids.map((id, index) => [id, index + 1]));
        for (const item of active) {
          item.position = positions.get(item.occurrenceId) ?? item.position;
          this.ctx.storage.sql.exec("UPDATE occurrences SET position = ?, updated_at_ms = ? WHERE occurrence_id = ?", item.position, now, item.occurrenceId);
        }
        snapshot.occurrences.sort((left, right) => left.position - right.position);
        emit("queue.reordered", { occurrenceIds: ids });
        break;
      }
      case "handoff.request": {
        const occurrenceId = requiredId(command.payload, "occurrenceId", "occ_");
        const provider = command.payload.provider;
        if (provider !== "spotify" && provider !== "apple_music") throw new RoomCommandRejection("Provider is unsupported");
        const occurrence = snapshot.occurrences.find((item) => item.occurrenceId === occurrenceId && !["played", "skipped"].includes(item.status));
        if (!occurrence) throw new RoomCommandRejection("Queue occurrence is no longer active");
        emit("handoff.requested", { occurrenceId, provider });
        break;
      }
      case "handoff.open":
      case "handoff.confirm": {
        const occurrenceId = requiredId(command.payload, "occurrenceId", "occ_");
        const provider = command.payload.provider;
        if (provider !== "spotify" && provider !== "apple_music") throw new RoomCommandRejection("Provider is unsupported");
        const occurrence = snapshot.occurrences.find((item) => item.occurrenceId === occurrenceId && !["played", "skipped"].includes(item.status));
        if (!occurrence) throw new RoomCommandRejection("Queue occurrence is no longer active");
        emit(command.action === "handoff.open" ? "handoff.opened" : "handoff.host_confirmed", { occurrenceId, provider });
        break;
      }
      case "playback.confirm": {
        const occurrenceId = requiredId(command.payload, "occurrenceId", "occ_");
        const occurrence = snapshot.occurrences.find((item) => item.occurrenceId === occurrenceId && item.status === "now");
        if (!occurrence) throw new Error("Playback can only be confirmed for Now");
        if (occurrence.playbackConfirmedAtMs) throw new RoomCommandRejection("Playback is already confirmed");
        occurrence.playbackConfirmedAtMs = now;
        this.ctx.storage.sql.exec("UPDATE occurrences SET playback_confirmed_at_ms = ?, updated_at_ms = ? WHERE occurrence_id = ?", now, now, occurrenceId);
        emit("playback.confirmed", { occurrenceId, confirmedAtMs: now });
        break;
      }
      case "queue.advance":
      case "queue.skip": {
        const occurrenceId = requiredId(command.payload, "occurrenceId", "occ_");
        const current = snapshot.occurrences.find((item) => item.occurrenceId === occurrenceId && item.status === "now");
        if (!current) throw new Error("Queue changed before this command arrived");
        if (command.action === "queue.advance" && !current.playbackConfirmedAtMs) {
          throw new RoomCommandRejection("Confirm playback before advancing the queue");
        }
        current.status = command.action === "queue.skip" ? "skipped" : "played";
        const next = snapshot.occurrences.filter((item) => item.status === "staged").sort((a, b) => a.position - b.position)[0];
        if (next) next.status = "now";
        this.ctx.storage.sql.exec("UPDATE occurrences SET status = ?, updated_at_ms = ? WHERE occurrence_id = ?", current.status, now, current.occurrenceId);
        if (next) this.ctx.storage.sql.exec("UPDATE occurrences SET status = 'now', updated_at_ms = ? WHERE occurrence_id = ?", now, next.occurrenceId);
        emit(command.action === "queue.skip" ? "queue.skipped" : "queue.advanced", { occurrenceId, nextOccurrenceId: next?.occurrenceId ?? null });
        break;
      }
      case "reaction.add": {
        const occurrenceId = requiredId(command.payload, "occurrenceId", "occ_");
        const reaction = command.payload.reaction;
        if (!["heart", "fire", "applause"].includes(String(reaction))) throw new RoomCommandRejection("Reaction is unsupported");
        const occurrence = snapshot.occurrences.find((item) => item.occurrenceId === occurrenceId && !["played", "skipped"].includes(item.status));
        if (!occurrence) throw new RoomCommandRejection("Queue occurrence is no longer active");
        emit("reaction.added", { occurrenceId, reaction });
        break;
      }
      case "room.rules.update": {
        const next = command.payload.rules;
        if (!next || typeof next !== "object" || Array.isArray(next)) throw new Error("rules must be an object");
        const input = next as Record<string, unknown>;
        if (input.contributionLimit !== undefined) {
          const limit = Number(input.contributionLimit);
          if (!Number.isSafeInteger(limit) || limit < 0 || limit > 20) throw new Error("contributionLimit must be 0-20");
          snapshot.rules.contributionLimit = limit;
        }
        if (typeof input.locked === "boolean") snapshot.rules.locked = input.locked;
        if (input.approvalMode === "host" || input.approvalMode === "open") snapshot.rules.approvalMode = input.approvalMode;
        if (input.explicitContent === "allow" || input.explicitContent === "hold") snapshot.rules.explicitContent = input.explicitContent;
        if (input.versionPreference === "original" || input.versionPreference === "any") snapshot.rules.versionPreference = input.versionPreference;
        if (input.speakerDuty === "host" || input.speakerDuty === "shared") snapshot.rules.speakerDuty = input.speakerDuty;
        emit("room.rules_updated", { rules: snapshot.rules });
        break;
      }
      case "room.end":
        snapshot.lifecycle = "ended";
        emit("room.ended", {});
        break;
      case "room.invite.rotate": {
        const inviteEpoch = Number(command.payload.inviteEpoch);
        if (!Number.isSafeInteger(inviteEpoch) || inviteEpoch !== snapshot.inviteEpoch + 1) throw new Error("inviteEpoch is invalid");
        snapshot.inviteEpoch = inviteEpoch;
        emit("room.invite_rotated", { inviteEpoch });
        break;
      }
      case "legacy.import":
        emit("legacy.imported", {
          legacyRoomId: requiredText(command.payload, "legacyRoomId", 32),
          exportHash: requiredText(command.payload, "exportHash", 128),
          eventCount: Number.isSafeInteger(command.payload.eventCount) ? Number(command.payload.eventCount) : 0,
        });
        break;
      default:
        throw new Error("Command action is not supported");
    }

    const events: RoomEvent[] = pending.map((item, index) => ({
      eventId: newStableId("evt"), seq: metadata.sequence + index + 1, commandId: command.commandId,
      type: item.type, actor, payload: item.payload, createdAtMs: now,
    }));
    snapshot.seq = events.at(-1)?.seq ?? metadata.sequence;
    snapshot.updatedAtMs = now;
    for (const event of events) {
      this.ctx.storage.sql.exec(
        "INSERT INTO events (seq, event_id, command_id, event_type, actor_id, payload_json, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
        event.seq, event.eventId, event.commandId, event.type, actor.participantId, JSON.stringify(event.payload), event.createdAtMs,
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO outbox (outbox_id, event_id, payload_json, created_at_ms) VALUES (?, ?, ?, ?)",
        newStableId("out"), event.eventId, JSON.stringify({ event, snapshot }), now,
      );
    }
    const minRetained = Math.max(0, snapshot.seq - ROOM_EVENT_RETENTION);
    this.ctx.storage.sql.exec("DELETE FROM events WHERE seq <= ?", minRetained);
    this.ctx.storage.sql.exec("UPDATE metadata SET sequence = ?, min_retained_seq = ?, snapshot_json = ?, updated_at_ms = ?", snapshot.seq, minRetained, JSON.stringify(snapshot), now);
    const ack: RoomCommandAck = { type: "ack", commandId: command.commandId, seq: snapshot.seq, duplicate: false, events };
    this.ctx.storage.sql.exec(
      "INSERT INTO command_results (command_id, actor_id, intent_json, result_json, created_at_ms) VALUES (?, ?, ?, ?, ?)",
      command.commandId, actor.participantId, intent, JSON.stringify(ack), now,
    );
    if (snapshot.lifecycle === "ended") this.ctx.waitUntil(this.ctx.storage.setAlarm(now + 30 * 24 * 60 * 60_000));
    return ack;
  }

  private consumeCommandRateLimit(actor: RoomActor, action: string): boolean {
    const now = Date.now();
    const bucketStart = Math.floor(now / 60_000) * 60_000;
    const policies = [
      ...(actor.role === "guest" || actor.role === "viewer" ? [{ scope: "room:untrusted", limit: 180 }] : []),
      { scope: `participant:${actor.participantId}:all`, limit: actor.role === "host" ? 120 : 60 },
      { scope: `participant:${actor.participantId}:action:${action}`, limit: roomActionRateLimit(action) },
    ];
    return this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM rate_buckets WHERE expires_at_ms <= ?", now);
      for (const policy of policies) {
        this.ctx.storage.sql.exec(
          `INSERT INTO rate_buckets (scope, bucket_start_ms, request_count, expires_at_ms) VALUES (?, ?, 1, ?)
           ON CONFLICT(scope, bucket_start_ms) DO UPDATE SET request_count = request_count + 1`,
          policy.scope, bucketStart, bucketStart + 120_000,
        );
        const row = this.ctx.storage.sql.exec<{ request_count: number }>(
          "SELECT request_count FROM rate_buckets WHERE scope = ? AND bucket_start_ms = ?",
          policy.scope, bucketStart,
        ).toArray()[0];
        if ((row?.request_count ?? 0) > policy.limit) return true;
      }
      return false;
    });
  }

  private approveSuggestion(
    snapshot: RoomSnapshot,
    suggestion: Suggestion,
    actor: RoomActor,
    now: number,
    emit: (type: string, payload: Record<string, unknown>) => void,
  ): void {
    const existing = snapshot.occurrences.find((item) => item.recordingId === suggestion.recordingId && ["now", "staged", "held"].includes(item.status));
    suggestion.status = "approved";
    if (existing) {
      const cosigners = new Set(existing.cosignerIds);
      cosigners.add(suggestion.submittedBy);
      existing.cosignerIds = [...cosigners].sort();
      suggestion.occurrenceId = existing.occurrenceId;
      this.ctx.storage.sql.exec("INSERT OR IGNORE INTO cosignatures (occurrence_id, participant_id, created_at_ms) VALUES (?, ?, ?)", existing.occurrenceId, suggestion.submittedBy, now);
      emit("suggestion.cosigned", { suggestionId: suggestion.suggestionId, occurrenceId: existing.occurrenceId, recordingId: suggestion.recordingId });
    } else {
      const occurrenceId = newStableId("occ");
      const activeCount = snapshot.occurrences.filter((item) => ["now", "staged"].includes(item.status)).length;
      const occurrence: Occurrence = {
        occurrenceId, recordingId: suggestion.recordingId, suggestionId: suggestion.suggestionId, title: suggestion.title,
        ...(suggestion.display ? { display: suggestion.display } : {}),
        status: activeCount === 0 ? "now" : "staged", position: activeCount, cosignerIds: [suggestion.submittedBy], voterIds: [],
      };
      suggestion.occurrenceId = occurrenceId;
      snapshot.occurrences.push(occurrence);
      this.ctx.storage.sql.exec(
        "INSERT INTO occurrences (occurrence_id, recording_id, suggestion_id, status, position, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
        occurrenceId, suggestion.recordingId, suggestion.suggestionId, occurrence.status, occurrence.position, now, now,
      );
      this.ctx.storage.sql.exec("INSERT INTO cosignatures (occurrence_id, participant_id, created_at_ms) VALUES (?, ?, ?)", occurrenceId, suggestion.submittedBy, now);
      emit("suggestion.approved", { suggestionId: suggestion.suggestionId, occurrenceId, recordingId: suggestion.recordingId });
    }
    this.ctx.storage.sql.exec("UPDATE suggestions SET status = 'approved', occurrence_id = ?, updated_at_ms = ? WHERE suggestion_id = ?", suggestion.occurrenceId, now, suggestion.suggestionId);
    void actor;
  }

  private openWebSocket(attachment: SocketAttachment): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [`participant:${attachment.actor.participantId}`]);
    server.serializeAttachment(attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  private metadataRoomId(): string {
    return this.ctx.storage.sql.exec<{ room_id: string }>("SELECT room_id FROM metadata LIMIT 1").toArray()[0]?.room_id ?? "";
  }

  private async currentSocketActor(attachment: SocketAttachment): Promise<RoomActor | null> {
    if (!this.env.DB || attachment.expiresAtMs <= Date.now()) return null;
    const metadata = this.metadata();
    if (!metadata) return null;
    const snapshot = JSON.parse(metadata.snapshot_json) as RoomSnapshot;
    snapshot.inviteEpoch ??= 1;
    if (snapshot.lifecycle !== "active" || attachment.roomId !== snapshot.roomId) return null;

    if (attachment.sessionKind === "host") {
      const session = await this.env.DB.prepare(
        `SELECT s.expires_at_ms FROM host_sessions s
         JOIN accounts a ON a.account_id = s.account_id
         JOIN room_registry r ON r.owner_account_id = s.account_id AND r.room_id = ?
         WHERE s.session_id = ? AND s.revoked_at_ms IS NULL AND s.expires_at_ms > ?
           AND a.deleted_at_ms IS NULL AND r.lifecycle = 'active' LIMIT 1`,
      ).bind(snapshot.roomId, attachment.sessionId, Date.now()).first<{ expires_at_ms: number }>();
      return session ? { ...attachment.actor, role: "host" } : null;
    }

    const session = await this.env.DB.prepare(
      `SELECT participant_id, nickname, role, invite_epoch, expires_at_ms FROM guest_sessions
       WHERE session_id = ? AND room_id = ? AND revoked_at_ms IS NULL AND expires_at_ms > ? LIMIT 1`,
    ).bind(attachment.sessionId, snapshot.roomId, Date.now()).first<{
      participant_id: string; nickname: string; role: RoomActor["role"]; invite_epoch: number; expires_at_ms: number;
    }>();
    if (!session || session.participant_id !== attachment.actor.participantId ||
      session.invite_epoch !== snapshot.inviteEpoch || attachment.inviteEpoch !== snapshot.inviteEpoch) return null;
    const current = snapshot.participants[session.participant_id];
    if (!current) return null;
    return { participantId: current.participantId, nickname: current.nickname, role: current.role };
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    if (!attachment) return ws.close(1008, "Session missing");
    const actor = await this.currentSocketActor(attachment);
    if (!actor) return ws.close(1008, "Session expired or revoked");
    ws.serializeAttachment({ ...attachment, actor });
    const rawMessage = typeof message === "string" ? message : new TextDecoder().decode(message);
    if (rawMessage.length > 65_536) return ws.close(1009, "Message too large");
    let input: unknown;
    try { input = JSON.parse(rawMessage); }
    catch { return ws.send(JSON.stringify(protocolError("INVALID_MESSAGE", "Message must be JSON", this.latestSeq()))); }
    if ((input as { type?: unknown })?.type === "hello") {
      try {
        const hello = parseRoomHello(input);
        ws.serializeAttachment({ ...attachment, clientInstanceId: hello.clientInstanceId });
        ws.send(await this.stateResponse(new URL(`https://room/state?after=${hello.lastSeq}`)).text());
      } catch (error) {
        ws.send(JSON.stringify(protocolError("INVALID_HELLO", error instanceof Error ? error.message : "hello is invalid", this.latestSeq())));
      }
      return;
    }
    const candidate = input as { type?: unknown; command?: unknown };
    const command = candidate.type === "command" ? candidate.command ?? input : input;
    const result = this.processCommand(command, actor);
    ws.send(JSON.stringify(result));
    if (result.type === "ack") await this.afterCommit(result);
  }

  webSocketClose(): void {
    // Presence is derived from socket state and participant commands. No
    // additional in-memory cleanup is required for a hibernated close.
  }

  webSocketError(ws: WebSocket): void {
    try { ws.close(1011, "WebSocket transport failed"); } catch { /* already closed */ }
  }

  private async afterCommit(ack: RoomCommandAck): Promise<void> {
    const payload = JSON.stringify(ack);
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      const closeForEnd = ack.events.some((event) => event.type === "room.ended");
      const closeForRotation = attachment?.sessionKind === "guest" && ack.events.some((event) => event.type === "room.invite_rotated");
      const closeForParticipantChange = attachment && ack.events.some((event) =>
        (event.type === "participant.moderated" && event.payload.participantId === attachment.actor.participantId) ||
        (event.type === "participant.left" && event.actor.participantId === attachment.actor.participantId),
      );
      if (closeForEnd || closeForRotation || closeForParticipantChange) {
        try { socket.close(1008, "Room authority changed"); } catch { /* stale socket */ }
        continue;
      }
      try { socket.send(payload); } catch { /* stale hibernated socket */ }
    }
    if (!this.env.ROOM_PROJECTION_QUEUE) return;
    const rows = [...this.ctx.storage.sql.exec<{ outbox_id: string; payload_json: string }>(
      "SELECT outbox_id, payload_json FROM outbox WHERE delivered_at_ms IS NULL ORDER BY created_at_ms LIMIT 100",
    )];
    for (const row of rows) {
      await this.env.ROOM_PROJECTION_QUEUE.send(JSON.parse(row.payload_json));
      this.ctx.storage.sql.exec("UPDATE outbox SET delivered_at_ms = ? WHERE outbox_id = ?", Date.now(), row.outbox_id);
    }
  }

  private errorStatus(code: string): number {
    if (code === "UNAUTHORIZED") return 401;
    if (code === "FORBIDDEN") return 403;
    if (code === "RATE_LIMITED") return 429;
    if (code === "ROOM_LOCKED") return 423;
    if (code === "ROOM_FULL") return 409;
    if (["COMMAND_ID_CONFLICT", "STALE_SEQUENCE", "COMMAND_REJECTED", "CONTROL_ENDPOINT_REQUIRED"].includes(code)) return 409;
    return 400;
  }

  alarm(): void {
    const metadata = this.metadata();
    if (!metadata) return;
    const snapshot = JSON.parse(metadata.snapshot_json) as RoomSnapshot;
    snapshot.inviteEpoch ??= 1;
    if (snapshot.lifecycle !== "ended") return;
    snapshot.participants = {};
    snapshot.suggestions = Object.fromEntries(Object.entries(snapshot.suggestions).map(([id, suggestion]) => [id, { ...suggestion, submittedBy: "deleted" }]));
    snapshot.occurrences = snapshot.occurrences.map((occurrence) => ({ ...occurrence, cosignerIds: [], voterIds: [] }));
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM participants; DELETE FROM command_results; DELETE FROM events; DELETE FROM votes; DELETE FROM cosignatures; DELETE FROM rate_buckets; DELETE FROM outbox;");
      this.ctx.storage.sql.exec("UPDATE metadata SET snapshot_json = ?, min_retained_seq = sequence, updated_at_ms = ?", JSON.stringify(snapshot), Date.now());
    });
  }
}
