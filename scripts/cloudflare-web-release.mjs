#!/usr/bin/env node

import { spawn } from "node:child_process";

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
  console.log(`Deploying the already-validated flattened ${environment} artifact. No Wrangler --env override is used.`);
  await run("npx", ["wrangler", "deploy", "--config", "dist/server/wrangler.json"]);
}
