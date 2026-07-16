#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { activeVersionIds, deployedVersionMismatches, pendingMigrationNames } from "./pilot-preflight-helpers.mjs";

const root = resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const environment = valueAfter("--env");
const jsonOutput = argv.includes("--json");
const offline = argv.includes("--offline");
const requiredProvider = valueAfter("--require-provider");

if (!environment || !["staging", "production"].includes(environment)) {
  console.error("Usage: node scripts/pilot-preflight.mjs --env staging|production [--require-provider spotify|apple-music|both] [--json] [--offline]");
  process.exit(2);
}
if (requiredProvider && !["spotify", "apple-music", "both"].includes(requiredProvider)) {
  console.error("--require-provider must be spotify, apple-music, or both");
  process.exit(2);
}

function valueAfter(flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

function stripJsonComments(source) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (inString) {
      output += current;
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === '"') inString = false;
      continue;
    }
    if (current === '"') {
      inString = true;
      output += current;
      continue;
    }
    if (current === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    if (current === "/" && next === "*") {
      index += 2;
      while (index < source.length - 1 && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index += 1;
      continue;
    }
    output += current;
  }
  return output;
}

function command(command, args) {
  return spawnSync(command, args, { cwd: root, encoding: "utf8", env: process.env });
}

function wrangler(args) {
  return command("npx", ["--no-install", "wrangler", ...args]);
}

function safeJson(source) {
  try {
    return JSON.parse(source);
  } catch {
    return undefined;
  }
}

const issues = [];
function issue(severity, code, message) {
  issues.push({ severity, code, message });
}

function namesFromSecretList(result) {
  if (result.status !== 0) return undefined;
  const parsed = safeJson(result.stdout);
  if (!Array.isArray(parsed)) return undefined;
  return new Set(parsed.map((entry) => entry?.name).filter((name) => typeof name === "string"));
}

function assertNames(actual, expected, code, label) {
  if (!actual) {
    issue("blocker", `${code}_UNREADABLE`, `${label} could not be read.`);
    return;
  }
  for (const name of expected) {
    if (!actual.has(name)) issue("blocker", code, `${label} is missing ${name}.`);
  }
}

const [webConfig, connectorConfig] = await Promise.all([
  readFile(resolve(root, "wrangler.jsonc"), "utf8").then((source) => JSON.parse(stripJsonComments(source))),
  readFile(resolve(root, "wrangler.connectors.jsonc"), "utf8").then((source) => JSON.parse(stripJsonComments(source))),
]);
const web = webConfig.env[environment];
const connector = connectorConfig.env[environment];
const expected = {
  origin: web.vars.APP_ORIGIN,
  workers: [web.name, connector.name],
  databases: [web.d1_databases[0].database_name, connector.d1_databases[0].database_name],
  queues: [
    web.queues.producers[0].queue,
    web.queues.consumers[0].dead_letter_queue,
    connector.queues.producers[0].queue,
    connector.queues.consumers[0].dead_letter_queue,
  ],
};
const configured = {
  customDomain: web.routes?.some((route) => route.pattern === new URL(web.vars.APP_ORIGIN).hostname && route.custom_domain === true) === true,
  cronTriggers: (web.triggers?.crons?.length ?? webConfig.triggers?.crons?.length ?? 0)
    + (connector.triggers?.crons?.length ?? connectorConfig.triggers?.crons?.length ?? 0),
  observabilityEnabled: [web, connector].filter((config) => config.observability?.enabled === true).length,
};
function requiresProvider(provider) {
  return requiredProvider === "both" || requiredProvider === provider;
}
if (!configured.customDomain) issue("blocker", "CUSTOM_DOMAIN_CONFIG", `${environment} web custom domain is not configured exactly.`);
if (configured.cronTriggers !== 2) issue("blocker", "CRON_CONFIG", `${environment} must configure exactly one web cron and one connector cron.`);
if (configured.observabilityEnabled !== 2) issue("blocker", "OBSERVABILITY_CONFIG", `${environment} must enable observability for both Workers.`);

function expectedVersionResources(kind) {
  const config = kind === "web" ? web : connector;
  const bindings = [
    { name: "ANALYTICS", type: "analytics_engine", dataset: config.analytics_engine_datasets[0].dataset },
  ];
  for (const [name, text] of Object.entries(config.vars)) bindings.push({ name, type: "plain_text", text });
  if (kind === "web") {
    bindings.push(
      { name: "DB", type: "d1", database_id: web.d1_databases[0].database_id },
      { name: "ROOM_OBJECTS", type: "durable_object_namespace", class_name: web.durable_objects.bindings[0].class_name },
      { name: "ROOM_PROJECTION_QUEUE", type: "queue", queue_name: web.queues.producers[0].queue },
      { name: "CONNECTORS", type: "service", service: web.services[0].service },
      { name: "CONNECTOR_SERVICE_TOKEN", type: "secret_text" },
      { name: "ASSETS", type: "assets" },
      { name: "IMAGES", type: "images" },
    );
    return { handlers: ["fetch", "queue", "scheduled"], namedHandlers: [{ name: "RoomDurableObject", handlers: ["class"] }], bindings };
  }
  bindings.push(
    { name: "CONNECTOR_DB", type: "d1", database_id: connector.d1_databases[0].database_id },
    { name: "PUBLISH_QUEUE", type: "queue", queue_name: connector.queues.producers[0].queue },
    { name: "CONNECTOR_SHARED_SECRET", type: "secret_text" },
    { name: "CONNECTOR_OPERATOR_SECRET", type: "secret_text" },
    { name: "TOKEN_ENCRYPTION_KEY_B64URL", type: "secret_text" },
    { name: "TOKEN_KEY_VERSION", type: "secret_text" },
  );
  return { handlers: ["fetch", "queue", "scheduled"], namedHandlers: [], bindings };
}

const gitShaResult = command("git", ["rev-parse", "HEAD"]);
const gitStatusResult = command("git", ["status", "--porcelain"]);
const gitSha = gitShaResult.status === 0 ? gitShaResult.stdout.trim() : "unknown";
const clean = gitStatusResult.status === 0 && gitStatusResult.stdout.trim() === "";
if (!clean) issue("blocker", "DIRTY_WORKTREE", "Commit or deliberately discard local changes before release evidence is captured.");
if (Number(process.versions.node.split(".")[0]) !== 24) {
  issue("blocker", "NODE_VERSION", `Node 24 is required; found ${process.versions.node}.`);
}

const validation = command(process.execPath, [
  "scripts/validate-release-config.mjs", "--env", environment, "--require-provisioned", "--json",
]);
const validationReport = safeJson(validation.stdout);
if (!validationReport) {
  issue("blocker", "CONFIG_VALIDATION_UNREADABLE", "Strict release configuration validation did not return JSON.");
} else {
  for (const entry of validationReport.issues) {
    issue(entry.severity === "warning" ? "warning" : "blocker", `CONFIG_${entry.code}`, entry.message);
  }
}

const remote = {
  checked: !offline,
  authenticated: false,
  databasesPresent: 0,
  queuesPresent: 0,
  workersWithDeployments: 0,
  deployedVersionsChecked: 0,
  deployedVersionsMatching: 0,
  databasesWithNoPendingMigrations: 0,
  requiredSecretsPresent: 0,
  originStatus: null,
  customDomainOriginHealthy: false,
  candidate: { commit: gitSha, webVersionId: null, connectorVersionId: null },
};

if (!offline) {
  const identity = wrangler(["whoami"]);
  remote.authenticated = identity.status === 0;
  if (!remote.authenticated) {
    issue("blocker", "CLOUDFLARE_AUTH", "Cloudflare authentication is unavailable. Run `npx wrangler login` interactively or set a scoped CLOUDFLARE_API_TOKEN.");
  } else {
    const databaseResult = wrangler(["d1", "list", "--json"]);
    const databases = safeJson(databaseResult.stdout);
    const databaseNames = new Set(Array.isArray(databases) ? databases.map((entry) => entry?.name) : []);
    remote.databasesPresent = expected.databases.filter((name) => databaseNames.has(name)).length;
    assertNames(databaseNames, expected.databases, "D1_MISSING", `${environment} D1 inventory`);

    for (const [configPath, databaseName] of [
      ["wrangler.jsonc", web.d1_databases[0].database_name],
      ["wrangler.connectors.jsonc", connector.d1_databases[0].database_name],
    ]) {
      const migrationResult = wrangler(["d1", "migrations", "list", databaseName, "--config", configPath, "--env", environment, "--remote"]);
      const pending = pendingMigrationNames(migrationResult);
      if (!pending) issue("blocker", "D1_MIGRATIONS_UNREADABLE", `${databaseName} pending migrations could not be determined.`);
      else if (pending.length > 0) issue("blocker", "D1_MIGRATIONS_PENDING", `${databaseName} has ${pending.length} pending migration(s).`);
      else remote.databasesWithNoPendingMigrations += 1;
    }

    const queueResult = wrangler(["queues", "list"]);
    if (queueResult.status !== 0) {
      issue("blocker", "QUEUE_INVENTORY_UNREADABLE", `${environment} Queue inventory could not be read.`);
    } else {
      remote.queuesPresent = expected.queues.filter((name) => queueResult.stdout.includes(name)).length;
      for (const name of expected.queues) {
        if (!queueResult.stdout.includes(name)) issue("blocker", "QUEUE_MISSING", `${environment} Queue inventory is missing ${name}.`);
      }
    }

    for (const [kind, config, expectedWorkerName] of [["web", "wrangler.jsonc", web.name], ["connector", "wrangler.connectors.jsonc", connector.name]]) {
      const deployment = wrangler(["deployments", "status", "--config", config, "--env", environment, "--json"]);
      const versionIds = activeVersionIds(deployment);
      if (!versionIds) {
        issue("blocker", "WORKER_NOT_DEPLOYED", `${expectedWorkerName} has no readable deployment.`);
      } else {
        remote.workersWithDeployments += 1;
        if (versionIds.length !== 1) issue("blocker", "WORKER_GRADUAL_DEPLOYMENT", `${expectedWorkerName} must have exactly one active release version.`);
        for (const versionId of versionIds) {
          const details = wrangler(["versions", "view", versionId, "--config", config, "--env", environment, "--json"]);
          const parsed = details.status === 0 ? safeJson(details.stdout) : undefined;
          remote.deployedVersionsChecked += 1;
          if (!parsed) {
            issue("blocker", "WORKER_VERSION_UNREADABLE", `${expectedWorkerName} has an unreadable active version.`);
            continue;
          }
          const mismatches = deployedVersionMismatches(parsed, expectedVersionResources(kind));
          if (mismatches.length > 0) {
            for (const mismatch of mismatches) issue("blocker", "WORKER_VERSION_MISMATCH", `${expectedWorkerName}: ${mismatch}.`);
          } else remote.deployedVersionsMatching += 1;
          if (parsed.annotations?.["workers/message"] !== `unijam-release:${gitSha}`) {
            issue("blocker", "WORKER_RELEASE_IDENTITY", `${expectedWorkerName} active version is not bound to commit ${gitSha}.`);
          } else if (versionIds.length === 1) {
            remote.candidate[kind === "web" ? "webVersionId" : "connectorVersionId"] = versionId;
          }
        }
      }
    }

    const webSecrets = namesFromSecretList(wrangler(["secret", "list", "--config", "wrangler.jsonc", "--env", environment]));
    const connectorSecrets = namesFromSecretList(wrangler(["secret", "list", "--config", "wrangler.connectors.jsonc", "--env", environment]));
    const requiredWebSecrets = ["CONNECTOR_SERVICE_TOKEN"];
    const requiredConnectorSecrets = ["CONNECTOR_SHARED_SECRET", "CONNECTOR_OPERATOR_SECRET", "TOKEN_ENCRYPTION_KEY_B64URL", "TOKEN_KEY_VERSION"];
    if (requiresProvider("spotify") || connector.vars.SPOTIFY_ENABLED === "true" || connector.vars.SPOTIFY_PUBLISHING_ENABLED === "true") requiredConnectorSecrets.push("SPOTIFY_CLIENT_ID");
    if (requiresProvider("apple-music") || connector.vars.APPLE_MUSIC_ENABLED === "true" || connector.vars.APPLE_MUSIC_PUBLISHING_ENABLED === "true") {
      requiredConnectorSecrets.push("APPLE_TEAM_ID", "APPLE_KEY_ID", "APPLE_PRIVATE_KEY_JWK");
    }
    assertNames(webSecrets, requiredWebSecrets, "WEB_SECRET_MISSING", `${web.name} secret inventory`);
    assertNames(connectorSecrets, requiredConnectorSecrets, "CONNECTOR_SECRET_MISSING", `${connector.name} secret inventory`);
    remote.requiredSecretsPresent = requiredWebSecrets.filter((name) => webSecrets?.has(name)).length
      + requiredConnectorSecrets.filter((name) => connectorSecrets?.has(name)).length;
  }

  try {
    const response = await fetch(expected.origin, { redirect: "manual", signal: AbortSignal.timeout(8_000) });
    remote.originStatus = response.status;
    remote.customDomainOriginHealthy = configured.customDomain && response.status >= 200 && response.status < 400;
    if (response.status < 200 || response.status >= 400) issue("blocker", "ORIGIN_UNHEALTHY", `${expected.origin} returned HTTP ${response.status}.`);
  } catch {
    issue("blocker", "ORIGIN_UNREACHABLE", `${expected.origin} could not be reached over HTTPS.`);
  }
}

if (offline) issue("warning", "REMOTE_SKIPPED", "Cloudflare inventory, deployments, secrets, and origin health were not checked.");
for (const [provider, providerSlug, allowlistName] of [
  ["Spotify", "spotify", "SPOTIFY_PILOT_ACCOUNT_ALLOWLIST"],
  ["Apple Music", "apple-music", "APPLE_MUSIC_PILOT_ACCOUNT_ALLOWLIST"],
]) {
  if ((connector.vars[allowlistName] ?? "").trim() === "") {
    issue(
      requiresProvider(providerSlug) ? "blocker" : "warning",
      "PILOT_ALLOWLIST_EMPTY",
      `${environment} has no ${provider} pilot account IDs configured; this is correct only while that provider is closed.`,
    );
  }
}

const blockers = issues.filter((entry) => entry.severity === "blocker");
const report = {
  version: 1,
  generatedAt: new Date().toISOString(),
  environment,
  requiredProvider: requiredProvider ?? null,
  commit: gitSha,
  clean,
  node: process.versions.node,
  expected,
  configured,
  remote,
  candidate: typeof remote.candidate.webVersionId === "string" && typeof remote.candidate.connectorVersionId === "string"
    ? remote.candidate
    : null,
  ready: blockers.length === 0,
  blockers: blockers.length,
  warnings: issues.filter((entry) => entry.severity === "warning").length,
  issues,
};

if (jsonOutput) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`UniJam ${environment} pilot preflight for ${gitSha}`);
  for (const entry of issues) console.log(`${entry.severity.toUpperCase()} ${entry.code}: ${entry.message}`);
  console.log(report.ready ? "READY: all automated preflight gates passed." : `BLOCKED: ${report.blockers} release blocker(s) remain.`);
}

if (!report.ready) process.exitCode = 1;
