import { hashOpaqueToken, randomToken } from "./secure-token.ts";
import { HOST_SESSION_COOKIE, readCookie, sessionCookie } from "./session-cookie.ts";

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const RECOVERY_ENROLLMENT_MS = 15 * 60_000;
export const RECENT_PASSKEY_MS = 5 * 60_000;

export type HostSession = {
  session_id: string;
  account_id: string;
  display_name: string;
  authenticated_at_ms: number;
  passkey_verified_at_ms: number | null;
  expires_at_ms: number;
  recovery_enrollment_expires_at_ms: number | null;
  recovery_enrollment_consumed_at_ms: number | null;
};

export function passkeyVerifiedAt(method: "passkey" | "recovery", now: number): number | null {
  return method === "passkey" ? now : null;
}

export async function createHostSession(
  db: D1Database,
  accountId: string,
  method: "passkey" | "recovery" = "passkey",
): Promise<{ token: string; cookie: string }> {
  const token = randomToken();
  const now = Date.now();
  await db.prepare(
    `INSERT INTO host_sessions
     (session_id, token_hash, account_id, authenticated_at_ms, passkey_verified_at_ms, expires_at_ms, created_at_ms, last_seen_at_ms, recovery_enrollment_expires_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), await hashOpaqueToken(token), accountId, now, passkeyVerifiedAt(method, now),
    now + SESSION_TTL_SECONDS * 1_000, now, now, method === "recovery" ? now + RECOVERY_ENROLLMENT_MS : null,
  ).run();
  return { token, cookie: sessionCookie(HOST_SESSION_COOKIE, token, SESSION_TTL_SECONDS) };
}

export async function authenticateHost(db: D1Database, request: Request): Promise<HostSession | null> {
  const token = readCookie(request, HOST_SESSION_COOKIE);
  if (!token) return null;
  const hash = await hashOpaqueToken(token);
  const now = Date.now();
  const session = await db.prepare(
    `SELECT s.session_id, s.account_id, a.display_name, s.authenticated_at_ms, s.passkey_verified_at_ms, s.expires_at_ms,
            s.recovery_enrollment_expires_at_ms, s.recovery_enrollment_consumed_at_ms
     FROM host_sessions s JOIN accounts a ON a.account_id = s.account_id
     WHERE s.token_hash = ? AND s.revoked_at_ms IS NULL AND s.expires_at_ms > ? AND a.deleted_at_ms IS NULL LIMIT 1`,
  ).bind(hash, now).first<HostSession>();
  if (session) {
    await db.prepare("UPDATE host_sessions SET last_seen_at_ms = ? WHERE session_id = ?").bind(now, session.session_id).run();
  }
  return session;
}

export async function revokeHostSession(db: D1Database, request: Request): Promise<void> {
  const token = readCookie(request, HOST_SESSION_COOKIE);
  if (!token) return;
  await db.prepare("UPDATE host_sessions SET revoked_at_ms = ? WHERE token_hash = ? AND revoked_at_ms IS NULL")
    .bind(Date.now(), await hashOpaqueToken(token)).run();
}

export function isRecentPasskey(session: HostSession, now = Date.now()): boolean {
  return session.passkey_verified_at_ms !== null && now - session.passkey_verified_at_ms <= RECENT_PASSKEY_MS;
}

export function canEnrollRecoveryPasskey(session: HostSession, now = Date.now()): boolean {
  return session.passkey_verified_at_ms === null && session.recovery_enrollment_consumed_at_ms === null &&
    session.recovery_enrollment_expires_at_ms !== null && session.recovery_enrollment_expires_at_ms > now;
}
