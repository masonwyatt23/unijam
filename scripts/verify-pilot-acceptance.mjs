#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const STAGING_ORIGIN = "https://staging.unijam.ashlr.ai";
const MAX_EVIDENCE_AGE_MS = 7 * 24 * 60 * 60_000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const COMMIT = /^[a-f0-9]{40}$/;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function timestamp(value, label) {
  const parsed = Date.parse(value);
  requireValue(Number.isFinite(parsed), `${label} must be an ISO timestamp`);
  return parsed;
}

function checkCandidateReference(value, candidate, label) {
  requireValue(value?.commit === candidate.commit, `${label} commit does not match the Cloudflare candidate`);
  requireValue(value?.webVersionId === candidate.workers.web.versionId, `${label} web version does not match the Cloudflare candidate`);
  requireValue(value?.connectorVersionId === candidate.workers.connectors.versionId, `${label} connector version does not match the Cloudflare candidate`);
}

function checkManualEvidence(value, kind, candidate, fields) {
  requireValue(value?.schemaVersion === 1 && value?.kind === kind, `${kind} evidence has the wrong schema`);
  requireValue(value.targetOrigin === STAGING_ORIGIN, `${kind} evidence must target staging`);
  requireValue(value.passed === true, `${kind} evidence is not marked passed`);
  checkCandidateReference(value.candidate, candidate, kind);
  requireValue(typeof value.operator === "string" && value.operator.trim().length >= 3, `${kind} evidence requires an accountable operator`);
  requireValue(!/(?:todo|tbd|example|unknown|placeholder)/i.test(value.operator), `${kind} operator is a placeholder`);
  for (const field of fields) requireValue(value.checks?.[field] === true, `${kind} check ${field} has not passed`);
  return timestamp(value.completedAt, `${kind} completedAt`);
}

export function validateEvidenceBundle(bundle, nowMs = Date.now()) {
  const { candidate, preflight, hibernation, smoke, soak, providers, accessibility, telemetry, rollback } = bundle;
  requireValue(candidate?.schemaVersion === 1 && candidate?.kind === "unijam-cloudflare-candidate", "Candidate evidence has the wrong schema");
  requireValue(candidate.environment === "staging" && candidate.origin === STAGING_ORIGIN, "Pilot acceptance is staging-only");
  requireValue(COMMIT.test(candidate.commit) && candidate.clean === true && candidate.passed === true, "Candidate must identify one clean passing commit");
  for (const [kind, worker] of Object.entries(candidate.workers ?? {})) {
    requireValue(["web", "connectors"].includes(kind), `Unexpected candidate Worker ${kind}`);
    requireValue(UUID.test(worker.versionId) && UUID.test(worker.deploymentId), `${kind} candidate version identity is malformed`);
    requireValue(worker.percentage === 100, `${kind} candidate is not serving 100 percent of traffic`);
    requireValue(worker.releaseMessage === `unijam-release:${candidate.commit}`, `${kind} candidate is not commit-bound`);
  }
  requireValue(Object.keys(candidate.workers ?? {}).length === 2, "Candidate must bind exactly the web and connector Workers");

  const deployedAt = Math.max(
    timestamp(candidate.workers.web.createdAt, "web createdAt"),
    timestamp(candidate.workers.connectors.createdAt, "connector createdAt"),
  );
  const capturedAt = timestamp(candidate.capturedAt, "candidate capturedAt");
  requireValue(capturedAt >= deployedAt, "Candidate capture predates its Worker versions");
  requireValue(capturedAt <= nowMs + 5 * 60_000 && nowMs - capturedAt <= MAX_EVIDENCE_AGE_MS, "Candidate capture is stale or in the future");

  requireValue(preflight?.version === 1 && preflight.environment === "staging", "Preflight evidence has the wrong environment or schema");
  requireValue(preflight.commit === candidate.commit && preflight.clean === true && preflight.ready === true, "Preflight does not approve the candidate commit");
  requireValue(preflight.expected?.origin === STAGING_ORIGIN, "Preflight did not check the exact staging origin");
  requireValue(preflight.remote?.checked === true && preflight.remote?.authenticated === true, "Preflight did not inspect authenticated remote state");
  for (const [field, minimum] of Object.entries({
    databasesPresent: 2,
    queuesPresent: 4,
    workersWithDeployments: 2,
    deployedVersionsChecked: 2,
    deployedVersionsMatching: 2,
    databasesWithNoPendingMigrations: 2,
  })) requireValue(preflight.remote?.[field] >= minimum, `Preflight remote gate ${field} is incomplete`);
  requireValue(preflight.remote?.customDomainOriginHealthy === true, "Preflight did not prove custom-domain health");
  const evidenceTimes = [timestamp(preflight.generatedAt, "preflight generatedAt")];

  requireValue(hibernation?.schemaVersion === 1 && hibernation?.kind === "unijam-room-hibernation-assurance", "Hibernation evidence has the wrong schema");
  requireValue(hibernation.targetOrigin === STAGING_ORIGIN && hibernation.passed === true, "Hibernation evidence did not pass against staging");
  requireValue(hibernation.idleWindow?.requestedSeconds >= 12, "Hibernation evidence lacks a hibernation-eligible idle window");
  requireValue(hibernation.idleWindow?.hostConnectionResumedWithoutReconnect === true, "Host socket did not resume after idle");
  requireValue(hibernation.idleWindow?.guestConnectionResumedWithoutReconnect === true, "Guest socket did not resume after idle");
  requireValue(hibernation.guestRevocation?.existingSocketCloseCode === 1008 && hibernation.guestRevocation?.revokedCookieUpgradeStatus === 401, "Guest revocation evidence is incomplete");
  requireValue(hibernation.hostRevocation?.existingSocketCloseCode === 1008 && hibernation.hostRevocation?.revokedCookieUpgradeStatus === 401, "Host revocation evidence is incomplete");
  evidenceTimes.push(timestamp(hibernation.completedAt, "hibernation completedAt"));

  for (const [label, report, expected] of [
    ["smoke", smoke, { profile: "smoke", rooms: 10, connections: 200, minimumDurationMs: 1 }],
    ["soak", soak, { profile: "soak", rooms: 1, connections: 25, minimumDurationMs: 60 * 60_000 }],
  ]) {
    requireValue(report?.version === 1 && report.profile === expected.profile, `${label} load evidence has the wrong schema or profile`);
    requireValue(report.target === STAGING_ORIGIN && report.production === false, `${label} load evidence must target staging`);
    requireValue(report.rooms === expected.rooms && report.connections === expected.connections, `${label} load topology is incomplete`);
    requireValue(report.durationMs >= expected.minimumDurationMs, `${label} load duration is incomplete`);
    requireValue(report.measurements?.projectionRequired === true && report.measurements?.projectionCount > 0, `${label} load did not measure D1 projection lag`);
    requireValue(report.thresholds?.ackP95Ms <= 250 && report.thresholds?.reconnectP95Ms <= 2_000 && report.thresholds?.projectionP95Ms <= 5_000, `${label} load thresholds are weaker than release policy`);
    requireValue(report.passed === true && Object.values(report.gates ?? {}).length >= 8 && Object.values(report.gates).every(Boolean), `${label} load gates did not all pass`);
    evidenceTimes.push(timestamp(report.finishedAt, `${label} finishedAt`));
  }

  requireValue(providers?.schemaVersion === 1 && providers?.kind === "unijam-mixed-provider-assurance", "Provider evidence has the wrong schema");
  requireValue(providers.targetOrigin === STAGING_ORIGIN && providers.passed === true, "Provider evidence did not pass against staging");
  checkCandidateReference(providers.candidate, candidate, providers.kind);
  requireValue(typeof providers.operator === "string" && providers.operator.trim().length >= 3, "Provider evidence requires an accountable operator");
  for (const provider of ["spotify", "appleMusic"]) {
    for (const field of [
      "connectionAuthorized", "usCatalogResolved", "nativeHandoffOpenedAndHostConfirmed", "privatePlaylistPublished",
      "disconnectPurged", "failureDidNotBlockRoom", "peerProviderRemainedOperational", "zeroDuplicateMutations",
    ]) requireValue(providers.providers?.[provider]?.[field] === true, `${provider} assurance ${field} has not passed`);
  }
  evidenceTimes.push(timestamp(providers.completedAt, "provider assurance completedAt"));

  evidenceTimes.push(checkManualEvidence(accessibility, "unijam-manual-accessibility-assurance", candidate, [
    "voiceOverSafari", "nvdaChrome", "keyboardCompletion", "zoom200", "zoom400", "reducedMotion",
    "forcedColors", "touchTargets", "zeroSeriousCriticalAxe",
  ]));
  evidenceTimes.push(checkManualEvidence(telemetry, "unijam-telemetry-assurance", candidate, [
    "webLogs", "connectorLogs", "queueBacklogObserved", "dlqObserved", "alertsConfigured",
    "providerKillSwitchesVerified", "secretAndCapabilityRedactionReviewed",
  ]));
  evidenceTimes.push(checkManualEvidence(rollback, "unijam-rollback-assurance", candidate, [
    "priorWebVersionCaptured", "priorConnectorVersionCaptured", "stagingRollbackRehearsed", "durableObjectNamespacePreserved",
    "d1RestoreNotUsedAsAppRollback", "dualAuthorityCompatibilityConfirmed",
  ]));

  for (const observedAt of evidenceTimes) {
    requireValue(observedAt >= deployedAt, "Acceptance evidence predates one or both candidate Worker versions");
    requireValue(observedAt <= capturedAt + 5 * 60_000, "Acceptance evidence was captured after the final active-version capture");
    requireValue(nowMs - observedAt <= MAX_EVIDENCE_AGE_MS, "Acceptance evidence is older than seven days");
  }

  return {
    schemaVersion: 1,
    kind: "unijam-pilot-acceptance-verdict",
    candidateCommit: candidate.commit,
    webVersionId: candidate.workers.web.versionId,
    connectorVersionId: candidate.workers.connectors.versionId,
    verifiedAt: new Date(nowMs).toISOString(),
    gates: {
      cloudflareCandidate: true,
      remotePreflight: true,
      roomHibernationAndRevocation: true,
      loadSmoke: true,
      loadSoak: true,
      spotifyAndAppleMusic: true,
      accessibility: true,
      telemetry: true,
      rollback: true,
    },
    readyForProductionBaseline: true,
    publicLaunchApproved: false,
    publicLaunchNote: "Spotify quota approval and owner production authorization remain independent external gates.",
  };
}

async function readPrivateJson(path, label) {
  const metadata = await stat(path);
  requireValue(metadata.isFile(), `${label} is not a file`);
  requireValue((metadata.mode & 0o077) === 0, `${label} must not be readable or writable by group or others`);
  requireValue(metadata.size > 0 && metadata.size <= 2 * 1024 * 1024, `${label} must be between 1 byte and 2 MiB`);
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { throw new Error(`${label} is not valid JSON`); }
}

async function main() {
  const argv = process.argv.slice(2);
  const manifestFlag = argv.indexOf("--manifest");
  const outputFlag = argv.indexOf("--output");
  if (manifestFlag === -1 || !argv[manifestFlag + 1]) {
    throw new Error("Usage: node scripts/verify-pilot-acceptance.mjs --manifest <private.json> [--output path]");
  }
  const manifestPath = resolve(argv[manifestFlag + 1]);
  const manifest = await readPrivateJson(manifestPath, "Acceptance manifest");
  requireValue(manifest?.schemaVersion === 1 && manifest?.kind === "unijam-pilot-acceptance-manifest", "Acceptance manifest has the wrong schema");
  const allowed = ["candidate", "preflight", "hibernation", "smoke", "soak", "providers", "accessibility", "telemetry", "rollback"];
  requireValue(Object.keys(manifest.evidence ?? {}).length === allowed.length, "Acceptance manifest must reference exactly nine evidence files");
  const base = dirname(manifestPath);
  const bundle = {};
  for (const name of allowed) {
    const reference = manifest.evidence?.[name];
    requireValue(typeof reference === "string" && reference.length > 0 && reference.length <= 512, `Acceptance manifest is missing ${name}`);
    bundle[name] = await readPrivateJson(resolve(base, reference), `${name} evidence`);
  }
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim();
  requireValue(dirty === "", "Pilot acceptance requires a clean worktree");
  requireValue(bundle.candidate.commit === commit, "Pilot evidence does not belong to the checked-out commit");
  const verdict = validateEvidenceBundle(bundle);
  const output = resolve(outputFlag === -1 ? `test-results/release/pilot-acceptance-${commit.slice(0, 12)}.json` : argv[outputFlag + 1]);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(verdict, null, 2)}\n`, { mode: 0o600 });
  await chmod(output, 0o600);
  process.stdout.write(`${JSON.stringify({ passed: true, candidateCommit: commit, output, publicLaunchApproved: false }, null, 2)}\n`);
}

const isDirectExecution = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectExecution) {
  main().catch((error) => {
    process.stderr.write(`Pilot acceptance blocked: ${error instanceof Error ? error.message : "Unknown error"}\n`);
    process.exitCode = 1;
  });
}
