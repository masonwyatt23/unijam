import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { authenticateHost } from "../../lib/server/host-session.ts";
import {
  authenticateRoomActor,
  exchangeGuestCapability,
  type RoomAuthorityEnv,
} from "../../lib/server/room-authority.ts";
import {
  accountParticipationDeletionStatements,
  listJoinedRooms,
} from "../../lib/server/room-membership.ts";
import { revokeLinkedGuestSession } from "../../lib/server/logout-sessions.ts";
import { GUEST_SESSION_COOKIE, HOST_SESSION_COOKIE } from "../../lib/server/session-cookie.ts";
import { hashOpaqueToken } from "../../lib/server/secure-token.ts";

const roomId = "MEMBER01";
const capability = "member-test-capability";

function database(): D1Database {
  if (!env.DB) throw new Error("DB test binding is missing");
  return env.DB;
}

function runtime(): RoomAuthorityEnv {
  database();
  return env as RoomAuthorityEnv;
}

async function resetSchema(): Promise<D1Database> {
  const db = database();
  await db.exec(`DROP TABLE IF EXISTS room_memberships;
DROP TABLE IF EXISTS guest_sessions;
DROP TABLE IF EXISTS host_sessions;
DROP TABLE IF EXISTS room_registry;
DROP TABLE IF EXISTS accounts;
CREATE TABLE accounts (account_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, deleted_at_ms INTEGER, deletion_pending_at_ms INTEGER);
CREATE TABLE host_sessions (session_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, account_id TEXT NOT NULL, authenticated_at_ms INTEGER NOT NULL, passkey_verified_at_ms INTEGER, expires_at_ms INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, last_seen_at_ms INTEGER NOT NULL, revoked_at_ms INTEGER, recovery_enrollment_expires_at_ms INTEGER, recovery_enrollment_consumed_at_ms INTEGER);
CREATE TABLE room_registry (room_id TEXT PRIMARY KEY, owner_account_id TEXT NOT NULL, durable_object_id TEXT NOT NULL, guest_capability_hash TEXT NOT NULL, invite_epoch INTEGER NOT NULL, lifecycle TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, ended_at_ms INTEGER, deletion_purged_at_ms INTEGER);
CREATE TABLE guest_sessions (session_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, room_id TEXT NOT NULL, participant_id TEXT NOT NULL, account_id TEXT, nickname TEXT NOT NULL, role TEXT NOT NULL, invite_epoch INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, last_seen_at_ms INTEGER NOT NULL, revoked_at_ms INTEGER);
CREATE TABLE room_memberships (membership_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, room_id TEXT NOT NULL, participant_id TEXT NOT NULL, nickname TEXT NOT NULL CHECK (length(trim(nickname)) BETWEEN 1 AND 48), joined_at_ms INTEGER NOT NULL, last_joined_at_ms INTEGER NOT NULL CHECK (last_joined_at_ms >= joined_at_ms));
CREATE UNIQUE INDEX room_memberships_account_room_idx ON room_memberships (account_id, room_id);
CREATE UNIQUE INDEX room_memberships_room_participant_idx ON room_memberships (room_id, participant_id);`);
  const now = Date.now();
  await db.batch([
    db.prepare(
      "INSERT INTO accounts (account_id, display_name, created_at_ms, updated_at_ms) VALUES ('owner', 'Owner', ?, ?)",
    ).bind(now, now),
    db.prepare(
      `INSERT INTO room_registry
       (room_id, owner_account_id, durable_object_id, guest_capability_hash, invite_epoch, lifecycle, created_at_ms, updated_at_ms)
       VALUES (?, 'owner', 'durable-member-01', ?, 1, 'active', ?, ?)`,
    ).bind(roomId, await hashOpaqueToken(capability), now, now),
  ]);
  return db;
}

async function addAccountSession(db: D1Database, accountId = "member"): Promise<Request> {
  const now = Date.now();
  const token = `host-token-${accountId}`;
  await db.batch([
    db.prepare("INSERT INTO accounts (account_id, display_name, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?)")
      .bind(accountId, "Signed-in member", now, now),
    db.prepare(
      `INSERT INTO host_sessions
       (session_id, token_hash, account_id, authenticated_at_ms, passkey_verified_at_ms, expires_at_ms, created_at_ms, last_seen_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(`session-${accountId}`, await hashOpaqueToken(token), accountId, now, now, now + 60_000, now, now),
  ]);
  return new Request(`https://staging.unijam.ashlr.ai/join/${roomId}`, {
    headers: { Cookie: `${HOST_SESSION_COOKIE}=${token}` },
  });
}

function cookieRequest(cookie: string): Request {
  return new Request(`https://staging.unijam.ashlr.ai/room/${roomId}`, {
    headers: { Cookie: cookie.split(";", 1)[0] ?? `${GUEST_SESSION_COOKIE}=` },
  });
}

describe.sequential("account-linked room participation", () => {
  beforeEach(async () => { await resetSchema(); });

  it("links a signed-in member only after a valid invite exchange", async () => {
    const db = database();
    const accountRequest = await addAccountSession(db);
    const account = await authenticateHost(db, accountRequest);
    expect(account?.account_id).toBe("member");

    const session = await exchangeGuestCapability(runtime(), roomId, capability, "  Mia  ", account!.account_id);
    expect(session.actor).toMatchObject({ role: "guest", nickname: "Mia" });
    expect(session.actor.participantId).toMatch(/^p_/);
    expect(session.actor.participantId).not.toBe(account!.account_id);

    const guest = await authenticateRoomActor(runtime(), cookieRequest(session.cookie), roomId);
    expect(guest?.session.accountId).toBe("member");
    expect(guest?.actor.participantId).toBe(session.actor.participantId);
    const joinedRooms = await listJoinedRooms(db, "member");
    expect(joinedRooms).toEqual([expect.objectContaining({
      roomId,
      nickname: "Mia",
      lifecycle: "active",
    })]);
    expect(Object.keys(joinedRooms[0]!).sort()).toEqual([
      "endedAtMs", "joinedAtMs", "lastJoinedAtMs", "lifecycle", "nickname", "roomId",
    ]);

  });

  it("keeps an unauthenticated guest account-free", async () => {
    const db = database();
    const session = await exchangeGuestCapability(runtime(), roomId, capability, "Guest");
    const row = await db.prepare("SELECT account_id FROM guest_sessions WHERE session_id = ?")
      .bind(session.sessionId).first<{ account_id: string | null }>();
    expect(row?.account_id).toBeNull();
    expect((await db.prepare("SELECT COUNT(*) AS total FROM room_memberships").first<{ total: number }>())?.total).toBe(0);
    expect((await authenticateRoomActor(runtime(), cookieRequest(session.cookie), roomId))?.session.accountId).toBeNull();
  });

  it("links the exact guest session when its participant signs in after joining", async () => {
    const db = database();
    const session = await exchangeGuestCapability(runtime(), roomId, capability, "Later member");
    await addAccountSession(db);
    const guestCookie = session.cookie.split(";", 1)[0];
    const request = new Request(`https://staging.unijam.ashlr.ai/room/${roomId}`, {
      headers: { Cookie: `${guestCookie}; ${HOST_SESSION_COOKIE}=host-token-member` },
    });

    const linked = await authenticateRoomActor(runtime(), request, roomId);
    expect(linked?.actor).toMatchObject({ participantId: session.actor.participantId, role: "guest" });
    expect(linked?.session.accountId).toBe("member");
    expect(await listJoinedRooms(db, "member")).toEqual([
      expect.objectContaining({ roomId, nickname: "Later member" }),
    ]);
  });

  it("never rebinds a guest session that already belongs to another account", async () => {
    const db = database();
    const session = await exchangeGuestCapability(runtime(), roomId, capability, "Original member", "member");
    await addAccountSession(db, "other-member");
    const guestCookie = session.cookie.split(";", 1)[0];
    const request = new Request(`https://staging.unijam.ashlr.ai/room/${roomId}`, {
      headers: { Cookie: `${guestCookie}; ${HOST_SESSION_COOKIE}=host-token-other-member` },
    });

    const authenticated = await authenticateRoomActor(runtime(), request, roomId);
    expect(authenticated?.session.accountId).toBe("member");
    expect(await listJoinedRooms(db, "other-member")).toEqual([]);
  });

  it("logout revokes only the current account-linked room session", async () => {
    const db = database();
    const session = await exchangeGuestCapability(runtime(), roomId, capability, "Member", "member");
    const guestCookie = session.cookie.split(";", 1)[0];
    const request = new Request(`https://staging.unijam.ashlr.ai/room/${roomId}`, {
      headers: { Cookie: guestCookie },
    });

    await revokeLinkedGuestSession(db, request, "other-member", 2_000);
    expect((await db.prepare("SELECT revoked_at_ms FROM guest_sessions WHERE session_id = ?")
      .bind(session.sessionId).first<{ revoked_at_ms: number | null }>())?.revoked_at_ms).toBeNull();

    await revokeLinkedGuestSession(db, request, "member", 3_000);
    expect((await db.prepare("SELECT revoked_at_ms FROM guest_sessions WHERE session_id = ?")
      .bind(session.sessionId).first<{ revoked_at_ms: number | null }>())?.revoked_at_ms).toBe(3_000);
    expect(await authenticateRoomActor(runtime(), request, roomId)).toBeNull();
  });

  it("never lets account authentication bypass the invite", async () => {
    const db = database();
    const account = await authenticateHost(db, await addAccountSession(db));
    await expect(exchangeGuestCapability(
      runtime(),
      roomId,
      "wrong-capability",
      "Member",
      account!.account_id,
    )).rejects.toMatchObject({ code: "INVITE_INVALID_OR_ROTATED", status: 401 });
    expect((await db.prepare("SELECT COUNT(*) AS total FROM guest_sessions").first<{ total: number }>())?.total).toBe(0);
    expect((await db.prepare("SELECT COUNT(*) AS total FROM room_memberships").first<{ total: number }>())?.total).toBe(0);
  });

  it("upserts one membership when the same account joins concurrently", async () => {
    const db = database();
    await addAccountSession(db);
    const [first, second] = await Promise.all([
      exchangeGuestCapability(runtime(), roomId, capability, "First", "member"),
      exchangeGuestCapability(runtime(), roomId, capability, "Second", "member"),
    ]);
    const memberships = await db.prepare(
      "SELECT participant_id, nickname, joined_at_ms, last_joined_at_ms FROM room_memberships WHERE account_id = ? AND room_id = ?",
    ).bind("member", roomId).all<{ participant_id: string; nickname: string; joined_at_ms: number; last_joined_at_ms: number }>();
    expect(memberships.results).toHaveLength(1);
    expect([first.actor.participantId, second.actor.participantId]).toContain(memberships.results[0]?.participant_id);
    expect(memberships.results[0]!.last_joined_at_ms).toBeGreaterThanOrEqual(memberships.results[0]!.joined_at_ms);
  });

  it("deletes an account's participation and all history for its owned rooms", async () => {
    const db = database();
    const now = Date.now();
    await db.batch([
      db.prepare("INSERT INTO accounts (account_id, display_name, created_at_ms, updated_at_ms) VALUES ('delete-me', 'Delete', ?, ?)").bind(now, now),
      db.prepare("INSERT INTO accounts (account_id, display_name, created_at_ms, updated_at_ms) VALUES ('other', 'Other', ?, ?)").bind(now, now),
      db.prepare("INSERT INTO room_registry (room_id, owner_account_id, durable_object_id, guest_capability_hash, invite_epoch, lifecycle, created_at_ms, updated_at_ms) VALUES ('OWNED001', 'delete-me', 'do-owned', 'hash', 1, 'active', ?, ?)").bind(now, now),
      db.prepare("INSERT INTO room_registry (room_id, owner_account_id, durable_object_id, guest_capability_hash, invite_epoch, lifecycle, created_at_ms, updated_at_ms) VALUES ('OTHER001', 'other', 'do-other', 'hash', 1, 'active', ?, ?)").bind(now, now),
      db.prepare("INSERT INTO guest_sessions (session_id, token_hash, room_id, participant_id, account_id, nickname, role, invite_epoch, expires_at_ms, created_at_ms, last_seen_at_ms) VALUES ('gs-member', 't1', 'OTHER001', 'p_member', 'delete-me', 'Member', 'guest', 1, ?, ?, ?)").bind(now + 60_000, now, now),
      db.prepare("INSERT INTO guest_sessions (session_id, token_hash, room_id, participant_id, account_id, nickname, role, invite_epoch, expires_at_ms, created_at_ms, last_seen_at_ms) VALUES ('gs-owned', 't2', 'OWNED001', 'p_other-owned', 'other', 'Other', 'guest', 1, ?, ?, ?)").bind(now + 60_000, now, now),
      db.prepare("INSERT INTO guest_sessions (session_id, token_hash, room_id, participant_id, account_id, nickname, role, invite_epoch, expires_at_ms, created_at_ms, last_seen_at_ms) VALUES ('gs-keep', 't3', 'OTHER001', 'p_keep', 'other', 'Keep', 'guest', 1, ?, ?, ?)").bind(now + 60_000, now, now),
      db.prepare("INSERT INTO room_memberships VALUES ('m-member', 'delete-me', 'OTHER001', 'p_member', 'Member', ?, ?)").bind(now, now),
      db.prepare("INSERT INTO room_memberships VALUES ('m-owned', 'other', 'OWNED001', 'p_other-owned', 'Other', ?, ?)").bind(now, now),
      db.prepare("INSERT INTO room_memberships VALUES ('m-keep', 'other', 'OTHER001', 'p_keep', 'Keep', ?, ?)").bind(now, now),
    ]);

    await db.batch(accountParticipationDeletionStatements(db, "delete-me"));
    expect((await db.prepare("SELECT session_id FROM guest_sessions ORDER BY session_id").all()).results).toEqual([{ session_id: "gs-keep" }]);
    expect((await db.prepare("SELECT membership_id FROM room_memberships ORDER BY membership_id").all()).results).toEqual([{ membership_id: "m-keep" }]);
  });
});
