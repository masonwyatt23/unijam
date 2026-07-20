#!/usr/bin/env node

import { spawnSync } from "node:child_process";

import { enrollmentCredential, enrollmentSql } from "./create-enrollment-code.mjs";

const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
const valuesAfter = (flag) => args.flatMap((value, index) => value === flag && args[index + 1] ? [args[index + 1]] : []);
const fail = (message) => {
  console.error(message);
  process.exit(2);
};

const environment = valueAfter("--env");
const hosts = valuesAfter("--host").map((value) => value.trim());
const ttlValue = valueAfter("--ttl-hours") ?? "24";
const apply = args.includes("--apply");
const rotate = args.includes("--rotate");

if (!environment || !["staging", "production"].includes(environment)) fail("--env must be staging or production");
if (hosts.length !== 4) fail("Provide exactly four --host labels, one for each additional cofounder");
if (new Set(hosts.map((host) => host.toLocaleLowerCase("en-US"))).size !== hosts.length) fail("Every --host label must be unique");
if (!/^\d+$/.test(ttlValue)) fail("--ttl-hours must be an integer from 1 through 168");
const ttlHours = Number(ttlValue);
try {
  for (const label of hosts) enrollmentCredential({ label, ttlHours, random: () => Buffer.alloc(12) });
} catch (error) {
  fail(error instanceof Error ? error.message : "A cofounder label is invalid");
}

if (!apply) {
  console.log(JSON.stringify({
    ok: true,
    environment,
    hosts,
    hostCount: 4,
    ttlHours,
    rotate,
    credentialsGenerated: false,
    mutationSent: false,
    next: "Verify each label maps to one person, then repeat with --apply on the authenticated release workstation.",
  }));
  process.exit(0);
}

if (environment === "production" && valueAfter("--production-confirmation") !== "I_UNDERSTAND_THIS_CREATES_FOUR_PRODUCTION_HOST_INVITES") {
  fail("Production cohort enrollment requires --production-confirmation I_UNDERSTAND_THIS_CREATES_FOUR_PRODUCTION_HOST_INVITES");
}

const now = Date.now();
const credentials = hosts.map((label) => enrollmentCredential({ label, ttlHours, now }));
const sql = credentials.map((credential) => enrollmentSql(credential, { rotate })).join("\n");
const database = environment === "production" ? "unijam-production" : "unijam-staging";
const result = spawnSync("npx", [
  "wrangler", "d1", "execute", database,
  "--config", "wrangler.jsonc",
  "--env", environment,
  "--remote",
  "--command", sql,
], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

if (result.status !== 0) {
  console.error("Cloudflare rejected the cohort enrollment mutation; no usable invites were issued. Inspect Wrangler locally.");
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  environment,
  expiresAt: new Date(credentials[0].record.expiresAtMs).toISOString(),
  invitations: credentials.map((credential) => ({ label: credential.record.label, code: credential.code })),
  plaintextShownOnce: true,
  handling: "Deliver each code only to its named host through a separate authenticated private channel, then clear this terminal.",
}, null, 2));
