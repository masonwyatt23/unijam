import assert from "node:assert/strict";
import test from "node:test";

import { assertCounterAdvanced, normalizeEnrollmentCode, registrationAccountId } from "./passkeys.ts";

test("bootstrap registration cannot select an existing account", () => {
  const victimAccountId = "victim-account";
  const assigned = registrationAccountId("registration", victimAccountId);
  assert.notEqual(assigned, victimAccountId);
  assert.match(assigned, /^[0-9a-f-]{36}$/);
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
