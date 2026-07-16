import { GUEST_SESSION_COOKIE, readCookie } from "./session-cookie.ts";
import { hashOpaqueToken } from "./secure-token.ts";

/** Revoke only the room session linked to the account that is signing out. */
export async function revokeLinkedGuestSession(
  db: D1Database,
  request: Request,
  accountId: string,
  now = Date.now(),
): Promise<void> {
  const token = readCookie(request, GUEST_SESSION_COOKIE);
  if (!token) return;
  await db.prepare(
    `UPDATE guest_sessions SET revoked_at_ms = ?
     WHERE token_hash = ? AND account_id = ? AND revoked_at_ms IS NULL`,
  ).bind(now, await hashOpaqueToken(token), accountId).run();
}
