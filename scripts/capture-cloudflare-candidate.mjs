#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const RELEASE_PREFIX = "unijam-release:";

function command(commandName, args) {
  return spawnSync(commandName, args, { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8", env: process.env });
}

function jsonCommand(commandName, args, label) {
  const result = command(commandName, args);
  if (result.status !== 0) throw new Error(`${label} failed`);
  try { return JSON.parse(result.stdout); }
  catch { throw new Error(`${label} did not return JSON`); }
}

export function validateActiveDeployment(deployment, version, commit, label) {
  if (!deployment || typeof deployment !== "object" || !Array.isArray(deployment.versions)) {
    throw new Error(`${label} deployment is unreadable`);
  }
  const active = deployment.versions.filter((entry) => Number(entry?.percentage) > 0);
  if (active.length !== 1 || Number(active[0].percentage) !== 100) {
    throw new Error(`${label} must have exactly one version serving 100 percent of traffic`);
  }
  if (!version || version.id !== active[0].version_id) throw new Error(`${label} active version details do not match its deployment`);
  if (version.annotations?.["workers/message"] !== `${RELEASE_PREFIX}${commit}`) {
    throw new Error(`${label} active version is not bound to candidate ${commit}; redeploy with the checked-in release wrapper`);
  }
  const createdAt = version.metadata?.created_on;
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error(`${label} active version has no valid creation timestamp`);
  return {
    worker: label,
    deploymentId: deployment.id,
    versionId: version.id,
    percentage: 100,
    createdAt,
    releaseMessage: `${RELEASE_PREFIX}${commit}`,
  };
}

function valueAfter(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

async function main() {
  const argv = process.argv.slice(2);
  const environment = valueAfter(argv, "--env");
  if (!["staging", "production"].includes(environment)) {
    throw new Error("Usage: node scripts/capture-cloudflare-candidate.mjs --env staging|production [--output path]");
  }
  const status = command("git", ["status", "--porcelain"]);
  if (status.status !== 0 || status.stdout.trim() !== "") throw new Error("Candidate capture requires a clean worktree");
  const commit = command("git", ["rev-parse", "HEAD"]).stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Could not resolve the candidate commit");

  const configs = [
    { kind: "web", path: "wrangler.jsonc", worker: `unijam-web-${environment}` },
    { kind: "connectors", path: "wrangler.connectors.jsonc", worker: `unijam-connectors-${environment}` },
  ];
  const workers = {};
  for (const config of configs) {
    const baseArgs = ["--no-install", "wrangler"];
    const deployment = jsonCommand("npx", [
      ...baseArgs, "deployments", "status", "--config", config.path, "--env", environment, "--json",
    ], `${config.worker} deployment lookup`);
    const active = deployment.versions?.filter((entry) => Number(entry?.percentage) > 0) ?? [];
    if (active.length !== 1) throw new Error(`${config.worker} must have exactly one active version`);
    const version = jsonCommand("npx", [
      ...baseArgs, "versions", "view", active[0].version_id, "--config", config.path, "--env", environment, "--json",
    ], `${config.worker} version lookup`);
    workers[config.kind] = validateActiveDeployment(deployment, version, commit, config.worker);
  }

  const origin = environment === "production" ? "https://unijam.ashlr.ai" : "https://staging.unijam.ashlr.ai";
  const report = {
    schemaVersion: 1,
    kind: "unijam-cloudflare-candidate",
    environment,
    origin,
    commit,
    capturedAt: new Date().toISOString(),
    clean: true,
    workers,
    passed: true,
  };
  const output = resolve(valueAfter(argv, "--output") ?? `test-results/release/candidate-${environment}-${commit.slice(0, 12)}.json`);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await chmod(output, 0o600);
  process.stdout.write(`${JSON.stringify({ passed: true, environment, commit, output }, null, 2)}\n`);
}

const isDirectExecution = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectExecution) {
  main().catch((error) => {
    process.stderr.write(`Candidate capture failed: ${error instanceof Error ? error.message : "Unknown error"}\n`);
    process.exitCode = 1;
  });
}
