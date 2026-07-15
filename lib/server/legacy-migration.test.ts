import assert from "node:assert/strict";
import test from "node:test";

import { LEGACY_BEARER_WINDOW_MS, LEGACY_CLAIM_WINDOW_MS, legacyExportHash, legacyImportWriteResult, legacyWindowState } from "./legacy-migration.ts";

test("legacy migration windows close bearer exchange before claim", () => {
  const imported = 1_000;
  assert.equal(legacyWindowState(imported, imported + LEGACY_BEARER_WINDOW_MS), "exchange");
  assert.equal(legacyWindowState(imported, imported + LEGACY_BEARER_WINDOW_MS + 1), "claim-only");
  assert.equal(legacyWindowState(imported, imported + LEGACY_CLAIM_WINDOW_MS + 1), "read-only");
});

test("idempotent import never reports a conflicting export as accepted", () => {
  assert.equal(legacyImportWriteResult(1, null, "new"), "created");
  assert.equal(legacyImportWriteResult(0, "same", "same"), "duplicate");
  assert.equal(legacyImportWriteResult(0, "old", "new"), "conflict");
});

test("legacy export hash is independent of object key order", async () => {
  assert.equal(await legacyExportHash({ version: 1, roomId: "ABC123", snapshot: { b: 2, a: 1 }, events: [] }), await legacyExportHash({ events: [], snapshot: { a: 1, b: 2 }, roomId: "ABC123", version: 1 }));
});
