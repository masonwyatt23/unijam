export type JoinedRoom = {
  roomId: string;
  nickname: string;
  lifecycle: string;
  joinedAtMs: number;
  lastJoinedAtMs: number;
  endedAtMs: number | null;
};

type JoinedRoomRow = {
  room_id: string;
  nickname: string;
  lifecycle: string;
  joined_at_ms: number;
  last_joined_at_ms: number;
  ended_at_ms: number | null;
};

export async function listJoinedRooms(db: D1Database, accountId: string, limit = 50): Promise<JoinedRoom[]> {
  const boundedLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
  const result = await db.prepare(
    `SELECT m.room_id, m.nickname, r.lifecycle, m.joined_at_ms, m.last_joined_at_ms, r.ended_at_ms
     FROM room_memberships m
     JOIN room_registry r ON r.room_id = m.room_id
     WHERE m.account_id = ?
     ORDER BY m.last_joined_at_ms DESC, m.room_id ASC
     LIMIT ?`,
  ).bind(accountId, boundedLimit).all<JoinedRoomRow>();
  return (result.results ?? []).map((room) => ({
    roomId: room.room_id,
    nickname: room.nickname,
    lifecycle: room.lifecycle,
    joinedAtMs: room.joined_at_ms,
    lastJoinedAtMs: room.last_joined_at_ms,
    endedAtMs: room.ended_at_ms,
  }));
}

/**
 * These statements remove both an account's own participation and all
 * participation history in rooms that disappear with that account.
 */
export function accountParticipationDeletionStatements(db: D1Database, accountId: string): D1PreparedStatement[] {
  return [
    db.prepare(
      `DELETE FROM room_memberships
       WHERE account_id = ? OR room_id IN (SELECT room_id FROM room_registry WHERE owner_account_id = ?)`,
    ).bind(accountId, accountId),
    db.prepare(
      `DELETE FROM guest_sessions
       WHERE account_id = ? OR room_id IN (SELECT room_id FROM room_registry WHERE owner_account_id = ?)`,
    ).bind(accountId, accountId),
  ];
}
