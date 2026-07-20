#!/usr/bin/env node

import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export { validateActiveDeployment } from "./cloudflare-candidate-identity.mjs";
import { queryActiveCandidate } from "./cloudflare-candidate-identity.mjs";

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
  const report = await queryActiveCandidate({ environment, requireClean: true, requireOperatorUndeployed: true });
  const commit = report.commit;
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
