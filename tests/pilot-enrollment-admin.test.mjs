import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { enrollmentCredential, enrollmentSql } from "../scripts/create-enrollment-code.mjs";

const fixedRandom = () => Buffer.from("00112233445566778899aabb", "hex");

test("pilot credentials are high-entropy, time-bounded, and hash-only at rest", () => {
  const credential = enrollmentCredential({ label: "Mason - Apple Music", ttlHours: 24, now: 1_000, random: fixedRandom });
  assert.equal(credential.code, "UJ-00112233-44556677-8899AABB");
  assert.equal(credential.record.codeHash, "d74a527075fac316d1328a8dda54ecc05944dcb60ae423ba735e00ae7b1ebd39");
  assert.equal(credential.record.expiresAtMs, 86_401_000);
  assert.doesNotMatch(enrollmentSql(credential), /UJ-00112233/);
  assert.match(enrollmentSql(credential), /INSERT INTO host_enrollment_codes/);
});

test("rotation expires only unused live credentials with the same exact label", () => {
  const credential = enrollmentCredential({ label: "Cofounder O'Brien", ttlHours: 1, now: 5_000, random: fixedRandom });
  const sql = enrollmentSql(credential, { rotate: true });
  assert.match(sql, /WHERE label = 'Cofounder O''Brien'/);
  assert.match(sql, /used_at_ms IS NULL/);
  assert.match(sql, /expires_at_ms > 5000/);
  assert.doesNotMatch(sql, /UJ-00112233/);
});

test("operator inputs reject long-lived, blank, and unsafe labels", () => {
  assert.throws(() => enrollmentCredential({ label: "x", random: fixedRandom }), /label/);
  assert.throws(() => enrollmentCredential({ label: "bad; DROP TABLE accounts", random: fixedRandom }), /label/);
  assert.throws(() => enrollmentCredential({ label: "Mason", ttlHours: 169, random: fixedRandom }), /ttlHours/);
});

test("pilot provisioning dry-run neither generates a credential nor touches D1", () => {
  const result = spawnSync(process.execPath, [
    "scripts/provision-pilot-host.mjs",
    "--env", "staging",
    "--label", "Mason Apple Music",
  ], { encoding: "utf8", cwd: new URL("../", import.meta.url) });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.credentialGenerated, false);
  assert.equal(report.mutationSent, false);
  assert.doesNotMatch(result.stdout, /UJ-[A-Z0-9]/);
});

test("production provisioning fails before minting a credential without exact confirmation", () => {
  const result = spawnSync(process.execPath, [
    "scripts/provision-pilot-host.mjs",
    "--env", "production",
    "--label", "Cofounder Spotify",
    "--apply",
  ], { encoding: "utf8", cwd: new URL("../", import.meta.url) });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /I_UNDERSTAND_THIS_CREATES_A_PRODUCTION_HOST_INVITE/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /UJ-[A-Z0-9]/);
});

test("cofounder cohort dry-run requires exactly four unique hosts and mints nothing", () => {
  const base = ["scripts/provision-cofounder-cohort.mjs", "--env", "staging"];
  const result = spawnSync(process.execPath, [
    ...base,
    "--host", "Alex Spotify",
    "--host", "Jordan Spotify",
    "--host", "Taylor Spotify",
    "--host", "Riley Spotify",
  ], { encoding: "utf8", cwd: new URL("../", import.meta.url) });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.hostCount, 4);
  assert.equal(report.credentialsGenerated, false);
  assert.equal(report.mutationSent, false);
  assert.doesNotMatch(result.stdout, /UJ-[A-Z0-9]/);

  const tooFew = spawnSync(process.execPath, [...base, "--host", "Only One"], {
    encoding: "utf8", cwd: new URL("../", import.meta.url),
  });
  assert.equal(tooFew.status, 2);
  assert.match(tooFew.stderr, /exactly four/);
});
