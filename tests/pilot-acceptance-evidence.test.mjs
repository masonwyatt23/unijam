import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  assertCandidateWindow,
  isMissingWorkerResult,
} from "../scripts/cloudflare-candidate-identity.mjs";
import { validateActiveDeployment } from "../scripts/capture-cloudflare-candidate.mjs";
import { createEvidenceSeal, verifyEvidenceSeal } from "../scripts/pilot-evidence-integrity.mjs";
import { validateEvidenceBundle } from "../scripts/verify-pilot-acceptance.mjs";

const commit = "a".repeat(40);
const webVersionId = "11111111-1111-4111-8111-111111111111";
const connectorVersionId = "22222222-2222-4222-8222-222222222222";
const origin = "https://staging.unijam.ashlr.ai";
const now = Date.UTC(2026, 6, 16, 18);
const iso = (offsetMs) => new Date(now + offsetMs).toISOString();

function manual(kind, fields) {
  return {
    schemaVersion: 1,
    kind,
    targetOrigin: origin,
    candidate: { commit, webVersionId, connectorVersionId },
    operator: "pilot-release-owner",
    completedAt: iso(-20 * 60_000),
    checks: Object.fromEntries(fields.map((field) => [field, true])),
    passed: true,
  };
}

function load(profile) {
  const smoke = profile === "smoke";
  return {
    version: 2,
    profile,
    target: origin,
    production: false,
    releaseEvidence: true,
    candidate: { commit, webVersionId, connectorVersionId },
    manifestSha256: "b".repeat(64),
    startedAt: iso(smoke ? -40 * 60_000 : -90 * 60_000),
    finishedAt: iso(-30 * 60_000),
    durationMs: smoke ? 10_000 : 60 * 60_000,
    rooms: smoke ? 10 : 1,
    connections: smoke ? 200 : 25,
    thresholds: { ackP95Ms: 250, reconnectP95Ms: 2_000, projectionP95Ms: 5_000 },
    deploymentWindow: {
      before: { commit, webVersionId, connectorVersionId, capturedAt: iso(smoke ? -41 * 60_000 : -91 * 60_000) },
      after: { commit, webVersionId, connectorVersionId, capturedAt: iso(-29 * 60_000) },
    },
    measurements: { projectionRequired: true, projectionCount: 10 },
    gates: {
      acknowledgements: true, reconnect: true, projection: true, zeroDivergence: true,
      zeroCommandErrors: true, zeroMalformedMessages: true, zeroDuplicateDeliveries: true,
      zeroCanonicalEventConflicts: true,
    },
    passed: true,
  };
}

function bundle() {
  const workers = {
    web: {
      deploymentId: "33333333-3333-4333-8333-333333333333",
      versionId: webVersionId,
      percentage: 100,
      createdAt: iso(-2 * 60 * 60_000),
      releaseMessage: `unijam-release:${commit}`,
    },
    connectors: {
      deploymentId: "44444444-4444-4444-8444-444444444444",
      versionId: connectorVersionId,
      percentage: 100,
      createdAt: iso(-2 * 60 * 60_000),
      releaseMessage: `unijam-release:${commit}`,
    },
  };
  return {
    candidate: {
      schemaVersion: 2,
      kind: "unijam-cloudflare-candidate",
      environment: "staging",
      origin,
      commit,
      capturedAt: iso(-5 * 60_000),
      clean: true,
      workers,
      operatorIngress: {
        policy: "must-remain-undeployed-until-access-activation",
        deployed: false,
        publicAliasesDisabled: true,
        accessConfigurationClosed: true,
        runtimeFailClosed: true,
      },
      passed: true,
    },
    preflight: {
      version: 1,
      environment: "staging",
      commit,
      candidate: { commit, webVersionId, connectorVersionId },
      clean: true,
      ready: true,
      generatedAt: iso(-25 * 60_000),
      expected: { origin },
      remote: {
        checked: true, authenticated: true, databasesPresent: 2, queuesPresent: 4,
        workersWithDeployments: 2, deployedVersionsChecked: 2, deployedVersionsMatching: 2,
        databasesWithNoPendingMigrations: 2, customDomainOriginHealthy: true,
      },
    },
    hibernation: {
      schemaVersion: 2,
      kind: "unijam-room-hibernation-assurance",
      targetOrigin: origin,
      startedAt: iso(-50 * 60_000),
      completedAt: iso(-35 * 60_000),
      candidate: { commit, webVersionId, connectorVersionId },
      manifestSha256: "c".repeat(64),
      deploymentWindow: {
        before: { commit, webVersionId, connectorVersionId, capturedAt: iso(-51 * 60_000) },
        after: { commit, webVersionId, connectorVersionId, capturedAt: iso(-34 * 60_000) },
      },
      idleWindow: {
        requestedSeconds: 12,
        hostConnectionResumedWithoutReconnect: true,
        guestConnectionResumedWithoutReconnect: true,
      },
      guestRevocation: { existingSocketCloseCode: 1008, revokedCookieUpgradeStatus: 401 },
      hostRevocation: { existingSocketCloseCode: 1008, revokedCookieUpgradeStatus: 401 },
      passed: true,
    },
    smoke: load("smoke"),
    soak: load("soak"),
    providers: {
      schemaVersion: 1,
      kind: "unijam-mixed-provider-assurance",
      targetOrigin: origin,
      candidate: { commit, webVersionId, connectorVersionId },
      operator: "pilot-release-owner",
      completedAt: iso(-20 * 60_000),
      providers: Object.fromEntries(["spotify", "appleMusic"].map((provider) => [provider, {
        connectionAuthorized: true,
        usCatalogResolved: true,
        nativeHandoffOpenedAndHostConfirmed: true,
        privatePlaylistPublished: true,
        disconnectPurged: true,
        failureDidNotBlockRoom: true,
        peerProviderRemainedOperational: true,
        zeroDuplicateMutations: true,
      }])),
      passed: true,
    },
    accessibility: manual("unijam-manual-accessibility-assurance", [
      "voiceOverSafari", "nvdaChrome", "keyboardCompletion", "zoom200", "zoom400", "reducedMotion",
      "forcedColors", "touchTargets", "zeroSeriousCriticalAxe",
    ]),
    telemetry: manual("unijam-telemetry-assurance", [
      "webLogs", "connectorLogs", "queueBacklogObserved", "dlqObserved", "alertsConfigured",
      "providerKillSwitchesVerified", "secretAndCapabilityRedactionReviewed",
    ]),
    rollback: manual("unijam-rollback-assurance", [
      "priorWebVersionCaptured", "priorConnectorVersionCaptured", "stagingRollbackRehearsed",
      "durableObjectNamespacePreserved", "d1RestoreNotUsedAsAppRollback", "dualAuthorityCompatibilityConfirmed",
    ]),
  };
}

test("active Cloudflare versions must carry the exact commit release message", () => {
  const deployment = { id: "deployment", versions: [{ version_id: webVersionId, percentage: 100 }] };
  const version = {
    id: webVersionId,
    annotations: { "workers/message": `unijam-release:${commit}` },
    metadata: { created_on: iso(-2 * 60 * 60_000) },
  };
  assert.equal(validateActiveDeployment(deployment, version, commit, "web").versionId, webVersionId);
  assert.throws(
    () => validateActiveDeployment(deployment, { ...version, annotations: {} }, commit, "web"),
    /not bound to candidate/,
  );
  assert.throws(
    () => validateActiveDeployment({ ...deployment, versions: [{ version_id: webVersionId, percentage: 50 }] }, version, commit, "web"),
    /100 percent/,
  );
});

test("operator-ingress absence is accepted only for the exact missing-worker API result", () => {
  const worker = "unijam-operator-ingress-staging";
  assert.equal(isMissingWorkerResult({ status: 1, stdout: "", stderr: `${worker}: This Worker does not exist [code: 10007]` }, worker), true);
  assert.equal(isMissingWorkerResult({ status: 1, stdout: "", stderr: `${worker}: authentication failed [code: 10000]` }, worker), false);
  assert.equal(isMissingWorkerResult({ status: 0, stdout: "{}", stderr: "" }, worker), false);
});

test("pilot acceptance binds every measured and manual gate to one staging candidate", () => {
  const verdict = validateEvidenceBundle(bundle(), now);
  assert.equal(verdict.readyForProductionBaseline, true);
  assert.equal(verdict.publicLaunchApproved, false);
  assert.equal(Object.values(verdict.gates).every(Boolean), true);
});

test("pilot acceptance rejects abbreviated soak and mixed-version provider evidence", () => {
  const shortSoak = bundle();
  shortSoak.soak.durationMs = 59 * 60_000;
  assert.throws(() => validateEvidenceBundle(shortSoak, now), /soak load duration/);

  const mixedVersion = bundle();
  mixedVersion.providers.candidate.connectorVersionId = webVersionId;
  assert.throws(() => validateEvidenceBundle(mixedVersion, now), /provider.*connector version/i);

  const deployedIngress = bundle();
  deployedIngress.candidate.operatorIngress.deployed = true;
  assert.throws(() => validateEvidenceBundle(deployedIngress, now), /operator ingress/);
});

test("measured candidate windows reject partial observations and version drift", () => {
  const fixture = bundle().candidate;
  const expected = { commit, webVersionId, connectorVersionId };
  const after = structuredClone(fixture);
  after.capturedAt = iso(-4 * 60_000);
  assert.doesNotThrow(() => assertCandidateWindow(fixture, after, expected, "fixture"));
  after.workers.connectors.versionId = webVersionId;
  assert.throws(() => assertCandidateWindow(fixture, after, expected, "fixture"), /post-run candidate/);
  assert.throws(() => assertCandidateWindow({ workers: fixture.workers }, fixture, expected, "fixture"), /environment/);
});

test("evidence seals detect file mutation and reject paths outside the manifest directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "unijam-evidence-"));
  try {
    const candidate = bundle().candidate;
    const evidence = {};
    for (const name of ["candidate", "preflight", "hibernation", "smoke", "soak", "providers", "accessibility", "telemetry", "rollback"]) {
      const filename = `${name}.json`;
      evidence[name] = filename;
      await writeFile(join(directory, filename), JSON.stringify(name === "candidate" ? candidate : { name }), { mode: 0o600 });
    }
    const manifestPath = join(directory, "acceptance.json");
    await writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, kind: "unijam-pilot-acceptance-manifest", evidence }), { mode: 0o600 });
    const seal = await createEvidenceSeal(manifestPath);
    const sealPath = join(directory, "acceptance.seal.json");
    await writeFile(sealPath, JSON.stringify(seal), { mode: 0o600 });
    await assert.doesNotReject(() => verifyEvidenceSeal(manifestPath, sealPath));
    assert.deepEqual(seal.candidate, { commit, webVersionId, connectorVersionId });
    await writeFile(manifestPath, `${JSON.stringify({ schemaVersion: 1, kind: "unijam-pilot-acceptance-manifest", evidence })}\n`, { mode: 0o600 });
    await assert.rejects(() => verifyEvidenceSeal(manifestPath, sealPath), /manifest SHA-256/);
    await writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, kind: "unijam-pilot-acceptance-manifest", evidence }), { mode: 0o600 });
    await writeFile(join(directory, "smoke.json"), JSON.stringify({ changed: true }), { mode: 0o600 });
    await assert.rejects(() => verifyEvidenceSeal(manifestPath, sealPath), /smoke evidence.*does not match/i);

    const escaped = { ...evidence, candidate: "../outside.json" };
    await writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, kind: "unijam-pilot-acceptance-manifest", evidence: escaped }), { mode: 0o600 });
    await assert.rejects(() => createEvidenceSeal(manifestPath), /inside the manifest directory/);

    await symlink(join(directory, "candidate.json"), join(directory, "candidate-link.json"));
    const linked = { ...evidence, candidate: "candidate-link.json" };
    await writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, kind: "unijam-pilot-acceptance-manifest", evidence: linked }), { mode: 0o600 });
    await assert.rejects(() => createEvidenceSeal(manifestPath), /regular file, not a symlink/);
  } finally {
    await chmod(directory, 0o700).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("release wrappers attach immutable candidate messages without shell execution", () => {
  const web = readFileSync(new URL("../scripts/cloudflare-web-release.mjs", import.meta.url), "utf8");
  const connectors = readFileSync(new URL("../scripts/cloudflare-connector-release.mjs", import.meta.url), "utf8");
  for (const source of [web, connectors]) {
    assert.match(source, /unijam-release:\$\{commit\}/);
    assert.match(source, /git", \["status", "--porcelain"\]/);
    assert.doesNotMatch(source, /shell:\s*true/);
  }
  assert.match(connectors, /--strict/);
  assert.match(web, /--strict/);
  const acceptance = readFileSync(new URL("../scripts/verify-pilot-acceptance.mjs", import.meta.url), "utf8");
  assert.match(acceptance, /queryActiveCandidate/);
  assert.match(acceptance, /verifyEvidenceSeal/);
  for (const sourcePath of ["../scripts/run-room-load.mjs", "../scripts/verify-room-hibernation.mjs"]) {
    const source = readFileSync(new URL(sourcePath, import.meta.url), "utf8");
    assert.equal((source.match(/queryActiveCandidate\(/g) ?? []).length, 2);
    assert.equal((source.match(/expectedCandidate:/g) ?? []).length, 2);
  }
});
