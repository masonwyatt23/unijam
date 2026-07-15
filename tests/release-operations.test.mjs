import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const repositoryRoot = new URL("../", import.meta.url);

test("release configuration accepts DO name bindings and reports only real blockers", () => {
  const result = spawnSync(process.execPath, ["scripts/validate-release-config.mjs", "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.issues.some((entry) => entry.code === "BINDING_CARDINALITY"), false);
  assert.equal(report.issues.some((entry) => entry.code === "DO_CLASS"), false);
  assert.equal(report.issues.every((entry) => entry.code === "D1_SENTINEL" || entry.severity !== "warning"), true);
});

test("load harness refuses the production hostname before reading credentials", () => {
  const result = spawnSync(process.execPath, [
    "scripts/run-room-load.mjs",
    "--profile", "smoke",
    "--manifest", "/dev/null",
    "--target", "https://unijam.ashlr.ai",
  ], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Production is blocked/);
  assert.doesNotMatch(result.stderr, /JSON/);
});
