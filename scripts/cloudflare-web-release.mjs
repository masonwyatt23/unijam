#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";

const [operation, ...argv] = process.argv.slice(2);
const environment = argv.includes("--env") ? argv[argv.indexOf("--env") + 1] : "";
const allowSentinels = argv.includes("--allow-sentinels");
const productionConfirmation = argv.includes("--production-confirmation")
  ? argv[argv.indexOf("--production-confirmation") + 1]
  : "";
const confirmationPhrase = "I_UNDERSTAND_THIS_DEPLOYS_PRODUCTION";

if (!["build", "deploy", "dry-run"].includes(operation) || !["staging", "production"].includes(environment)) {
  throw new Error("Usage: node scripts/cloudflare-web-release.mjs <build|dry-run|deploy> --env <staging|production> [--allow-sentinels]");
}
if (operation === "deploy" && allowSentinels) throw new Error("--allow-sentinels is forbidden for live deploys");
if (operation === "deploy" && environment === "production" && productionConfirmation !== confirmationPhrase) {
  throw new Error(`Production deploy requires --production-confirmation ${confirmationPhrase}`);
}

function run(command, args, extraEnvironment = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const executable = process.platform === "win32" && command === "npm" ? "npm.cmd"
      : process.platform === "win32" && command === "npx" ? "npx.cmd"
        : command;
    const child = spawn(executable, args, {
      stdio: "inherit",
      env: { ...process.env, ...extraEnvironment },
      shell: false,
    });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} ${args.join(" ")} exited with ${code ?? signal}`));
    });
  });
}

function releaseCommit() {
  const status = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" });
  if (status.trim() !== "") throw new Error("Web deploy requires a clean worktree so the Worker version can be bound to one commit");
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Could not resolve an exact release commit");
  return commit;
}

if (!allowSentinels) {
  await run(process.execPath, ["scripts/validate-release-config.mjs", "--env", environment, "--require-provisioned"]);
}

console.log(`Building the flattened ${environment} Worker with CLOUDFLARE_ENV=${environment}.`);
await run("npm", ["run", "build"], { CLOUDFLARE_ENV: environment });
await run(process.execPath, [
  "scripts/validate-cloudflare-artifact.mjs", "--env", environment,
  ...(allowSentinels ? [] : ["--require-provisioned"]),
]);

if (operation === "dry-run") {
  await run("npx", ["wrangler", "deploy", "--config", "dist/server/wrangler.json", "--dry-run"]);
}
if (operation === "deploy") {
  const commit = releaseCommit();
  console.log(`Deploying the already-validated flattened ${environment} artifact for candidate ${commit}. No Wrangler --env override is used.`);
  await run("npx", [
    "wrangler", "deploy", "--config", "dist/server/wrangler.json", "--strict",
    "--message", `unijam-release:${commit}`,
  ]);
}
