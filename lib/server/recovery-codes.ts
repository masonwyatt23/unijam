import { prepareHostSession } from "./host-session.ts";
import { hashOpaqueToken, randomToken, timingSafeEqual } from "./secure-token.ts";

export const RECOVERY_CODE_LOOKUP_SQL =
  "SELECT recovery_code_id, account_id, code_hash FROM recovery_codes WHERE code_hash = ? AND used_at_ms IS NULL LIMIT 1";

export async function prepareRecoveryCodes(
  db: D1Database,
  accountId: string,
  now = Date.now(),
): Promise<{ codes: string[]; statements: D1PreparedStatement[] }> {
  const codes = Array.from({ length: 10 }, () => {
    const raw = randomToken(9).toUpperCase().replace(/[^A-Z0-9]/g, "").padEnd(12, "X").slice(0, 12);
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
  });
  const statements = await Promise.all(codes.map(async (code) => db.prepare(
    "INSERT INTO recovery_codes (recovery_code_id, account_id, code_hash, created_at_ms) VALUES (?, ?, ?, ?)",
  ).bind(crypto.randomUUID(), accountId, await hashOpaqueToken(code), now)));
  return { codes, statements };
}

export async function createRecoveryCodes(db: D1Database, accountId: string): Promise<string[]> {
  const prepared = await prepareRecoveryCodes(db, accountId);
  await db.batch(prepared.statements);
  return prepared.codes;
}

export async function redeemRecoveryCode(
  db: D1Database,
  code: string,
): Promise<{ accountId: string; sessionCookie: string } | null> {
  const hash = await hashOpaqueToken(code.trim().toUpperCase());
  const match = await db.prepare(RECOVERY_CODE_LOOKUP_SQL).bind(hash)
    .first<{ recovery_code_id: string; account_id: string; code_hash: string }>();
  if (!match) return null;
  if (!timingSafeEqual(match.code_hash, hash)) return null;
  const now = Date.now();
  const session = await prepareHostSession(db, match.account_id, "recovery", now, match.recovery_code_id);
  const statements = [
    session.statement,
    db.prepare(
      `UPDATE recovery_codes SET used_at_ms = ?
       WHERE recovery_code_id = ? AND account_id = ? AND used_at_ms IS NULL
         AND EXISTS (
           SELECT 1 FROM host_sessions WHERE session_id = ? AND account_id = ?
         )`,
    ).bind(now, match.recovery_code_id, match.account_id, session.sessionId, match.account_id),
    db.prepare(
      `SELECT CASE WHEN EXISTS (
         SELECT 1 FROM host_sessions WHERE session_id = ? AND account_id = ?
       ) AND EXISTS (
         SELECT 1 FROM recovery_codes
         WHERE recovery_code_id = ? AND account_id = ? AND used_at_ms = ?
       ) THEN 1 ELSE json_extract('recovery redemption conflict', '$') END AS committed`,
    ).bind(session.sessionId, match.account_id, match.recovery_code_id, match.account_id, now),
  ];
  try {
    const results = await db.batch(statements);
    if (results.slice(0, 2).some((result) => (result.meta.changes ?? 0) !== 1)) {
      throw new Error("Recovery redemption changed concurrently");
    }
    return { accountId: match.account_id, sessionCookie: session.cookie };
  } catch (error) {
    // A concurrent winner makes this code invalid. Any other database failure
    // remains an infrastructure error, and the failed D1 batch leaves the code
    // unused for a safe retry.
    const state = await db.prepare(
      "SELECT used_at_ms FROM recovery_codes WHERE recovery_code_id = ? AND account_id = ? LIMIT 1",
    ).bind(match.recovery_code_id, match.account_id).first<{ used_at_ms: number | null }>();
    if (state?.used_at_ms !== null && state?.used_at_ms !== undefined) return null;
    throw error;
  }
}
