import assert from "node:assert/strict";
import test from "node:test";

import { safeHostReturnTo } from "../host-return-to.ts";
import { assertCounterAdvanced, normalizeEnrollmentCode, publicRegistrationOptions, registrationAccountId } from "./passkeys.ts";

test("bootstrap registration cannot select an existing account", () => {
  const victimAccountId = "victim-account";
  const assigned = registrationAccountId("registration", victimAccountId);
  assert.notEqual(assigned, victimAccountId);
  assert.match(assigned, /^[0-9a-f-]{36}$/);
});

test("public membership creates a fresh server-owned account identity", () => {
  const victimAccountId = "victim-account";
  const assigned = registrationAccountId("public_registration", victimAccountId);
  assert.notEqual(assigned, victimAccountId);
  assert.match(assigned, /^[0-9a-f-]{36}$/);
});

test("public membership persists a ceremony kind distinct from pilot enrollment", async () => {
  const writes: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return { run: async () => { writes.push({ sql, values }); } };
        },
      };
    },
  } as unknown as D1Database;
  const result = await publicRegistrationOptions(db, {
    APP_ENV: "development",
    APP_ORIGIN: "http://localhost:3000",
    WEBAUTHN_RP_ID: "localhost",
  }, { userName: "listener@example.test", displayName: "Listener" });
  assert.match(result.accountId, /^[0-9a-f-]{36}$/);
  const challengeInsert = writes.find(({ sql }) => sql.includes("INSERT INTO passkey_challenges"));
  assert.equal(challengeInsert?.values[2], "public_registration");
  assert.equal(challengeInsert?.values[4], null);
});

test("additional credential registration requires server-derived authentication", () => {
  assert.throws(() => registrationAccountId("additional_registration"), /authenticated passkey session/);
  assert.equal(registrationAccountId("additional_registration", "account-from-session"), "account-from-session");
});

test("counter-bearing passkeys reject a lost compare-and-swap race", () => {
  assert.throws(() => assertCounterAdvanced(7, 8, 0), /counter changed/);
  assert.doesNotThrow(() => assertCounterAdvanced(7, 8, 1));
  assert.doesNotThrow(() => assertCounterAdvanced(0, 0, 0));
});

test("pilot host enrollment requires a nontrivial server-issued code", () => {
  assert.throws(() => normalizeEnrollmentCode(""), /unavailable/);
  assert.throws(() => normalizeEnrollmentCode("public"), /unavailable/);
  assert.equal(normalizeEnrollmentCode(" pilot-abcd-1234 "), "PILOT-ABCD-1234");
});

test("post-authentication redirects stay on known UniJam host routes", () => {
  assert.equal(safeHostReturnTo("/rooms/new"), "/rooms/new");
  assert.equal(safeHostReturnTo("/room/ROOM1234/publish"), "/room/ROOM1234/publish");
  assert.equal(safeHostReturnTo("/room/ROOM1234/handoff/spotify"), "/room/ROOM1234/handoff/spotify");
  assert.equal(safeHostReturnTo("/connections/apple-music"), "/connections/apple-music");
  assert.equal(
    safeHostReturnTo("/connections/spotify?returnTo=%2Froom%2FROOM1234"),
    "/connections/spotify?returnTo=%2Froom%2FROOM1234",
  );
  for (const unsafe of [
    "https://evil.example", "//evil.example", "/join/ROOM1234", "/host?next=//evil.example", "/room/../../admin",
    "/connections/spotify?returnTo=https%3A%2F%2Fevil.example",
    "/connections/apple-music?returnTo=%2Froom%2FROOM1234&next=%2Fhost",
    "https://unijam.invalid/connections/spotify?returnTo=%2Froom%2FROOM1234",
  ]) {
    assert.equal(safeHostReturnTo(unsafe), "/host");
  }
});
