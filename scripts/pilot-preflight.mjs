#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const environment = valueAfter("--env");
const jsonOutput = argv.includes("--json");
const offline = argv.includes("--offline");

if (!environment || !["staging", "production"].includes(environment)) {
  console.error("Usage: node scripts/pilot-preflight.mjs --env staging|production [--json] [--offline]");
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
  requiredSecretsPresent: 0,
  originStatus: null,
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

    const queueResult = wrangler(["queues", "list"]);
    if (queueResult.status !== 0) {
      issue("blocker", "QUEUE_INVENTORY_UNREADABLE", `${environment} Queue inventory could not be read.`);
    } else {
      remote.queuesPresent = expected.queues.filter((name) => queueResult.stdout.includes(name)).length;
      for (const name of expected.queues) {
        if (!queueResult.stdout.includes(name)) issue("blocker", "QUEUE_MISSING", `${environment} Queue inventory is missing ${name}.`);
      }
    }

    for (const [config, workerName] of [["wrangler.jsonc", web.name], ["wrangler.connectors.jsonc", connector.name]]) {
      const deployments = wrangler(["deployments", "list", "--config", config, "--env", environment, "--name", workerName, "--json"]);
      const parsed = safeJson(deployments.stdout);
      if (deployments.status !== 0 || !Array.isArray(parsed) || parsed.length === 0) {
        issue("blocker", "WORKER_NOT_DEPLOYED", `${workerName} has no readable deployment.`);
      } else {
        remote.workersWithDeployments += 1;
      }
    }

    const webSecrets = namesFromSecretList(wrangler(["secret", "list", "--config", "wrangler.jsonc", "--env", environment, "--name", web.name]));
    const connectorSecrets = namesFromSecretList(wrangler(["secret", "list", "--config", "wrangler.connectors.jsonc", "--env", environment, "--name", connector.name]));
    const requiredWebSecrets = ["CONNECTOR_SERVICE_TOKEN"];
    const requiredConnectorSecrets = ["CONNECTOR_SHARED_SECRET", "CONNECTOR_OPERATOR_SECRET", "TOKEN_ENCRYPTION_KEY_B64URL", "TOKEN_KEY_VERSION"];
    if (connector.vars.SPOTIFY_ENABLED === "true" || connector.vars.SPOTIFY_PUBLISHING_ENABLED === "true") requiredConnectorSecrets.push("SPOTIFY_CLIENT_ID");
    if (connector.vars.APPLE_MUSIC_ENABLED === "true" || connector.vars.APPLE_MUSIC_PUBLISHING_ENABLED === "true") {
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
    if (response.status < 200 || response.status >= 400) issue("blocker", "ORIGIN_UNHEALTHY", `${expected.origin} returned HTTP ${response.status}.`);
  } catch {
    issue("blocker", "ORIGIN_UNREACHABLE", `${expected.origin} could not be reached over HTTPS.`);
  }
}

if (offline) issue("warning", "REMOTE_SKIPPED", "Cloudflare inventory, deployments, secrets, and origin health were not checked.");
if ((connector.vars.PILOT_ACCOUNT_ALLOWLIST ?? "").trim() === "") {
  issue("warning", "PILOT_ALLOWLIST_EMPTY", `${environment} has no pilot account IDs configured; this is correct only for the closed baseline.`);
}

const blockers = issues.filter((entry) => entry.severity === "blocker");
const report = {
  version: 1,
  generatedAt: new Date().toISOString(),
  environment,
  commit: gitSha,
  clean,
  node: process.versions.node,
  expected,
  remote,
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
