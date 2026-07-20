import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

test("room membership migration applies to the pilot guest session schema", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE guest_sessions (
      session_id TEXT PRIMARY KEY NOT NULL,
      token_hash TEXT NOT NULL,
      room_id TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      nickname TEXT NOT NULL,
      role TEXT DEFAULT 'guest' NOT NULL,
      invite_epoch INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      last_seen_at_ms INTEGER NOT NULL,
      revoked_at_ms INTEGER
    );
  `);
  const migration = await readFile(new URL("../drizzle/0009_room_memberships.sql", import.meta.url), "utf8");
  db.exec(migration.replaceAll("--> statement-breakpoint", ""));

  assert.equal(db.prepare("SELECT COUNT(*) AS total FROM pragma_table_info('guest_sessions') WHERE name = 'account_id'").get().total, 1);
  assert.deepEqual(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'room_memberships' ORDER BY name").all().map((row) => row.name),
    [
      "room_memberships_account_last_joined_idx",
      "room_memberships_account_room_idx",
      "room_memberships_room_last_joined_idx",
      "room_memberships_room_participant_idx",
      "sqlite_autoindex_room_memberships_1",
    ],
  );
  assert.throws(() => db.prepare(
    "INSERT INTO room_memberships VALUES ('bad', 'account', 'ROOM', 'p_bad', '', 2, 1)",
  ).run(), /constraint/i);
  db.close();
});
