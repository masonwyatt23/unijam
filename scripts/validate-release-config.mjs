#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const args = new Set(process.argv.slice(2));
const requireProvisioned = args.has("--require-provisioned");
const jsonOutput = args.has("--json");
const selectedEnvironment = process.argv.includes("--env")
  ? process.argv[process.argv.indexOf("--env") + 1]
  : "all";

if (!["all", "staging", "production"].includes(selectedEnvironment)) {
  throw new Error("--env must be all, staging, or production");
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

async function readJsonc(relativePath) {
  return JSON.parse(stripJsonComments(await readFile(resolve(root, relativePath), "utf8")));
}

const issues = [];
function issue(severity, code, message) {
  issues.push({ severity, code, message });
}
function expectValue(actual, expected, code, label) {
  if (actual !== expected) issue("error", code, `${label} must be ${JSON.stringify(expected)}; found ${JSON.stringify(actual)}`);
}

function onlyBinding(collection, binding, label, key = "binding") {
  const matches = (collection ?? []).filter((entry) => entry[key] === binding);
  if (matches.length !== 1) {
    issue("error", "BINDING_CARDINALITY", `${label} must define exactly one ${binding} binding`);
    return undefined;
  }
  return matches[0];
}

function isSentinel(id) {
  return /^00000000-0000-4000-8000-0000000000[0-9a-f]{2}$/i.test(id ?? "");
}

function validateMigrations(files, label) {
  const migrations = files.filter((file) => /^\d{4}.*\.sql$/.test(file)).sort();
  if (migrations.length === 0) return issue("error", "MIGRATIONS_MISSING", `${label} has no SQL migrations`);
  const prefixes = migrations.map((file) => file.slice(0, 4));
  if (new Set(prefixes).size !== prefixes.length) issue("error", "MIGRATION_PREFIX_DUPLICATE", `${label} has duplicate migration prefixes`);
  for (let index = 1; index < prefixes.length; index += 1) {
    if (Number(prefixes[index]) <= Number(prefixes[index - 1])) {
      issue("error", "MIGRATION_ORDER", `${label} migrations are not strictly ordered`);
    }
  }
}

const [web, connector, webMigrationFiles, connectorMigrationFiles] = await Promise.all([
  readJsonc("wrangler.jsonc"),
  readJsonc("wrangler.connectors.jsonc"),
  readdir(resolve(root, "drizzle")),
  readdir(resolve(root, "connectors/migrations")),
]);

validateMigrations(webMigrationFiles, "web D1");
validateMigrations(connectorMigrationFiles, "connector D1");

const environments = selectedEnvironment === "all" ? ["staging", "production"] : [selectedEnvironment];
const resourceIds = new Map();
const queueNames = new Map();

for (const environment of environments) {
  const webEnv = web.env?.[environment];
  const connectorEnv = connector.env?.[environment];
  if (!webEnv || !connectorEnv) {
    issue("error", "ENVIRONMENT_MISSING", `Both Wrangler files must define ${environment}`);
    continue;
  }

  const production = environment === "production";
  const origin = production ? "https://unijam.ashlr.ai" : "https://staging.unijam.ashlr.ai";
  const host = production ? "unijam.ashlr.ai" : "staging.unijam.ashlr.ai";
  expectValue(webEnv.name, `unijam-web-${environment}`, "WORKER_NAME", `${environment} web Worker name`);
  expectValue(connectorEnv.name, `unijam-connectors-${environment}`, "WORKER_NAME", `${environment} connector Worker name`);
  expectValue(webEnv.routes?.[0]?.pattern, host, "CUSTOM_DOMAIN", `${environment} custom domain`);
  expectValue(webEnv.routes?.[0]?.custom_domain, true, "CUSTOM_DOMAIN", `${environment} route custom_domain`);
  expectValue(webEnv.vars?.APP_ENV, environment, "APP_ENV", `${environment} APP_ENV`);
  expectValue(webEnv.vars?.APP_ORIGIN, origin, "APP_ORIGIN", `${environment} APP_ORIGIN`);
  expectValue(webEnv.vars?.WEBAUTHN_RP_ID, host, "WEBAUTHN_RP", `${environment} WebAuthn RP ID`);
  expectValue(webEnv.vars?.ENABLE_LEGACY_ROOM_API, "false", "LEGACY_API", `${environment} legacy API default`);
  expectValue(connectorEnv.vars?.PUBLIC_APP_ORIGIN, origin, "CONNECTOR_ORIGIN", `${environment} connector origin`);

  for (const flag of ["SPOTIFY_ENABLED", "APPLE_MUSIC_ENABLED", "SPOTIFY_PUBLISHING_ENABLED", "APPLE_MUSIC_PUBLISHING_ENABLED"]) {
    if (!["true", "false"].includes(connectorEnv.vars?.[flag])) {
      issue("error", "FEATURE_FLAG_VALUE", `${environment} ${flag} must be the string true or false`);
    }
    if (connectorEnv.vars?.[flag] !== "false") {
      issue("warning", "FEATURE_FLAG_OPEN", `${environment} ${flag} is committed open; initial deployments must be closed`);
    }
  }

  const webDatabase = onlyBinding(webEnv.d1_databases, "DB", `${environment} web D1`);
  const connectorDatabase = onlyBinding(connectorEnv.d1_databases, "CONNECTOR_DB", `${environment} connector D1`);
  for (const [database, expectedName, label] of [
    [webDatabase, `unijam-${environment}`, `${environment} web D1`],
    [connectorDatabase, `unijam-connectors-${environment}`, `${environment} connector D1`],
  ]) {
    if (!database) continue;
    expectValue(database.database_name, expectedName, "DATABASE_NAME", `${label} name`);
    expectValue(database.migrations_dir, label.includes("connector") ? "connectors/migrations" : "drizzle", "MIGRATIONS_DIR", `${label} migrations directory`);
    if (isSentinel(database.database_id)) {
      issue(requireProvisioned ? "error" : "warning", "D1_SENTINEL", `${label} still uses sentinel ${database.database_id}`);
    } else if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(database.database_id ?? "")) {
      issue("error", "D1_ID", `${label} does not have a valid D1 database UUID`);
    }
    const prior = resourceIds.get(database.database_id);
    if (prior) issue("error", "RESOURCE_REUSE", `${label} reuses the D1 ID assigned to ${prior}`);
    resourceIds.set(database.database_id, label);
  }

  const service = onlyBinding(webEnv.services, "CONNECTORS", `${environment} connector service`);
  expectValue(service?.service, `unijam-connectors-${environment}`, "SERVICE_BINDING", `${environment} CONNECTORS service`);

  const roomDo = onlyBinding(webEnv.durable_objects?.bindings, "ROOM_OBJECTS", `${environment} room Durable Object`, "name");
  expectValue(roomDo?.class_name, "RoomDurableObject", "DO_CLASS", `${environment} Room Durable Object class`);

  const projectionProducer = onlyBinding(webEnv.queues?.producers, "ROOM_PROJECTION_QUEUE", `${environment} projection producer`);
  const publishProducer = onlyBinding(connectorEnv.queues?.producers, "PUBLISH_QUEUE", `${environment} publishing producer`);
  const queueExpectations = [
    [projectionProducer?.queue, `unijam-room-projection-${environment}`, `${environment} projection queue`],
    [webEnv.queues?.consumers?.[0]?.dead_letter_queue, `unijam-room-projection-${environment}-dlq`, `${environment} projection DLQ`],
    [publishProducer?.queue, `unijam-publishing-${environment}`, `${environment} publish queue`],
    [connectorEnv.queues?.consumers?.[0]?.dead_letter_queue, `unijam-publishing-${environment}-dlq`, `${environment} publish DLQ`],
  ];
  for (const [actual, expected, label] of queueExpectations) {
    expectValue(actual, expected, "QUEUE_NAME", label);
    const prior = queueNames.get(actual);
    if (actual && prior) issue("error", "QUEUE_REUSE", `${label} reuses the queue assigned to ${prior}`);
    if (actual) queueNames.set(actual, label);
  }
}

const forbiddenWebSecrets = [
  "CONNECTOR_SHARED_SECRET", "CONNECTOR_OPERATOR_SECRET", "TOKEN_ENCRYPTION_KEY_B64URL", "TOKEN_KEY_VERSION", "SPOTIFY_CLIENT_ID",
  "APPLE_TEAM_ID", "APPLE_KEY_ID", "APPLE_PRIVATE_KEY_JWK",
];
const webText = JSON.stringify(web);
for (const secret of forbiddenWebSecrets) {
  if (webText.includes(secret)) issue("error", "SECRET_BOUNDARY", `${secret} must not be configured on the web Worker`);
}

const actionReferences = [
  [".github/workflows/ci.yml", await readFile(resolve(root, ".github/workflows/ci.yml"), "utf8")],
  [".github/workflows/security.yml", await readFile(resolve(root, ".github/workflows/security.yml"), "utf8")],
];
for (const [file, source] of actionReferences) {
  for (const match of source.matchAll(/uses:\s*([^\s#]+)/g)) {
    const reference = match[1];
    if (!/@[0-9a-f]{40}$/.test(reference)) issue("error", "UNPINNED_ACTION", `${file} contains unpinned action ${reference}`);
  }
}

const errors = issues.filter((entry) => entry.severity === "error");
const result = {
  ok: errors.length === 0,
  mode: requireProvisioned ? "deploy" : "repository",
  environments,
  errors: errors.length,
  warnings: issues.filter((entry) => entry.severity === "warning").length,
  issues,
};

if (jsonOutput) console.log(JSON.stringify(result, null, 2));
else {
  for (const entry of issues) console.log(`${entry.severity.toUpperCase()} ${entry.code}: ${entry.message}`);
  console.log(`Release configuration ${result.ok ? "is structurally valid" : "is invalid"}: ${result.errors} error(s), ${result.warnings} warning(s).`);
}
if (!result.ok) process.exitCode = 1;
