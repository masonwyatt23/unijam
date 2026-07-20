import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { prepareHostSession } from "../../lib/server/host-session.ts";
import { commitVerifiedRegistration } from "../../lib/server/passkeys.ts";
import { prepareRecoveryCodes, redeemRecoveryCode } from "../../lib/server/recovery-codes.ts";
import { hashOpaqueToken } from "../../lib/server/secure-token.ts";

function database(): D1Database {
  if (!env.DB) throw new Error("DB test binding is missing");
  return env.DB;
}

async function resetSchema(): Promise<D1Database> {
  const db = database();
  await db.exec(`DROP TRIGGER IF EXISTS reject_recovery_session;
DROP TABLE IF EXISTS recovery_codes;
DROP TABLE IF EXISTS host_sessions;
DROP TABLE IF EXISTS passkeys;
DROP TABLE IF EXISTS passkey_challenges;
DROP TABLE IF EXISTS host_enrollment_codes;
DROP TABLE IF EXISTS accounts;
CREATE TABLE accounts (account_id TEXT PRIMARY KEY NOT NULL, display_name TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, deleted_at_ms INTEGER);
CREATE TABLE passkeys (credential_id TEXT PRIMARY KEY NOT NULL, account_id TEXT NOT NULL, public_key_base64 TEXT NOT NULL, counter INTEGER DEFAULT 0 NOT NULL, transports_json TEXT DEFAULT '[]' NOT NULL, device_type TEXT NOT NULL, backed_up INTEGER DEFAULT 0 NOT NULL, created_at_ms INTEGER NOT NULL, last_used_at_ms INTEGER NOT NULL, revoked_at_ms INTEGER);
CREATE TABLE passkey_challenges (challenge_hash TEXT PRIMARY KEY NOT NULL, challenge TEXT NOT NULL, kind TEXT NOT NULL, account_id TEXT, enrollment_code_hash TEXT, expires_at_ms INTEGER NOT NULL, consumed_at_ms INTEGER, created_at_ms INTEGER NOT NULL);
CREATE TABLE host_enrollment_codes (code_hash TEXT PRIMARY KEY NOT NULL, label TEXT NOT NULL, expires_at_ms INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, used_at_ms INTEGER, used_by_account_id TEXT);
CREATE TABLE host_sessions (session_id TEXT PRIMARY KEY NOT NULL, token_hash TEXT NOT NULL UNIQUE, account_id TEXT NOT NULL, authenticated_at_ms INTEGER NOT NULL, passkey_verified_at_ms INTEGER, expires_at_ms INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, last_seen_at_ms INTEGER NOT NULL, revoked_at_ms INTEGER, recovery_enrollment_expires_at_ms INTEGER, recovery_enrollment_consumed_at_ms INTEGER);
CREATE TABLE recovery_codes (recovery_code_id TEXT PRIMARY KEY NOT NULL, account_id TEXT NOT NULL, code_hash TEXT NOT NULL UNIQUE, created_at_ms INTEGER NOT NULL, used_at_ms INTEGER);`);
  return db;
}

async function pilotAttempt(
  db: D1Database,
  input: { accountId: string; challengeHash: string; credentialId: string; enrollmentCodeHash: string; marker: number; now: number },
): Promise<void> {
  const recovery = await prepareRecoveryCodes(db, input.accountId, input.now);
  const session = await prepareHostSession(db, input.accountId, "passkey", input.now);
  await commitVerifiedRegistration(db, {
    accountId: input.accountId,
    displayName: `Pilot ${input.accountId}`,
    ceremony: "registration",
    challengeHash: input.challengeHash,
    enrollmentCodeHash: input.enrollmentCodeHash,
    credential: {
      id: input.credentialId,
      publicKeyBase64: "dGVzdC1wdWJsaWMta2V5",
      counter: 0,
      transportsJson: "[]",
      deviceType: "multiDevice",
      backedUp: true,
    },
    now: input.now,
    consumptionMarker: input.marker,
  }, [...recovery.statements, session.statement]);
}

describe.sequential("authentication atomicity", () => {
  beforeEach(async () => { await resetSchema(); });

  it("commits exactly one complete bootstrap identity when a pilot code races", async () => {
    const db = database();
    const now = Date.now();
    const enrollmentCodeHash = "shared-pilot-code-hash";
    await db.batch([
      db.prepare(
        `INSERT INTO host_enrollment_codes
         (code_hash, label, expires_at_ms, created_at_ms) VALUES (?, 'Cofounder', ?, ?)`,
      ).bind(enrollmentCodeHash, now + 60_000, now),
      ...["alpha", "beta"].map((suffix) => db.prepare(
        `INSERT INTO passkey_challenges
         (challenge_hash, challenge, kind, account_id, enrollment_code_hash, expires_at_ms, created_at_ms)
         VALUES (?, ?, 'registration', ?, ?, ?, ?)`,
      ).bind(
        `challenge-${suffix}`,
        `challenge-value-${suffix}`,
        `account-${suffix}`,
        enrollmentCodeHash,
        now + 60_000,
        now,
      )),
    ]);

    const results = await Promise.allSettled([
      pilotAttempt(db, {
        accountId: "account-alpha", challengeHash: "challenge-alpha", credentialId: "credential-alpha",
        enrollmentCodeHash, marker: 101, now,
      }),
      pilotAttempt(db, {
        accountId: "account-beta", challengeHash: "challenge-beta", credentialId: "credential-beta",
        enrollmentCodeHash, marker: 202, now,
      }),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);

    const counts = await db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM accounts) AS accounts,
         (SELECT COUNT(*) FROM passkeys) AS passkeys,
         (SELECT COUNT(*) FROM recovery_codes) AS recovery_codes,
         (SELECT COUNT(*) FROM host_sessions) AS sessions,
         (SELECT COUNT(*) FROM passkey_challenges WHERE consumed_at_ms IS NOT NULL) AS consumed_challenges`,
    ).first<{ accounts: number; passkeys: number; recovery_codes: number; sessions: number; consumed_challenges: number }>();
    expect(counts).toEqual({ accounts: 1, passkeys: 1, recovery_codes: 10, sessions: 1, consumed_challenges: 1 });

    const winner = await db.prepare("SELECT account_id FROM accounts LIMIT 1").first<{ account_id: string }>();
    const code = await db.prepare(
      "SELECT used_by_account_id FROM host_enrollment_codes WHERE code_hash = ?",
    ).bind(enrollmentCodeHash).first<{ used_by_account_id: string }>();
    expect(code?.used_by_account_id).toBe(winner?.account_id);
    expect((await db.prepare("SELECT COUNT(*) AS total FROM recovery_codes WHERE account_id = ?")
      .bind(winner!.account_id).first<{ total: number }>())?.total).toBe(10);
    expect((await db.prepare("SELECT COUNT(*) AS total FROM host_sessions WHERE account_id = ?")
      .bind(winner!.account_id).first<{ total: number }>())?.total).toBe(1);
  });

  it("redeems a recovery code once and creates exactly one recovery session under concurrency", async () => {
    const db = database();
    const now = Date.now();
    const code = "ABCD-EFGH-IJKL";
    await db.batch([
      db.prepare(
        "INSERT INTO accounts (account_id, display_name, created_at_ms, updated_at_ms) VALUES ('account-recovery', 'Recovery', ?, ?)",
      ).bind(now, now),
      db.prepare(
        "INSERT INTO recovery_codes (recovery_code_id, account_id, code_hash, created_at_ms) VALUES ('recovery-1', 'account-recovery', ?, ?)",
      ).bind(await hashOpaqueToken(code), now),
    ]);

    const results = await Promise.all([
      redeemRecoveryCode(db, code),
      redeemRecoveryCode(db, code),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((result) => result === null)).toHaveLength(1);
    expect((await db.prepare("SELECT COUNT(*) AS total FROM host_sessions").first<{ total: number }>())?.total).toBe(1);
    expect((await db.prepare("SELECT used_at_ms FROM recovery_codes WHERE recovery_code_id = 'recovery-1'")
      .first<{ used_at_ms: number | null }>())?.used_at_ms).not.toBeNull();
  });

  it("does not burn a recovery code when session creation fails", async () => {
    const db = database();
    const now = Date.now();
    const code = "WXYZ-1234-5678";
    await db.batch([
      db.prepare(
        "INSERT INTO accounts (account_id, display_name, created_at_ms, updated_at_ms) VALUES ('account-failure', 'Recovery', ?, ?)",
      ).bind(now, now),
      db.prepare(
        "INSERT INTO recovery_codes (recovery_code_id, account_id, code_hash, created_at_ms) VALUES ('recovery-failure', 'account-failure', ?, ?)",
      ).bind(await hashOpaqueToken(code), now),
    ]);
    await db.prepare(`CREATE TRIGGER reject_recovery_session BEFORE INSERT ON host_sessions
      BEGIN SELECT RAISE(ABORT, 'session storage unavailable'); END`).run();

    await expect(redeemRecoveryCode(db, code)).rejects.toThrow();
    expect((await db.prepare("SELECT used_at_ms FROM recovery_codes WHERE recovery_code_id = 'recovery-failure'")
      .first<{ used_at_ms: number | null }>())?.used_at_ms).toBeNull();
    expect((await db.prepare("SELECT COUNT(*) AS total FROM host_sessions").first<{ total: number }>())?.total).toBe(0);
  });
});
