#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";

const [operation, ...argv] = process.argv.slice(2);
const environment = argv.includes("--env") ? argv[argv.indexOf("--env") + 1] : "";
const productionConfirmation = argv.includes("--production-confirmation")
  ? argv[argv.indexOf("--production-confirmation") + 1]
  : "";
const confirmationPhrase = "I_UNDERSTAND_THIS_DEPLOYS_PRODUCTION";

if (!["dry-run", "deploy"].includes(operation) || !["staging", "production"].includes(environment)) {
  throw new Error("Usage: node scripts/cloudflare-connector-release.mjs <dry-run|deploy> --env <staging|production>");
}
if (operation === "deploy" && environment === "production" && productionConfirmation !== confirmationPhrase) {
  throw new Error(`Production deploy requires --production-confirmation ${confirmationPhrase}`);
}

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const executable = process.platform === "win32" && command === "npx" ? "npx.cmd" : command;
    const child = spawn(executable, args, { stdio: "inherit", env: process.env, shell: false });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} ${args.join(" ")} exited with ${code ?? signal}`));
    });
  });
}

function releaseCommit() {
  const status = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" });
  if (status.trim() !== "") throw new Error("Connector deploy requires a clean worktree so the Worker version can be bound to one commit");
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Could not resolve an exact release commit");
  return commit;
}

await run(process.execPath, ["scripts/validate-release-config.mjs", "--env", environment, "--require-provisioned"]);

const args = ["wrangler", "deploy", "--config", "wrangler.connectors.jsonc", "--env", environment, "--strict"];
if (operation === "dry-run") {
  args.push("--dry-run");
  await run("npx", args);
} else {
  const commit = releaseCommit();
  args.push("--message", `unijam-release:${commit}`);
  console.log(`Deploying connector candidate ${commit} to ${environment}.`);
  await run("npx", args);
}
