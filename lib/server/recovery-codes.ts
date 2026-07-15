import { hashOpaqueToken, randomToken, timingSafeEqual } from "./secure-token.ts";

export const RECOVERY_CODE_LOOKUP_SQL =
  "SELECT recovery_code_id, account_id, code_hash FROM recovery_codes WHERE code_hash = ? AND used_at_ms IS NULL LIMIT 1";

export async function createRecoveryCodes(db: D1Database, accountId: string): Promise<string[]> {
  const now = Date.now();
  const codes = Array.from({ length: 10 }, () => {
    const raw = randomToken(9).toUpperCase().replace(/[^A-Z0-9]/g, "").padEnd(12, "X").slice(0, 12);
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
  });
  await db.batch(await Promise.all(codes.map(async (code) => db.prepare(
    "INSERT INTO recovery_codes (recovery_code_id, account_id, code_hash, created_at_ms) VALUES (?, ?, ?, ?)",
  ).bind(crypto.randomUUID(), accountId, await hashOpaqueToken(code), now))));
  return codes;
}

export async function consumeRecoveryCode(db: D1Database, code: string): Promise<string | null> {
  const hash = await hashOpaqueToken(code.trim().toUpperCase());
  const match = await db.prepare(RECOVERY_CODE_LOOKUP_SQL).bind(hash)
    .first<{ recovery_code_id: string; account_id: string; code_hash: string }>();
  if (!match) return null;
  if (!timingSafeEqual(match.code_hash, hash)) return null;
  const update = await db.prepare("UPDATE recovery_codes SET used_at_ms = ? WHERE recovery_code_id = ? AND used_at_ms IS NULL")
    .bind(Date.now(), match.recovery_code_id).run();
  return (update.meta.changes ?? 0) === 1 ? match.account_id : null;
}
