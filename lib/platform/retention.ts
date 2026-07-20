export const ROOM_DETAIL_RETENTION_MS = 30 * 24 * 60 * 60_000;

export function expiredRoomProjectionDeletion(db: D1Database, retentionCutoffMs: number): D1PreparedStatement {
  return db.prepare(
    `DELETE FROM room_projections WHERE room_id IN (
       SELECT room_id FROM room_registry
       WHERE lifecycle = 'ended' AND ended_at_ms IS NOT NULL AND ended_at_ms < ?
     )`,
  ).bind(retentionCutoffMs);
}
