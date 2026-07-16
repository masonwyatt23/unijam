import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { sameOriginBrowserHeaders } from "../scripts/release-request-headers.mjs";
import { validateManifest as validateLoadManifest } from "../scripts/run-room-load.mjs";

const repositoryRoot = new URL("../", import.meta.url);

function loadSessions(count, { bucketOffset = 0, cohort = "pilot-home-a" } = {}) {
  const bucketStart = Date.UTC(2026, 6, 16, 1, bucketOffset * 15);
  return Array.from({ length: count }, (_, index) => ({
    label: `guest-${index + 1}`,
    cookie: `__Host-unijam_guest=${String(index + 1).padStart(32, "0")}`,
    joinedAt: new Date(bucketStart + index * 1_000).toISOString(),
    networkCohort: cohort,
  }));
}

test("release probes send browser-equivalent same-origin provenance and ignore caller overrides", () => {
  assert.deepEqual(sameOriginBrowserHeaders("https://staging.unijam.ashlr.ai", {
    Cookie: "session=value",
    Origin: "https://evil.example",
    "Sec-Fetch-Site": "cross-site",
  }), {
    Cookie: "session=value",
    Origin: "https://staging.unijam.ashlr.ai",
    "Sec-Fetch-Site": "same-origin",
  });
  const loadSource = readFileSync(new URL("../scripts/run-room-load.mjs", import.meta.url), "utf8");
  assert.equal((loadSource.match(/sameOriginBrowserHeaders\(/g) ?? []).length, 2);
  assert.doesNotMatch(loadSource, /headers:\s*\{[^}]*Origin:\s*(?:origin|this\.origin)/);
});

test("load fixtures preserve the live per-IP join policy without weakening runtime limits", () => {
  const firstBucket = loadSessions(20);
  const nextBucket = loadSessions(5, { bucketOffset: 1 }).map((session, index) => ({
    ...session,
    cookie: `__Host-unijam_guest=${String(index + 21).padStart(32, "0")}`,
  }));
  const fixture = {
    version: 2,
    origin: "https://staging.unijam.ashlr.ai",
    provisioning: "normal-join-flow",
    soakRoom: { roomId: "SOAK1234", sessions: [...firstBucket, ...nextBucket] },
  };
  const rooms = validateLoadManifest(fixture, "soak", fixture.origin);
  assert.equal(rooms[0].sessions.length, 25);

  const overLimit = {
    ...fixture,
    soakRoom: { roomId: "SOAK1234", sessions: loadSessions(25) },
  };
  assert.throws(
    () => validateLoadManifest(overLimit, "soak", fixture.origin),
    /exceeds 20 normal joins in one 15-minute rate-limit bucket/,
  );
  assert.throws(
    () => validateLoadManifest(fixture, "soak", "https://unijam.ashlr.ai"),
    /origin must exactly match/,
  );
});

test("release configuration accepts DO name bindings and reports only real blockers", () => {
  const result = spawnSync(process.execPath, ["scripts/validate-release-config.mjs", "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.issues.some((entry) => entry.code === "BINDING_CARDINALITY"), false);
  assert.equal(report.issues.some((entry) => entry.code === "DO_CLASS"), false);
  assert.equal(report.issues.every((entry) => entry.code === "D1_SENTINEL" || entry.severity !== "warning"), true);
});

test("load harness refuses the production hostname before reading credentials", () => {
  const result = spawnSync(process.execPath, [
    "scripts/run-room-load.mjs",
    "--profile", "smoke",
    "--manifest", "/dev/null",
    "--target", "https://unijam.ashlr.ai",
  ], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Production is blocked/);
  assert.doesNotMatch(result.stderr, /JSON/);
});

test("pilot preflight emits a redacted, machine-readable offline report", () => {
  const result = spawnSync(process.execPath, [
    "scripts/pilot-preflight.mjs",
    "--env", "staging",
    "--offline",
    "--json",
  ], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  const report = JSON.parse(result.stdout);
  assert.equal(report.environment, "staging");
  assert.equal(report.remote.checked, false);
  assert.equal(report.issues.some((entry) => entry.code === "REMOTE_SKIPPED"), true);
  assert.doesNotMatch(result.stdout, /CONNECTOR_SERVICE_CREDENTIAL|PRIVATE_KEY_JWK.*[=:]/);
});

test("pilot preflight lets Wrangler derive environment-qualified Worker names", () => {
  const source = readFileSync(new URL("../scripts/pilot-preflight.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /"secret", "list"[^\n]+"--name"/);
  assert.doesNotMatch(source, /"deployments", "list"[^\n]+"--name"/);
  assert.doesNotMatch(source, /\$\{workerName\}/);
  assert.match(source, /\$\{expectedWorkerName\} has no readable deployment/);
});

test("operator recovery validates staging without reading credentials or echoing identifiers", () => {
  const result = spawnSync(process.execPath, [
    "scripts/recover-publish-operation.mjs",
    "--env", "staging",
    "--endpoint", "https://operator-staging.unijam.ashlr.ai/v1/operator/publish/recover-playlist",
    "--operation-id", "publish:spotify:ROOM1234:r4:account",
    "--marker", "unijam:v1:create_playlist:0123456789abcdef",
    "--playlist-id", "3cEYpjA9oz9GiPac4AsH4n",
    "--dry-run",
  ], { cwd: repositoryRoot, encoding: "utf8", env: {} });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, environment: "staging", endpointValidated: true, credentialsRead: false, mutationSent: false });
  assert.doesNotMatch(result.stdout, /ROOM1234|3cEY|pilot-oncall/);
});

test("operator recovery refuses production before reading credentials", () => {
  const result = spawnSync(process.execPath, [
    "scripts/recover-publish-operation.mjs",
    "--env", "production",
    "--endpoint", "https://operator.unijam.ashlr.ai/v1/operator/publish/recover-playlist",
    "--operation-id", "publish:spotify:ROOM1234:r4:account",
    "--marker", "unijam:v1:create_playlist:0123456789abcdef",
    "--playlist-id", "3cEYpjA9oz9GiPac4AsH4n",
  ], { cwd: repositoryRoot, encoding: "utf8", env: {} });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Production recovery requires/);
  assert.doesNotMatch(result.stderr, /UNIJAM_CONNECTOR.*SECRET/);
});

test("web and connector deployments refuse unintended public aliases", () => {
  const web = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, ""));
  const connector = JSON.parse(readFileSync(new URL("../wrangler.connectors.jsonc", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, ""));
  assert.equal(web.workers_dev, false);
  assert.equal(web.preview_urls, false);
  assert.equal(connector.workers_dev, false);
  assert.equal(connector.preview_urls, false);
  for (const environment of ["staging", "production"]) {
    assert.equal(web.env[environment].workers_dev, false);
    assert.equal(web.env[environment].preview_urls, false);
    assert.equal(connector.env[environment].workers_dev, false);
    assert.equal(connector.env[environment].preview_urls, false);
  }
  const result = spawnSync(process.execPath, [
    "scripts/recover-publish-operation.mjs",
    "--env", "staging",
    "--endpoint", "https://unijam-connectors-staging.account.workers.dev/v1/operator/publish/recover-playlist",
    "--operation-id", "publish:spotify:ROOM1234:r4:account",
    "--marker", "unijam:v1:create_playlist:0123456789abcdef",
    "--playlist-id", "3cEYpjA9oz9GiPac4AsH4n",
    "--dry-run",
  ], { cwd: repositoryRoot, encoding: "utf8", env: {} });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Cloudflare Access operator ingress/);
});
