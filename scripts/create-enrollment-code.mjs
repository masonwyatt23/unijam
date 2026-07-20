#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";

const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};

function fail(message) {
  console.error(message);
  process.exit(2);
}

export function enrollmentCredential({ label, ttlHours = 24, now = Date.now(), random = randomBytes } = {}) {
  const normalizedLabel = String(label ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 .'_@+-]{1,79}$/.test(normalizedLabel)) {
    throw new Error("label must be 2-80 safe display characters");
  }
  if (!Number.isInteger(ttlHours) || ttlHours < 1 || ttlHours > 168) {
    throw new Error("ttlHours must be an integer from 1 through 168");
  }
  const raw = random(12).toString("hex").toUpperCase();
  const code = `UJ-${raw.slice(0, 8)}-${raw.slice(8, 16)}-${raw.slice(16)}`;
  return {
    version: 1,
    code,
    record: {
      codeHash: createHash("sha256").update(code).digest("hex"),
      label: normalizedLabel,
      createdAtMs: now,
      expiresAtMs: now + ttlHours * 60 * 60_000,
    },
  };
}

export function enrollmentSql(credential, { rotate = false } = {}) {
  const { codeHash, label, createdAtMs, expiresAtMs } = credential.record;
  const quotedLabel = `'${label.replaceAll("'", "''")}'`;
  const statements = [];
  if (rotate) {
    // Expiring an unused credential preserves its audit row and cannot be
    // mistaken for successful enrollment. Used credentials are immutable.
    statements.push(
      `UPDATE host_enrollment_codes SET expires_at_ms = ${createdAtMs} WHERE label = ${quotedLabel} AND used_at_ms IS NULL AND expires_at_ms > ${createdAtMs}`,
    );
  }
  statements.push(
    `INSERT INTO host_enrollment_codes (code_hash, label, expires_at_ms, created_at_ms) VALUES ('${codeHash}', ${quotedLabel}, ${expiresAtMs}, ${createdAtMs})`,
  );
  return `${statements.join(";\n")};`;
}

function usage() {
  return "Usage: node scripts/create-enrollment-code.mjs --label LABEL [--ttl-hours 24] [--rotate] [--sql]";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (args.includes("--help")) {
    console.log(usage());
    process.exit(0);
  }
  const label = valueAfter("--label");
  const ttlValue = valueAfter("--ttl-hours") ?? "24";
  if (!label) fail(usage());
  if (!/^\d+$/.test(ttlValue)) fail("--ttl-hours must be an integer from 1 through 168");
  let credential;
  try {
    credential = enrollmentCredential({ label, ttlHours: Number(ttlValue) });
  } catch (error) {
    fail(error instanceof Error ? error.message : "Enrollment credential could not be created");
  }
  const output = {
    ...credential,
    ...(args.includes("--sql") ? { sql: enrollmentSql(credential, { rotate: args.includes("--rotate") }) } : {}),
    handling: {
      plaintextShownOnce: true,
      storeOnlyCodeHash: true,
      delivery: "Send the code to exactly one host through an authenticated private channel.",
    },
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}
