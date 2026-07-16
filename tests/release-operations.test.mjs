import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { sameOriginBrowserHeaders } from "../scripts/release-request-headers.mjs";
import { validateManifest as validateLoadManifest } from "../scripts/run-room-load.mjs";
import { activeVersionIds, deployedVersionMismatches, pendingMigrationNames } from "../scripts/pilot-preflight-helpers.mjs";

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
  assert.equal(report.requiredProvider, null);
  assert.deepEqual(report.configured, { customDomain: true, cronTriggers: 2, observabilityEnabled: 2 });
  assert.equal(report.remote.checked, false);
  assert.equal(report.issues.some((entry) => entry.code === "REMOTE_SKIPPED"), true);
  assert.doesNotMatch(result.stdout, /CONNECTOR_SERVICE_CREDENTIAL|PRIVATE_KEY_JWK.*[=:]/);
});

test("pilot preflight can gate one provider without opening publishing", () => {
  const result = spawnSync(process.execPath, [
    "scripts/pilot-preflight.mjs",
    "--env", "staging",
    "--require-provider", "apple-music",
    "--offline",
    "--json",
  ], { cwd: repositoryRoot, encoding: "utf8" });
  const report = JSON.parse(result.stdout);
  assert.equal(report.requiredProvider, "apple-music");
  assert.equal(report.issues.some((entry) => entry.severity === "blocker" && entry.code === "PILOT_ALLOWLIST_EMPTY" && /Apple Music/.test(entry.message)), true);
  assert.equal(report.issues.some((entry) => entry.severity === "blocker" && entry.code === "PILOT_ALLOWLIST_EMPTY" && /Spotify/.test(entry.message)), false);
  assert.equal(report.expected.workers.includes("unijam-connectors-staging"), true);
});

test("pilot preflight lets Wrangler derive environment-qualified Worker names", () => {
  const source = readFileSync(new URL("../scripts/pilot-preflight.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /"secret", "list"[^\n]+"--name"/);
  assert.doesNotMatch(source, /"deployments", "status"[^\n]+"--name"/);
  assert.doesNotMatch(source, /\$\{workerName\}/);
  assert.match(source, /\$\{expectedWorkerName\} has no readable deployment/);
});

test("Apple private key installer validates a piped P-256 key without disclosing it", () => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const result = spawnSync(process.execPath, [
    "scripts/install-apple-private-key.mjs",
    "--env", "staging",
    "--dry-run",
  ], { cwd: repositoryRoot, encoding: "utf8", input: pem });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    environment: "staging",
    keyType: "EC",
    curve: "P-256",
    secretName: "APPLE_PRIVATE_KEY_JWK",
    secretInstalled: false,
  });
  assert.doesNotMatch(result.stdout, /BEGIN PRIVATE KEY|\"d\"|\"x\"|\"y\"/);
});

test("provider pilot configuration uses independent five-host allowlists", () => {
  const connector = JSON.parse(readFileSync(new URL("../wrangler.connectors.jsonc", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, ""));
  for (const environment of ["staging", "production"]) {
    const vars = connector.env[environment].vars;
    assert.equal(vars.SPOTIFY_PILOT_ACCOUNT_ALLOWLIST, "");
    assert.equal(vars.APPLE_MUSIC_PILOT_ACCOUNT_ALLOWLIST, "");
    assert.equal("PILOT_ACCOUNT_ALLOWLIST" in vars, false);
  }
  const validator = readFileSync(new URL("../scripts/validate-release-config.mjs", import.meta.url), "utf8");
  assert.match(validator, /PILOT_ALLOWLIST_LIMIT/);
  assert.match(validator, /pilot allowlist exceeds the five-host release limit/);
});

test("pilot preflight parses only deterministic migration and active-version evidence", () => {
  assert.deepEqual(pendingMigrationNames({ status: 0, stdout: "✅ No migrations to apply!\n" }), []);
  assert.deepEqual(pendingMigrationNames({ status: 0, stdout: "Migration Name\n0007_add_index.sql\n0008_more.sql\n" }), ["0007_add_index.sql", "0008_more.sql"]);
  assert.equal(pendingMigrationNames({ status: 0, stdout: "unexpected output" }), undefined);
  assert.deepEqual(activeVersionIds({ status: 0, stdout: JSON.stringify({ versions: [
    { version_id: "version-a", percentage: 90 }, { version_id: "version-b", percentage: 10 }, { version_id: "old", percentage: 0 },
  ] }) }), ["version-a", "version-b"]);
  assert.equal(activeVersionIds({ status: 0, stdout: "not json" }), undefined);
});

test("pilot preflight checks deployed handlers and exact binding resources", () => {
  const expected = {
    handlers: ["fetch", "queue", "scheduled"],
    namedHandlers: [{ name: "RoomDurableObject", handlers: ["class"] }],
    bindings: [
      { name: "DB", type: "d1", database_id: "db-staging" },
      { name: "CONNECTORS", type: "service", service: "connectors-staging" },
    ],
  };
  const deployed = { resources: { script: {
    handlers: ["fetch", "queue", "scheduled"],
    named_handlers: [{ name: "RoomDurableObject", handlers: ["class"] }],
  }, bindings: [
    { name: "DB", type: "d1", database_id: "db-staging", id: "db-staging" },
    { name: "CONNECTORS", type: "service", service: "connectors-staging", environment: "production" },
  ] } };
  assert.deepEqual(deployedVersionMismatches(deployed, expected), []);
  assert.deepEqual(deployedVersionMismatches({ ...deployed, resources: { ...deployed.resources, bindings: [] } }, expected), [
    "binding DB is missing or mismatched", "binding CONNECTORS is missing or mismatched",
  ]);
  assert.deepEqual(deployedVersionMismatches({
    resources: { script: { handlers: ["fetch", "queue", "scheduled"] }, bindings: deployed.resources.bindings },
  }, { ...expected, namedHandlers: [] }), []);
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
