#!/usr/bin/env node

import { createPrivateKey } from "node:crypto";
import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const environment = valueAfter("--env");
const dryRun = argv.includes("--dry-run");

if (!environment || !["staging", "production"].includes(environment)) {
  console.error("Usage: cat AuthKey_KEYID.p8 | node scripts/install-apple-private-key.mjs --env staging|production [--dry-run]");
  process.exit(2);
}
if (process.stdin.isTTY) {
  console.error("Refusing to prompt for private key material. Pipe the one-time Apple .p8 download on stdin.");
  process.exit(2);
}

function valueAfter(flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

const chunks = [];
let size = 0;
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > 16_384) {
    console.error("Apple private key input is unexpectedly large.");
    process.exit(2);
  }
  chunks.push(chunk);
}

let privateJwk;
try {
  const pem = Buffer.concat(chunks).toString("utf8");
  if (!pem.includes("BEGIN PRIVATE KEY")) throw new Error("not a PKCS#8 private key");
  privateJwk = createPrivateKey(pem).export({ format: "jwk" });
  if (privateJwk.kty !== "EC" || privateJwk.crv !== "P-256" || typeof privateJwk.d !== "string") {
    throw new Error("not a private P-256 key");
  }
} catch {
  console.error("Input must be the unmodified P-256 Apple Media Services .p8 private key.");
  process.exit(2);
}

if (dryRun) {
  console.log(JSON.stringify({
    ok: true,
    environment,
    keyType: "EC",
    curve: "P-256",
    secretName: "APPLE_PRIVATE_KEY_JWK",
    secretInstalled: false,
  }));
  process.exit(0);
}

const result = spawnSync("npx", [
  "--no-install",
  "wrangler",
  "secret",
  "put",
  "APPLE_PRIVATE_KEY_JWK",
  "--config",
  "wrangler.connectors.jsonc",
  "--env",
  environment,
], {
  input: `${JSON.stringify(privateJwk)}\n`,
  encoding: "utf8",
  stdio: ["pipe", "inherit", "inherit"],
});

if (result.status !== 0) process.exit(result.status ?? 1);
console.log(JSON.stringify({ ok: true, environment, secretName: "APPLE_PRIVATE_KEY_JWK", secretInstalled: true }));
