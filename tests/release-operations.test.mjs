import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const repositoryRoot = new URL("../", import.meta.url);

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
