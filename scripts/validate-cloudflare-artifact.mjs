#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const environment = argv.includes("--env") ? argv[argv.indexOf("--env") + 1] : "";
const requireProvisioned = argv.includes("--require-provisioned");
if (!["staging", "production"].includes(environment)) throw new Error("--env staging or --env production is required");

const artifactPath = resolve("dist/server/wrangler.json");
const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
const production = environment === "production";
const origin = production ? "https://unijam.ashlr.ai" : "https://staging.unijam.ashlr.ai";
const host = production ? "unijam.ashlr.ai" : "staging.unijam.ashlr.ai";
const expected = {
  name: `unijam-web-${environment}`,
  databaseName: `unijam-${environment}`,
  service: `unijam-connectors-${environment}`,
  queue: `unijam-room-projection-${environment}`,
  dlq: `unijam-room-projection-${environment}-dlq`,
};
const errors = [];
const check = (condition, message) => { if (!condition) errors.push(message); };

check(artifact.name === expected.name, `Worker name must be ${expected.name}; found ${artifact.name}`);
check(artifact.vars?.APP_ENV === environment, `APP_ENV must be ${environment}; found ${artifact.vars?.APP_ENV}`);
check(artifact.vars?.APP_ORIGIN === origin, `APP_ORIGIN must be ${origin}; found ${artifact.vars?.APP_ORIGIN}`);
check(artifact.vars?.WEBAUTHN_RP_ID === host, `WEBAUTHN_RP_ID must be ${host}; found ${artifact.vars?.WEBAUTHN_RP_ID}`);
check(artifact.vars?.ENABLE_LEGACY_ROOM_API === "false", "ENABLE_LEGACY_ROOM_API must remain false in the deploy artifact");

const database = artifact.d1_databases?.find((entry) => entry.binding === "DB");
check(database?.database_name === expected.databaseName, `DB must bind ${expected.databaseName}; found ${database?.database_name}`);
check(Boolean(database?.database_id), "DB database_id is missing");
if (requireProvisioned) {
  check(!/^00000000-0000-4000-8000-0000000000[0-9a-f]{2}$/i.test(database?.database_id ?? ""), "DB still uses a non-routable sentinel ID");
}

const roomObject = artifact.durable_objects?.bindings?.find((entry) => entry.name === "ROOM_OBJECTS");
check(roomObject?.class_name === "RoomDurableObject", "ROOM_OBJECTS must bind RoomDurableObject");
check(artifact.migrations?.some((migration) => migration.new_sqlite_classes?.includes("RoomDurableObject")), "SQLite RoomDurableObject migration is missing");

const connector = artifact.services?.find((entry) => entry.binding === "CONNECTORS");
check(connector?.service === expected.service, `CONNECTORS must bind ${expected.service}; found ${connector?.service}`);
const producer = artifact.queues?.producers?.find((entry) => entry.binding === "ROOM_PROJECTION_QUEUE");
check(producer?.queue === expected.queue, `ROOM_PROJECTION_QUEUE must bind ${expected.queue}; found ${producer?.queue}`);
const consumer = artifact.queues?.consumers?.find((entry) => entry.queue === expected.queue);
check(consumer?.dead_letter_queue === expected.dlq, `Projection consumer must use DLQ ${expected.dlq}; found ${consumer?.dead_letter_queue}`);
check(artifact.triggers?.crons?.length === 1, "Deploy artifact must contain exactly one retention cron");

const route = artifact.routes?.find((entry) => entry.pattern === host);
check(route?.custom_domain === true, `Deploy artifact must contain custom domain ${host}`);
check(!artifact.d1_databases?.some((entry) => entry.database_name === "unijam-development"), "Deploy artifact contains development D1 binding");
check(!artifact.services?.some((entry) => entry.service === "unijam-connectors-development"), "Deploy artifact contains development connector binding");
check(!artifact.queues?.producers?.some((entry) => entry.queue?.endsWith("-development")), "Deploy artifact contains development queue binding");

if (errors.length > 0) {
  for (const error of errors) console.error(`ERROR ARTIFACT_ENV: ${error}`);
  console.error(`Refusing ${environment} release: dist/server/wrangler.json does not match the selected Cloudflare environment.`);
  process.exitCode = 1;
} else {
  console.log(`Validated ${environment} Cloudflare artifact: name, origin, RP ID, D1, Durable Object, connector service, queue, DLQ, cron, and domain are isolated.`);
}
