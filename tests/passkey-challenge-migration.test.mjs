import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

test("passkey challenge identity migration preserves in-flight challenges", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE passkey_challenges (
      challenge_hash TEXT PRIMARY KEY NOT NULL,
      challenge TEXT NOT NULL,
      kind TEXT NOT NULL,
      account_id TEXT,
      enrollment_code_hash TEXT,
      expires_at_ms INTEGER NOT NULL,
      consumed_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL
    );
    INSERT INTO passkey_challenges
      (challenge_hash, challenge, kind, account_id, expires_at_ms, created_at_ms)
      VALUES ('legacy-hash', 'legacy-value', 'public_registration', 'legacy-account', 2, 1);
  `);
  const migration = await readFile(new URL("../drizzle/0010_passkey_challenge_identity.sql", import.meta.url), "utf8");
  db.exec(migration.replaceAll("--> statement-breakpoint", ""));

  assert.equal(db.prepare("SELECT COUNT(*) AS total FROM pragma_table_info('passkey_challenges') WHERE name = 'display_name'").get().total, 1);
  assert.equal(db.prepare("SELECT display_name FROM passkey_challenges WHERE challenge_hash = 'legacy-hash'").get().display_name, null);
  db.prepare("UPDATE passkey_challenges SET display_name = ? WHERE challenge_hash = ?").run("Listener", "legacy-hash");
  assert.equal(db.prepare("SELECT display_name FROM passkey_challenges WHERE challenge_hash = 'legacy-hash'").get().display_name, "Listener");
  db.close();
});
