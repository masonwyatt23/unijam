#!/usr/bin/env node

import { spawnSync } from "node:child_process";

import { activeVersionIds } from "./pilot-preflight-helpers.mjs";

const argv = process.argv.slice(2);
const environment = valueAfter("--env");
const provider = valueAfter("--provider");
const dryRun = argv.includes("--dry-run");
const productionConfirmation = valueAfter("--production-confirmation");
const PRODUCTION_CONFIRMATION = "I_UNDERSTAND_THIS_DEPLOYS_A_PRODUCTION_SECRET_VERSION";
const PROVIDER_FLAGS = [
  "SPOTIFY_ENABLED",
  "APPLE_MUSIC_ENABLED",
  "SPOTIFY_PUBLISHING_ENABLED",
  "APPLE_MUSIC_PUBLISHING_ENABLED",
];
const providerSecrets = {
  spotify: "SPOTIFY_PILOT_ACCOUNT_ALLOWLIST",
  "apple-music": "APPLE_MUSIC_PILOT_ACCOUNT_ALLOWLIST",
};

if (!environment || !["staging", "production"].includes(environment) || !provider || !(provider in providerSecrets)) {
  console.error(`Usage: PRIVATE_ID_SOURCE_COMMAND | node scripts/install-provider-allowlist.mjs --provider spotify|apple-music --env staging|production [--dry-run] [--production-confirmation ${PRODUCTION_CONFIRMATION}]`);
  process.exit(2);
}
if (environment === "production" && !dryRun && productionConfirmation !== PRODUCTION_CONFIRMATION) {
  console.error(`Production allowlist installation requires --production-confirmation ${PRODUCTION_CONFIRMATION}`);
  process.exit(2);
}
if (process.stdin.isTTY) {
  console.error("Refusing to accept pilot account IDs as command arguments. Pipe them on stdin.");
  process.exit(2);
}

function valueAfter(flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

const chunks = [];
let size = 0;
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > 2_048) {
    console.error("Pilot allowlist input is unexpectedly large.");
    process.exit(2);
  }
  chunks.push(chunk);
}

const accountIds = Buffer.concat(chunks)
  .toString("utf8")
  .split(/[\s,]+/u)
  .map((value) => value.trim())
  .filter(Boolean);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

if (accountIds.length === 0) {
  console.error("The provider pilot allowlist must contain at least one internal UniJam account ID.");
  process.exit(2);
}
if (accountIds.length > 5) {
  console.error("The provider pilot allowlist exceeds the five-account release limit.");
  process.exit(2);
}
if (new Set(accountIds).size !== accountIds.length) {
  console.error("The provider pilot allowlist contains a duplicate account ID.");
  process.exit(2);
}
if (accountIds.some((accountId) => !uuid.test(accountId))) {
  console.error("Every provider pilot entry must be an internal UniJam UUID account ID.");
  process.exit(2);
}

const secretName = providerSecrets[provider];
if (dryRun) {
  console.log(JSON.stringify({
    ok: true,
    environment,
    provider,
    secretName,
    accountCount: accountIds.length,
    secretInstalled: false,
  }));
  process.exit(0);
}

function wrangler(args) {
  return spawnSync("npx", ["--no-install", "wrangler", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function safeJson(value) {
  try { return JSON.parse(value); }
  catch { return undefined; }
}

function requireClosedActiveProviderFlags() {
  const deployment = wrangler(["deployments", "status", "--config", "wrangler.connectors.jsonc", "--env", environment, "--json"]);
  const versionIds = activeVersionIds(deployment);
  if (!versionIds || versionIds.length !== 1) {
    console.error("Allowlist installation requires exactly one readable active connector version; no secret was changed.");
    process.exit(1);
  }
  const version = wrangler(["versions", "view", versionIds[0], "--config", "wrangler.connectors.jsonc", "--env", environment, "--json"]);
  const bindings = version.status === 0 ? safeJson(version.stdout)?.resources?.bindings : undefined;
  const flagsClosed = Array.isArray(bindings) && PROVIDER_FLAGS.every((name) =>
    bindings.some((binding) => binding?.name === name && binding?.type === "plain_text" && binding?.text === "false"));
  if (!flagsClosed) {
    console.error("All Spotify and Apple Music resolution and publishing flags must be verifiably false on the active connector before a secret write; no secret was changed.");
    process.exit(1);
  }
}

requireClosedActiveProviderFlags();
console.error("Cloudflare will immediately deploy a connector secret version. This invalidates existing release evidence; redeploy both connector and web Workers from the same clean HEAD before preflight.");

const result = spawnSync("npx", [
  "--no-install",
  "wrangler",
  "secret",
  "put",
  secretName,
  "--config",
  "wrangler.connectors.jsonc",
  "--env",
  environment,
], {
  input: `${accountIds.join(",")}\n`,
  encoding: "utf8",
  stdio: ["pipe", "inherit", "inherit"],
});

if (result.status !== 0) process.exit(result.status ?? 1);
console.log(JSON.stringify({
  ok: true,
  environment,
  provider,
  secretName,
  accountCount: accountIds.length,
  secretInstalled: true,
  providerFlagsVerifiedClosed: true,
  releaseCandidateInvalidated: true,
  next: "Redeploy connector and web Workers from the same clean HEAD before preflight.",
}));
