#!/usr/bin/env node

import { spawnSync } from "node:child_process";

import { enrollmentCredential, enrollmentSql } from "./create-enrollment-code.mjs";

const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
const fail = (message) => {
  console.error(message);
  process.exit(2);
};

const environment = valueAfter("--env");
const label = valueAfter("--label");
const ttlValue = valueAfter("--ttl-hours") ?? "24";
const apply = args.includes("--apply");
const rotate = args.includes("--rotate");

if (!environment || !["staging", "production"].includes(environment)) fail("--env must be staging or production");
if (!label) fail("--label is required and should identify exactly one intended host");
if (!/^\d+$/.test(ttlValue)) fail("--ttl-hours must be an integer from 1 through 168");
const ttlHours = Number(ttlValue);

// Validate every input before deciding whether to mint a plaintext credential.
try {
  enrollmentCredential({ label, ttlHours, random: () => Buffer.alloc(12) });
} catch (error) {
  fail(error instanceof Error ? error.message : "Pilot host input is invalid");
}

if (!apply) {
  console.log(JSON.stringify({
    ok: true,
    environment,
    label,
    ttlHours,
    rotate,
    credentialGenerated: false,
    mutationSent: false,
    next: "Repeat with --apply only from the authenticated release workstation.",
  }));
  process.exit(0);
}

if (environment === "production" && valueAfter("--production-confirmation") !== "I_UNDERSTAND_THIS_CREATES_A_PRODUCTION_HOST_INVITE") {
  fail("Production enrollment requires --production-confirmation I_UNDERSTAND_THIS_CREATES_A_PRODUCTION_HOST_INVITE");
}

const credential = enrollmentCredential({ label, ttlHours });
const database = environment === "production" ? "unijam-production" : "unijam-staging";
const result = spawnSync("npx", [
  "wrangler", "d1", "execute", database,
  "--config", "wrangler.jsonc",
  "--env", environment,
  "--remote",
  "--command", enrollmentSql(credential, { rotate }),
], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

if (result.status !== 0) {
  // The statement contains only a digest and metadata, but avoid echoing tool
  // arguments or arbitrary remote output into a ticket or CI transcript.
  console.error("Cloudflare rejected the enrollment mutation; no usable invite was issued. Inspect Wrangler locally.");
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  environment,
  label: credential.record.label,
  expiresAt: new Date(credential.record.expiresAtMs).toISOString(),
  code: credential.code,
  plaintextShownOnce: true,
  delivery: "Send only to the named host through an authenticated private channel, then clear this terminal.",
}, null, 2));
