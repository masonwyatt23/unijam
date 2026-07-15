import assert from "node:assert/strict";
import test from "node:test";
import { redactedInternalError } from "./api-response.ts";

test("synthetic persistence errors never cross the API boundary", async () => {
  const response = redactedInternalError(new Error("SQLITE secret_table token=super-secret"), "ROOM_CREATE_FAILED", "Unable to create room");
  const body = await response.text();
  assert.doesNotMatch(body, /SQLITE|secret_table|super-secret/);
  assert.match(body, /ROOM_CREATE_FAILED/);
});
