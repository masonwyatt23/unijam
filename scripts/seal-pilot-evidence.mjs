#!/usr/bin/env node

import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { createEvidenceSeal } from "./pilot-evidence-integrity.mjs";

const argv = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
};
const manifest = valueAfter("--manifest");
if (!manifest) throw new Error("Usage: node scripts/seal-pilot-evidence.mjs --manifest <private.json> [--output private.json]");
const manifestPath = resolve(manifest);
const output = resolve(valueAfter("--output") ?? `${manifestPath}.seal.json`);
if (output === manifestPath) throw new Error("Evidence seal output must not overwrite the acceptance manifest");
const seal = await createEvidenceSeal(manifestPath);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(seal, null, 2)}\n`, { mode: 0o600 });
await chmod(output, 0o600);
process.stdout.write(`${JSON.stringify({ sealed: true, candidateCommit: seal.candidate.commit, output }, null, 2)}\n`);
