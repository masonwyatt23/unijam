import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import {
  STAGING_ORIGIN,
  parseArguments,
  redactError,
  validateManifest,
  validateStagingTarget,
} from "../scripts/verify-room-hibernation.mjs";

const repositoryRoot = new URL("../", import.meta.url);

test("hibernation assurance accepts only the exact staging origin", () => {
  assert.equal(validateStagingTarget(STAGING_ORIGIN), STAGING_ORIGIN);
  for (const target of [
    "https://unijam.ashlr.ai",
    "https://staging.unijam.ashlr.ai.evil.example",
    "http://staging.unijam.ashlr.ai",
    "https://staging.unijam.ashlr.ai/path",
    "http://127.0.0.1:8787",
  ]) {
    assert.throws(() => validateStagingTarget(target), /staging-only/);
  }
});

test("hibernation assurance validates a disposable, environment-bound credential manifest", () => {
  const fixture = {
    version: 2,
    origin: STAGING_ORIGIN,
    disposable: true,
    roomId: "STAGE123",
    hostCookie: `__Host-unijam_host=${"h".repeat(32)}`,
    guestCookie: `__Host-unijam_guest=${"g".repeat(32)}`,
    candidate: {
      commit: "a".repeat(40),
      webVersionId: "11111111-1111-4111-8111-111111111111",
      connectorVersionId: "22222222-2222-4222-8222-222222222222",
    },
  };
  assert.deepEqual(validateManifest(fixture), {
    roomId: "STAGE123",
    hostCookie: fixture.hostCookie,
    guestCookie: fixture.guestCookie,
    candidate: fixture.candidate,
  });
  assert.throws(() => validateManifest({ ...fixture, disposable: false }), /disposable/);
  assert.throws(() => validateManifest({ ...fixture, candidate: undefined }), /candidate identity/);
  assert.throws(() => validateManifest({ ...fixture, origin: "https://unijam.ashlr.ai" }), /does not match staging/);
  assert.throws(() => validateManifest({ ...fixture, guestCookie: `${fixture.guestCookie}; extra=value` }), /bounded Cookie/);
});

test("hibernation assurance requires a real hibernation-eligible idle window", () => {
  assert.equal(parseArguments(["--idle-seconds", "12"]).idleSeconds, 12);
  assert.throws(() => parseArguments(["--idle-seconds", "9"]), /between 12 and 300/);
});

test("hibernation assurance redacts session cookies and capabilities from failures", () => {
  const redacted = redactError("bad __Host-unijam_guest=supersecret #cap=capabilityvalue at /api/v1/rooms/STAGE123/websocket");
  assert.equal(redacted.includes("supersecret"), false);
  assert.equal(redacted.includes("capabilityvalue"), false);
  assert.equal(redacted.includes("STAGE123"), false);
  assert.match(redacted, /REDACTED_SESSION/);
});

test("hibernation assurance refuses production before reading a manifest", () => {
  const result = spawnSync(process.execPath, [
    "scripts/verify-room-hibernation.mjs",
    "--target", "https://unijam.ashlr.ai",
    "--manifest", "/definitely/not/read.json",
  ], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /staging-only/);
  assert.doesNotMatch(result.stderr, /ENOENT/);
});

test("hibernation WebSocket and POST probes use the shared same-origin provenance headers", () => {
  const source = readFileSync(new URL("../scripts/verify-room-hibernation.mjs", import.meta.url), "utf8");
  assert.equal((source.match(/sameOriginBrowserHeaders\(/g) ?? []).length, 3);
  assert.doesNotMatch(source, /headers:\s*\{[^}]*Origin:\s*origin/);
});
