import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { legacyExportHash } from "../../lib/server/legacy-migration.ts";
import { expiredRoomProjectionDeletion, ROOM_DETAIL_RETENTION_MS } from "../../lib/platform/retention.ts";

type Actor = { participantId: string; role: "host" | "cohost" | "guest"; nickname: string };
type ProtocolResult =
  | { type: "ack"; commandId: string; seq: number; duplicate: boolean; events: Array<{ type: string; payload: Record<string, unknown> }> }
  | { type: "error"; commandId?: string; code: string; latestSeq: number };

const host: Actor = { participantId: "participant_host_01", role: "host", nickname: "Host" };
const guest: Actor = { participantId: "participant_guest_01", role: "guest", nickname: "Guest" };
const otherGuest: Actor = { participantId: "participant_guest_02", role: "guest", nickname: "Other guest" };

function roomNamespace(): DurableObjectNamespace {
  if (!env.ROOM_OBJECTS) throw new Error("ROOM_OBJECTS test binding is missing");
  return env.ROOM_OBJECTS;
}

function actorHeaders(actor: Actor, control = false): Headers {
  return new Headers({
    "Content-Type": "application/json",
    "X-UniJam-Participant-Id": actor.participantId,
    "X-UniJam-Role": actor.role,
    "X-UniJam-Nickname": actor.nickname,
    ...(control ? { "X-UniJam-Control-Action": "true" } : {}),
  });
}

async function openRoomSocket(
  stub: DurableObjectStub,
  actor: Actor,
  sessionKind: "host" | "guest" = "guest",
  sessionId = crypto.randomUUID(),
): Promise<WebSocket> {
  const headers = actorHeaders(actor);
  headers.set("Upgrade", "websocket");
  headers.set("X-UniJam-Session-Kind", sessionKind);
  headers.set("X-UniJam-Session-Id", sessionId);
  headers.set("X-UniJam-Session-Expires-At", String(Date.now() + 60_000));
  headers.set("X-UniJam-Invite-Epoch", "1");
  const response = await stub.fetch("https://room/websocket", { headers });
  expect(response.status).toBe(101);
  expect(response.webSocket).toBeDefined();
  const socket = response.webSocket!;
  socket.accept();
  return socket;
}

function nextSocketMessage(socket: WebSocket): Promise<MessageEvent> {
  return new Promise((resolve) => socket.addEventListener("message", resolve, { once: true }));
}

async function ensureSocketSessionSchema(): Promise<D1Database> {
  if (!env.DB) throw new Error("DB test binding is missing");
  await env.DB.exec(`
    CREATE TABLE IF NOT EXISTS accounts (account_id TEXT PRIMARY KEY, deleted_at_ms INTEGER);
    CREATE TABLE IF NOT EXISTS host_sessions (session_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, expires_at_ms INTEGER NOT NULL, revoked_at_ms INTEGER);
    CREATE TABLE IF NOT EXISTS guest_sessions (session_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, participant_id TEXT NOT NULL, nickname TEXT NOT NULL, role TEXT NOT NULL, invite_epoch INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL, revoked_at_ms INTEGER);
    CREATE TABLE IF NOT EXISTS room_registry (room_id TEXT PRIMARY KEY, owner_account_id TEXT, lifecycle TEXT NOT NULL, ended_at_ms INTEGER);
  `);
  return env.DB;
}

async function newRoom(name: string) {
  const namespace = roomNamespace();
  const stub = namespace.get(namespace.idFromName(name));
  const response = await stub.fetch("https://room/internal/initialize", {
    method: "POST",
    headers: new Headers({ ...Object.fromEntries(actorHeaders(host)), "X-UniJam-Room-Id": "ROOMTEST01" }),
  });
  expect(response.status).toBe(201);
  return stub;
}

async function command(
  stub: DurableObjectStub,
  actor: Actor,
  commandId: string,
  action: string,
  payload: Record<string, unknown>,
): Promise<ProtocolResult> {
  const response = await stub.fetch("https://room/commands", {
    method: "POST",
    headers: actorHeaders(actor),
    body: JSON.stringify({ commandId, action, payload }),
  });
  return response.json<ProtocolResult>();
}

async function snapshot(stub: DurableObjectStub) {
  const response = await stub.fetch("https://room/state");
  const body = await response.json<{ snapshot: { seq: number; suggestions: Record<string, unknown>; occurrences: Array<{ occurrenceId: string; recordingId: string; status: string; cosignerIds: string[]; voterIds: string[]; playbackConfirmedAtMs?: number }> } }>();
  return body.snapshot;
}

describe("RoomDurableObject serialized authority", () => {
  it("co-signs simultaneous approvals for one recording without creating duplicate occurrences", async () => {
    const stub = await newRoom("simultaneous-approval");
    await Promise.all([
      command(stub, guest, "command_stage_guest_01", "suggestion.stage", { suggestionId: "sug_guest_track_01", recordingId: "rec_shared_track_01", title: "Shared track" }),
      command(stub, otherGuest, "command_stage_guest_02", "suggestion.stage", { suggestionId: "sug_guest_track_02", recordingId: "rec_shared_track_01", title: "Shared track" }),
    ]);

    const results = await Promise.all([
      command(stub, host, "command_approve_track_01", "suggestion.approve", { suggestionId: "sug_guest_track_01" }),
      command(stub, host, "command_approve_track_02", "suggestion.approve", { suggestionId: "sug_guest_track_02" }),
    ]);
    expect(results.every((result) => result.type === "ack")).toBe(true);

    const state = await snapshot(stub);
    expect(state.occurrences).toHaveLength(1);
    expect(state.occurrences[0].recordingId).toBe("rec_shared_track_01");
    expect(state.occurrences[0].cosignerIds).toEqual([guest.participantId, otherGuest.participantId].sort());

    await runInDurableObject(stub, (_instance, durableState) => {
      const rows = durableState.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM occurrences").toArray();
      expect(rows[0]?.count).toBe(1);
    });
  });

  it("returns the original result for an identical retry and rejects changed intent", async () => {
    const stub = await newRoom("command-idempotency");
    const payload = { suggestionId: "sug_idempotency_01", recordingId: "rec_idempotency_01", title: "Retry-safe" };
    const first = await command(stub, guest, "command_idempotent_01", "suggestion.stage", payload);
    const retry = await command(stub, guest, "command_idempotent_01", "suggestion.stage", payload);
    const conflict = await command(stub, guest, "command_idempotent_01", "suggestion.stage", { ...payload, title: "Changed" });

    expect(first.type).toBe("ack");
    expect(retry).toMatchObject({ type: "ack", duplicate: true, seq: first.type === "ack" ? first.seq : -1 });
    expect(conflict).toMatchObject({ type: "error", code: "COMMAND_ID_CONFLICT" });
    expect((await snapshot(stub)).seq).toBe(first.type === "ack" ? first.seq : -1);
  });

  it("accepts only one concurrent duplicate vote and only one concurrent advancement", async () => {
    const stub = await newRoom("duplicate-mutations");
    for (const [suffix, recording] of [["01", "rec_queue_track_01"], ["02", "rec_queue_track_02"]] as const) {
      await command(stub, guest, `command_stage_queue_${suffix}`, "suggestion.stage", { suggestionId: `sug_queue_track_${suffix}`, recordingId: recording, title: `Track ${suffix}` });
      await command(stub, host, `command_approve_queue_${suffix}`, "suggestion.approve", { suggestionId: `sug_queue_track_${suffix}` });
    }
    const initial = await snapshot(stub);
    const now = initial.occurrences.find((item) => item.status === "now");
    expect(now).toBeDefined();

    const votes = await Promise.all([
      command(stub, guest, "command_vote_duplicate_01", "queue.vote", { occurrenceId: now!.occurrenceId, vote: true }),
      command(stub, guest, "command_vote_duplicate_02", "queue.vote", { occurrenceId: now!.occurrenceId, vote: true }),
    ]);
    expect(votes.filter((result) => result.type === "ack")).toHaveLength(1);
    expect(votes.filter((result) => result.type === "error")).toHaveLength(1);

    expect(await command(stub, host, "command_advance_unconfirmed_01", "queue.advance", { occurrenceId: now!.occurrenceId }))
      .toMatchObject({ type: "error", code: "COMMAND_REJECTED" });

    expect(await command(stub, host, "command_confirm_before_advance_01", "playback.confirm", { occurrenceId: now!.occurrenceId }))
      .toMatchObject({ type: "ack" });

    const advances = await Promise.all([
      command(stub, host, "command_advance_duplicate_01", "queue.advance", { occurrenceId: now!.occurrenceId }),
      command(stub, host, "command_advance_duplicate_02", "queue.advance", { occurrenceId: now!.occurrenceId }),
    ]);
    expect(advances.filter((result) => result.type === "ack")).toHaveLength(1);
    expect(advances.filter((result) => result.type === "error")).toHaveLength(1);

    const state = await snapshot(stub);
    expect(state.occurrences.filter((item) => item.status === "played")).toHaveLength(1);
    expect(state.occurrences.filter((item) => item.status === "now")).toHaveLength(1);
    expect(state.occurrences.find((item) => item.occurrenceId === now!.occurrenceId)?.voterIds).toEqual([guest.participantId]);
  });

  it("preserves SQLite state through a forced Durable Object restart", async () => {
    const roomName = "eviction-persistence";
    const stub = await newRoom(roomName);
    const accepted = await command(stub, guest, "command_before_evict_01", "suggestion.stage", {
      suggestionId: "sug_before_evict_01", recordingId: "rec_before_evict_01", title: "Persistent track",
    });
    expect(accepted.type).toBe("ack");

    await abortAllDurableObjects();
    const namespace = roomNamespace();
    const restartedStub = namespace.get(namespace.idFromName(roomName));
    const state = await snapshot(restartedStub);
    expect(state.suggestions).toHaveProperty("sug_before_evict_01");
    expect(state.seq).toBe(accepted.type === "ack" ? accepted.seq : -1);
  });

  it("records requested, opened, and host-confirmed handoffs without inferring playback", async () => {
    const stub = await newRoom("handoff-observations");
    await command(stub, guest, "command_stage_handoff_01", "suggestion.stage", {
      suggestionId: "sug_handoff_track_01", recordingId: "rec_handoff_track_01", title: "Handoff track",
    });
    await command(stub, host, "command_approve_handoff_01", "suggestion.approve", { suggestionId: "sug_handoff_track_01" });
    const occurrence = (await snapshot(stub)).occurrences.find((item) => item.status === "now");
    expect(occurrence).toBeDefined();

    const requested = await command(stub, guest, "command_handoff_request_01", "handoff.request", { occurrenceId: occurrence!.occurrenceId, provider: "spotify" });
    const opened = await command(stub, guest, "command_handoff_open_01", "handoff.open", { occurrenceId: occurrence!.occurrenceId, provider: "spotify" });
    const forbiddenConfirm = await command(stub, guest, "command_handoff_confirm_guest_01", "handoff.confirm", { occurrenceId: occurrence!.occurrenceId, provider: "spotify" });
    const confirmed = await command(stub, host, "command_handoff_confirm_host_01", "handoff.confirm", { occurrenceId: occurrence!.occurrenceId, provider: "spotify" });

    expect(requested).toMatchObject({ type: "ack", events: [{ type: "handoff.requested" }] });
    expect(opened).toMatchObject({ type: "ack", events: [{ type: "handoff.opened" }] });
    expect(forbiddenConfirm).toMatchObject({ type: "error", code: "FORBIDDEN" });
    expect(confirmed).toMatchObject({ type: "ack", events: [{ type: "handoff.host_confirmed" }] });
    expect((await snapshot(stub)).occurrences[0].playbackConfirmedAtMs).toBeUndefined();
  });

  it("imports the complete verified legacy export into room-local SQLite", async () => {
    const stub = await newRoom("complete-legacy-import");
    const exportValue = {
      version: 1,
      roomId: "LEGACYROOM01",
      snapshot: {
        rules: { contributionLimit: 4 },
        suggestions: {
          "old-suggestion-1": { id: "old-suggestion-1", title: "Legacy recording", submittedBy: "legacy-person", clientId: "legacy-client", service: "spotify", status: "approved" },
          "old-suggestion-2": { id: "old-suggestion-2", title: "Second legacy recording", submittedBy: "legacy-person", clientId: "legacy-client", service: "apple", status: "approved" },
          "old-suggestion-3": { id: "old-suggestion-3", title: "Needs host review", submittedBy: "legacy-person", clientId: "legacy-client", service: "ask", status: "pending" },
        },
        nowTrackIndex: 1,
        participants: { "legacy-client": { clientId: "legacy-client", name: "Legacy person", role: "guest" } },
        votes: { "0": ["legacy-client"] },
      },
      settings: { guestCanContribute: true, locked: false, hostApproval: true },
      events: [{ seq: 1, type: "legacy.created", payload: { preserved: true } }],
      history: [{ eventId: "history-event", note: "preserve me" }],
      additionalFutureField: { remainsLossless: true },
    };
    const exportHash = await legacyExportHash(exportValue);
    const response = await stub.fetch("https://room/internal/legacy-import", {
      method: "POST",
      headers: actorHeaders(host, true),
      body: JSON.stringify({ exportHash, export: exportValue }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ imported: true, duplicate: false, exportHash });

    await runInDurableObject(stub, (_instance, durableState) => {
      const row = durableState.storage.sql.exec<{ export_json: string; snapshot_json: string; events_json: string; settings_json: string; history_json: string }>(
        "SELECT export_json, snapshot_json, events_json, settings_json, history_json FROM legacy_imports WHERE legacy_room_id = ?",
        exportValue.roomId,
      ).toArray()[0];
      expect(JSON.parse(row!.export_json)).toEqual(exportValue);
      expect(JSON.parse(row!.snapshot_json)).toEqual(exportValue.snapshot);
      expect(JSON.parse(row!.events_json)).toEqual(exportValue.events);
      expect(JSON.parse(row!.settings_json)).toEqual(exportValue.settings);
      expect(JSON.parse(row!.history_json)).toEqual(exportValue.history);
      const metadata = durableState.storage.sql.exec<{ snapshot_json: string }>("SELECT snapshot_json FROM metadata LIMIT 1").toArray()[0];
      const active = JSON.parse(metadata!.snapshot_json) as {
        rules: { contributionLimit: number };
        participants: Record<string, unknown>;
        occurrences: Array<{ occurrenceId: string; title: string; status: string; cosignerIds: string[]; voterIds: string[] }>;
      };
      expect(active.rules.contributionLimit).toBe(4);
      expect(active.participants).toEqual({});
      expect(active.occurrences).toHaveLength(2);
      expect(active.occurrences.map((occurrence) => occurrence.status)).toEqual(["played", "now"]);
      expect(active.occurrences).toEqual(expect.arrayContaining([
        expect.objectContaining({ title: "Legacy recording", cosignerIds: [], voterIds: [] }),
        expect.objectContaining({ title: "Second legacy recording", cosignerIds: [], voterIds: [] }),
      ]));
      expect(Object.values(JSON.parse(metadata!.snapshot_json).suggestions)).toHaveLength(3);
      expect(durableState.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM occurrences").toArray()[0]?.count).toBe(2);
    });
  });

  it("hydrates a pending-only alpha room into normalized SQLite and preserves its settings", async () => {
    const stub = await newRoom("pending-only-legacy-import");
    const exportValue = {
      version: 1,
      roomId: "LEGACYPENDING",
      snapshot: {
        sequence: 4,
        phase: "idle",
        speakerService: "spotify",
        nowTrackIndex: 0,
        startedAtMs: null,
        reactionCount: 0,
        participants: {},
        suggestions: {
          alpha_pending: { id: "alpha_pending", title: "Pending legacy recording", submittedBy: "Old guest", clientId: "old-client", service: "spotify", status: "pending" },
        },
        votes: {},
        activity: [],
      },
      settings: { guestCanContribute: false, locked: true, hostApproval: false },
      events: [],
    };
    const exportHash = await legacyExportHash(exportValue);
    const response = await stub.fetch("https://room/internal/legacy-import", {
      method: "POST",
      headers: actorHeaders(host, true),
      body: JSON.stringify({ exportHash, export: exportValue }),
    });
    expect(response.status).toBe(200);

    let suggestionId = "";
    await runInDurableObject(stub, (_instance, durableState) => {
      const metadata = durableState.storage.sql.exec<{ snapshot_json: string }>("SELECT snapshot_json FROM metadata LIMIT 1").toArray()[0];
      const active = JSON.parse(metadata!.snapshot_json) as {
        rules: { contributionLimit: number; approvalMode: string; locked: boolean };
        suggestions: Record<string, { status: string }>;
      };
      expect(active.rules).toMatchObject({ contributionLimit: 0, approvalMode: "open", locked: true });
      suggestionId = Object.keys(active.suggestions)[0];
      expect(Object.values(active.suggestions)[0]?.status).toBe("pending");
      expect(durableState.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM suggestions").toArray()[0]?.count).toBe(1);
    });

    expect(await command(stub, host, "command_approve_migrated_pending_01", "suggestion.approve", { suggestionId }))
      .toMatchObject({ type: "ack" });
    await runInDurableObject(stub, (_instance, durableState) => {
      expect(durableState.storage.sql.exec<{ status: string }>("SELECT status FROM suggestions WHERE suggestion_id = ?", suggestionId).toArray()[0]?.status).toBe("approved");
      expect(durableState.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM occurrences").toArray()[0]?.count).toBe(1);
    });
  });

  it("rejects locked-room joins and serializes the 25-participant pilot cap", async () => {
    const lockedStub = await newRoom("locked-room-join");
    expect(await command(lockedStub, host, "command_lock_room_01", "room.rules.update", { rules: { locked: true } }))
      .toMatchObject({ type: "ack" });
    expect(await command(lockedStub, guest, "command_join_locked_01", "participant.join", {}))
      .toMatchObject({ type: "error", code: "COMMAND_REJECTED" });

    const fullStub = await newRoom("participant-cap");
    const joins = await Promise.all(Array.from({ length: 26 }, (_, index) => command(
      fullStub,
      { participantId: `participant_cap_${String(index).padStart(2, "0")}`, role: "guest", nickname: `Guest ${index}` },
      `command_join_cap_${String(index).padStart(2, "0")}`,
      "participant.join",
      {},
    )));
    expect(joins.filter((result) => result.type === "ack")).toHaveLength(25);
    expect(joins.filter((result) => result.type === "error")).toHaveLength(1);
  });

  it("closes hibernating guest sockets when the invite authority rotates", async () => {
    const stub = await newRoom("socket-invite-rotation");
    expect(await command(stub, guest, "command_join_socket_01", "participant.join", {})).toMatchObject({ type: "ack" });
    const socket = await openRoomSocket(stub, guest);
    const closed = new Promise<CloseEvent>((resolve) => socket.addEventListener("close", (event) => resolve(event), { once: true }));

    const rotateResponse = await stub.fetch("https://room/commands", {
      method: "POST",
      headers: actorHeaders(host, true),
      body: JSON.stringify({ commandId: "command_rotate_invite_01", action: "room.invite.rotate", payload: { inviteEpoch: 2 } }),
    });
    expect(rotateResponse.status).toBe(200);
    const closeEvent = await closed;
    expect(closeEvent.code).toBe(1008);
    expect(await command(stub, host, "command_rotate_invite_stale_01", "room.invite.rotate", { inviteEpoch: 2 }))
      .toMatchObject({ type: "error", code: "CONTROL_ENDPOINT_REQUIRED" });
    const staleControl = await stub.fetch("https://room/commands", {
      method: "POST",
      headers: actorHeaders(host, true),
      body: JSON.stringify({ commandId: "command_rotate_invite_stale_control_01", action: "room.invite.rotate", payload: { inviteEpoch: 2 } }),
    });
    expect(await staleControl.json()).toMatchObject({ type: "error", code: "COMMAND_REJECTED" });
  });

  it("revalidates guest revocation in D1 before every WebSocket message", async () => {
    const stub = await newRoom("guest-websocket-revocation");
    await command(stub, guest, "command_join_socket_guest_01", "participant.join", {});
    const db = await ensureSocketSessionSchema();
    const sessionId = "guest-session-revocation-01";
    await db.prepare(
      "INSERT OR REPLACE INTO guest_sessions (session_id, room_id, participant_id, nickname, role, invite_epoch, expires_at_ms, revoked_at_ms) VALUES (?, ?, ?, ?, ?, 1, ?, NULL)",
    ).bind(sessionId, "ROOMTEST01", guest.participantId, guest.nickname, guest.role, Date.now() + 60_000).run();
    const socket = await openRoomSocket(stub, guest, "guest", sessionId);
    const firstMessage = nextSocketMessage(socket);
    socket.send(JSON.stringify({ type: "hello", protocol: 1, lastSeq: 0, clientInstanceId: "client_socket_guest_01" }));
    expect(JSON.parse(String((await firstMessage).data))).toHaveProperty("type");

    await db.prepare("UPDATE guest_sessions SET revoked_at_ms = ? WHERE session_id = ?").bind(Date.now(), sessionId).run();
    const closed = new Promise<CloseEvent>((resolve) => socket.addEventListener("close", resolve, { once: true }));
    socket.send(JSON.stringify({ type: "hello", protocol: 1, lastSeq: 0, clientInstanceId: "client_socket_guest_02" }));
    expect((await closed).code).toBe(1008);
  });

  it("revalidates host logout and room ownership before every WebSocket message", async () => {
    const stub = await newRoom("host-websocket-revocation");
    const db = await ensureSocketSessionSchema();
    const accountId = "account-host-socket-01";
    const sessionId = "host-session-revocation-01";
    await db.batch([
      db.prepare("INSERT OR REPLACE INTO accounts (account_id, deleted_at_ms) VALUES (?, NULL)").bind(accountId),
      db.prepare("INSERT OR REPLACE INTO host_sessions (session_id, account_id, expires_at_ms, revoked_at_ms) VALUES (?, ?, ?, NULL)").bind(sessionId, accountId, Date.now() + 60_000),
      db.prepare("INSERT OR REPLACE INTO room_registry (room_id, owner_account_id, lifecycle, ended_at_ms) VALUES (?, ?, 'active', NULL)").bind("ROOMTEST01", accountId),
    ]);
    const socket = await openRoomSocket(stub, host, "host", sessionId);
    const firstMessage = nextSocketMessage(socket);
    socket.send(JSON.stringify({ type: "hello", protocol: 1, lastSeq: 0, clientInstanceId: "client_socket_host_01" }));
    expect(JSON.parse(String((await firstMessage).data))).toHaveProperty("type");

    await db.prepare("UPDATE host_sessions SET revoked_at_ms = ? WHERE session_id = ?").bind(Date.now(), sessionId).run();
    const closed = new Promise<CloseEvent>((resolve) => socket.addEventListener("close", resolve, { once: true }));
    socket.send(JSON.stringify({ type: "hello", protocol: 1, lastSeq: 0, clientInstanceId: "client_socket_host_02" }));
    expect((await closed).code).toBe(1008);
  });

  it("sanitizes ended-room authority and removes its expired detailed projection", async () => {
    const stub = await newRoom("retention-sanitization");
    await command(stub, guest, "command_join_retention_01", "participant.join", {});
    await command(stub, guest, "command_stage_retention_01", "suggestion.stage", {
      suggestionId: "sug_retention_track_01", recordingId: "rec_retention_track_01", title: "Temporary detail",
    });
    const ended = await stub.fetch("https://room/commands", {
      method: "POST",
      headers: actorHeaders(host, true),
      body: JSON.stringify({ commandId: "command_end_retention_01", action: "room.end", payload: {} }),
    });
    expect(ended.status).toBe(200);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, (_instance, durableState) => {
      const row = durableState.storage.sql.exec<{ snapshot_json: string }>("SELECT snapshot_json FROM metadata LIMIT 1").toArray()[0];
      const retained = JSON.parse(row!.snapshot_json) as { participants: Record<string, unknown>; suggestions: Record<string, { submittedBy: string }> };
      expect(retained.participants).toEqual({});
      expect(retained.suggestions.sug_retention_track_01.submittedBy).toBe("deleted");
    });

    if (!env.DB) throw new Error("DB test binding is missing");
    await env.DB.exec(`
      CREATE TABLE IF NOT EXISTS room_registry (room_id TEXT PRIMARY KEY, lifecycle TEXT NOT NULL, ended_at_ms INTEGER);
      CREATE TABLE IF NOT EXISTS room_projections (room_id TEXT PRIMARY KEY, snapshot_json TEXT NOT NULL);
    `);
    const endedAt = Date.now() - ROOM_DETAIL_RETENTION_MS - 1;
    await env.DB.batch([
      env.DB.prepare("INSERT OR REPLACE INTO room_registry (room_id, lifecycle, ended_at_ms) VALUES (?, 'ended', ?)").bind("ROOMTEST01", endedAt),
      env.DB.prepare("INSERT OR REPLACE INTO room_projections (room_id, snapshot_json) VALUES (?, ?)").bind("ROOMTEST01", JSON.stringify({ nickname: "must be deleted" })),
      expiredRoomProjectionDeletion(env.DB, Date.now() - ROOM_DETAIL_RETENTION_MS),
    ]);
    expect(await env.DB.prepare("SELECT room_id FROM room_projections WHERE room_id = ?").bind("ROOMTEST01").first()).toBeNull();
  });
});
