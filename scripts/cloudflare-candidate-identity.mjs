import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const RELEASE_PREFIX = "unijam-release:";
const COMMIT = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

function command(commandName, args) {
  return spawnSync(commandName, args, { cwd: root, encoding: "utf8", env: process.env });
}

function jsonCommand(commandName, args, label) {
  const result = command(commandName, args);
  if (result.status !== 0) throw new Error(`${label} failed`);
  try { return JSON.parse(result.stdout); }
  catch { throw new Error(`${label} did not return JSON`); }
}

function readJsonc(source) {
  return JSON.parse(source.replace(/^\s*\/\/.*$/gm, ""));
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

export function candidateReference(candidate) {
  return {
    commit: candidate.commit,
    webVersionId: candidate.workers.web.versionId,
    connectorVersionId: candidate.workers.connectors.versionId,
  };
}

export function validateCandidateReference(value, label = "candidate") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} identity is missing`);
  if (!COMMIT.test(value.commit ?? "")) throw new Error(`${label} commit is malformed`);
  if (!UUID.test(value.webVersionId ?? "") || !UUID.test(value.connectorVersionId ?? "")) {
    throw new Error(`${label} Worker version identity is malformed`);
  }
  return { commit: value.commit, webVersionId: value.webVersionId, connectorVersionId: value.connectorVersionId };
}

export function assertCandidateReference(actual, expected, label = "candidate") {
  const validated = validateCandidateReference(actual, label);
  if (
    validated.commit !== expected.commit || validated.webVersionId !== expected.webVersionId ||
    validated.connectorVersionId !== expected.connectorVersionId
  ) throw new Error(`${label} does not match the active Cloudflare candidate`);
  return validated;
}

export function isMissingWorkerResult(result, expectedWorker) {
  const combined = `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`;
  return result?.status !== 0 && combined.includes("code: 10007") && combined.includes("This Worker does not exist") && combined.includes(expectedWorker);
}

async function operatorIngressState(environment) {
  const [configSource, source] = await Promise.all([
    readFile(resolve(root, "operator-ingress/wrangler.jsonc"), "utf8"),
    readFile(resolve(root, "operator-ingress/src/index.ts"), "utf8"),
  ]);
  const config = readJsonc(configSource);
  const selected = config.env?.[environment];
  const expectedWorker = `unijam-operator-ingress-${environment}`;
  if (
    selected?.name !== expectedWorker || selected?.workers_dev !== false || selected?.preview_urls !== false ||
    selected?.vars?.ACCESS_TEAM_DOMAIN !== "" || selected?.vars?.ACCESS_AUD !== ""
  ) throw new Error(`${expectedWorker} is not configured as the closed, undeployed pilot baseline`);
  if (!source.includes("ACCESS_NOT_CONFIGURED") || !source.includes("Cf-Access-Jwt-Assertion")) {
    throw new Error(`${expectedWorker} source does not retain the fail-closed Access guard`);
  }
  const deployment = command("npx", [
    "--no-install", "wrangler", "deployments", "status", "--config", "operator-ingress/wrangler.jsonc", "--env", environment, "--json",
  ]);
  if (deployment.status === 0) throw new Error(`${expectedWorker} is deployed before Access activation`);
  if (!isMissingWorkerResult(deployment, expectedWorker)) {
    throw new Error(`${expectedWorker} undeployed state could not be distinguished from a Cloudflare API failure`);
  }
  return {
    policy: "must-remain-undeployed-until-access-activation",
    worker: expectedWorker,
    deployed: false,
    publicAliasesDisabled: true,
    accessConfigurationClosed: true,
    runtimeFailClosed: true,
    checkedAt: new Date().toISOString(),
  };
}

export async function queryActiveCandidate({ environment, expectedCommit, expectedCandidate, requireClean = true, requireOperatorUndeployed = true }) {
  if (!["staging", "production"].includes(environment)) throw new Error("Cloudflare candidate environment must be staging or production");
  const status = command("git", ["status", "--porcelain"]);
  if (requireClean && (status.status !== 0 || status.stdout.trim() !== "")) throw new Error("Candidate query requires a clean worktree");
  const commit = command("git", ["rev-parse", "HEAD"]).stdout.trim();
  if (!COMMIT.test(commit)) throw new Error("Could not resolve the candidate commit");
  if (expectedCommit && commit !== expectedCommit) throw new Error("Checked-out commit does not match the expected candidate");
  const configs = [
    { kind: "web", path: "wrangler.jsonc", worker: `unijam-web-${environment}` },
    { kind: "connectors", path: "wrangler.connectors.jsonc", worker: `unijam-connectors-${environment}` },
  ];
  const workers = {};
  for (const config of configs) {
    const deployment = jsonCommand("npx", [
      "--no-install", "wrangler", "deployments", "status", "--config", config.path, "--env", environment, "--json",
    ], `${config.worker} deployment lookup`);
    const active = deployment.versions?.filter((entry) => Number(entry?.percentage) > 0) ?? [];
    if (active.length !== 1) throw new Error(`${config.worker} must have exactly one active version`);
    const version = jsonCommand("npx", [
      "--no-install", "wrangler", "versions", "view", active[0].version_id, "--config", config.path, "--env", environment, "--json",
    ], `${config.worker} version lookup`);
    workers[config.kind] = validateActiveDeployment(deployment, version, commit, config.worker);
  }
  const origin = environment === "production" ? "https://unijam.ashlr.ai" : "https://staging.unijam.ashlr.ai";
  const candidate = {
    schemaVersion: 2,
    kind: "unijam-cloudflare-candidate",
    environment,
    origin,
    commit,
    capturedAt: new Date().toISOString(),
    clean: requireClean,
    workers,
    ...(requireOperatorUndeployed ? { operatorIngress: await operatorIngressState(environment) } : {}),
    passed: true,
  };
  if (expectedCandidate) assertCandidateReference(candidateReference(candidate), expectedCandidate, "Active Cloudflare candidate");
  return candidate;
}

function validateObservedCandidate(candidate, environment, label) {
  if (
    candidate?.schemaVersion !== 2 || candidate?.kind !== "unijam-cloudflare-candidate" || candidate?.environment !== environment ||
    candidate?.origin !== (environment === "production" ? "https://unijam.ashlr.ai" : "https://staging.unijam.ashlr.ai") ||
    candidate?.passed !== true || !Number.isFinite(Date.parse(candidate?.capturedAt))
  ) throw new Error(`${label} is not a complete active-candidate observation`);
  const reference = candidateReference(candidate);
  for (const [kind, worker] of [["web", candidate.workers?.web], ["connectors", candidate.workers?.connectors]]) {
    if (
      worker?.percentage !== 100 || worker?.versionId !== reference[`${kind === "web" ? "web" : "connector"}VersionId`] ||
      worker?.releaseMessage !== `${RELEASE_PREFIX}${reference.commit}` || !UUID.test(worker?.deploymentId ?? "")
    ) throw new Error(`${label} ${kind} deployment identity is incomplete`);
  }
  if (
    candidate.operatorIngress?.policy !== "must-remain-undeployed-until-access-activation" ||
    candidate.operatorIngress?.deployed !== false || candidate.operatorIngress?.runtimeFailClosed !== true ||
    candidate.operatorIngress?.accessConfigurationClosed !== true
  ) throw new Error(`${label} does not prove the operator ingress is undeployed and fail-closed`);
  return reference;
}

export function assertCandidateWindow(before, after, expected, label = "measured run") {
  const environment = before?.environment;
  if (!["staging", "production"].includes(environment) || after?.environment !== environment) {
    throw new Error(`${label} candidate environment is missing or changed`);
  }
  const beforeReference = validateObservedCandidate(before, environment, `${label} pre-run candidate`);
  const afterReference = validateObservedCandidate(after, environment, `${label} post-run candidate`);
  assertCandidateReference(beforeReference, expected, `${label} pre-run candidate`);
  assertCandidateReference(afterReference, expected, `${label} post-run candidate`);
  if (
    beforeReference.commit !== afterReference.commit || beforeReference.webVersionId !== afterReference.webVersionId ||
    beforeReference.connectorVersionId !== afterReference.connectorVersionId
  ) throw new Error(`${label} crossed a Cloudflare deployment change`);
  return {
    before: { ...beforeReference, capturedAt: before.capturedAt },
    after: { ...afterReference, capturedAt: after.capturedAt },
  };
}
