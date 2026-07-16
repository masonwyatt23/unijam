import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { validateActiveDeployment } from "../scripts/capture-cloudflare-candidate.mjs";
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
    version: 1,
    profile,
    target: origin,
    production: false,
    startedAt: iso(smoke ? -40 * 60_000 : -90 * 60_000),
    finishedAt: iso(-30 * 60_000),
    durationMs: smoke ? 10_000 : 60 * 60_000,
    rooms: smoke ? 10 : 1,
    connections: smoke ? 200 : 25,
    thresholds: { ackP95Ms: 250, reconnectP95Ms: 2_000, projectionP95Ms: 5_000 },
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
      schemaVersion: 1,
      kind: "unijam-cloudflare-candidate",
      environment: "staging",
      origin,
      commit,
      capturedAt: iso(-5 * 60_000),
      clean: true,
      workers,
      passed: true,
    },
    preflight: {
      version: 1,
      environment: "staging",
      commit,
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
      schemaVersion: 1,
      kind: "unijam-room-hibernation-assurance",
      targetOrigin: origin,
      completedAt: iso(-35 * 60_000),
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
});
