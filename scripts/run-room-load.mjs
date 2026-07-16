#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import WebSocket from "ws";

import {
  assertCandidateWindow,
  queryActiveCandidate,
  validateCandidateReference,
} from "./cloudflare-candidate-identity.mjs";
import { sameOriginBrowserHeaders } from "./release-request-headers.mjs";

const execFileAsync = promisify(execFile);
const PRODUCTION_CONFIRMATION = "I_UNDERSTAND_THIS_MUTATES_LIVE_ROOMS";
const JOIN_RATE_LIMIT = 20;
const JOIN_RATE_WINDOW_MS = 15 * 60_000;
const defaults = {
  target: "http://127.0.0.1:8787",
  profile: "smoke",
  durationMinutes: 60,
  cycleSeconds: 10,
  reconnectSeconds: 60,
  ackP95Ms: 250,
  reconnectP95Ms: 2_000,
  projectionP95Ms: 5_000,
  projectionTimeoutMs: 8_000,
};

function usage() {
  return `UniJam room load harness

Usage:
  node scripts/run-room-load.mjs --manifest <private.json> [options]

Profiles:
  --profile smoke   Exactly 10 rooms with 20 authenticated sessions each; one command wave and reconnect (default)
  --profile soak    Exactly one room with 25 authenticated sessions; 60 minutes by default

Target and safety:
  --target <origin>                       Default: http://127.0.0.1:8787
  --allow-production                     Required for https://unijam.ashlr.ai
  --production-confirmation <phrase>     Also required for production; phrase is ${PRODUCTION_CONFIRMATION}

Measurement:
  --projection-database <name>           Query D1 projection state through Wrangler
  --wrangler-env <staging|production>    Wrangler environment for the projection database
  --projection-mode <local|remote>       Default: remote for HTTPS, local for localhost
  --require-projection                   Fail when projection lag is not measured
  --output <path>                        JSON result path under test-results/load by default

Soak controls:
  --duration-minutes <n>                 Default: 60 (production always requires at least 60)
  --cycle-seconds <n>                    Default: 10
  --reconnect-seconds <n>                Default: 60
`;
}

function parseArguments(argv) {
  const options = { ...defaults, requireProjection: false, allowProduction: false };
  const valueFlags = new Set([
    "manifest", "profile", "target", "production-confirmation", "projection-database", "wrangler-env",
    "projection-mode", "output", "duration-minutes", "cycle-seconds", "reconnect-seconds",
    "ack-p95-ms", "reconnect-p95-ms", "projection-p95-ms", "projection-timeout-ms",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (raw === "--help" || raw === "-h") return { help: true };
    if (raw === "--allow-production") { options.allowProduction = true; continue; }
    if (raw === "--require-projection") { options.requireProjection = true; continue; }
    if (!raw.startsWith("--") || !valueFlags.has(raw.slice(2))) throw new Error(`Unknown argument: ${raw}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${raw} requires a value`);
    index += 1;
    const key = raw.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    options[key] = value;
  }
  for (const key of ["durationMinutes", "cycleSeconds", "reconnectSeconds", "ackP95Ms", "reconnectP95Ms", "projectionP95Ms", "projectionTimeoutMs"]) {
    options[key] = Number(options[key]);
    if (!Number.isFinite(options[key]) || options[key] <= 0) throw new Error(`${key} must be a positive number`);
  }
  return options;
}

function validateSession(session, roomId, index) {
  if (!session || typeof session !== "object" || Array.isArray(session)) throw new Error(`${roomId} session ${index + 1} is invalid`);
  if (typeof session.cookie !== "string" || !session.cookie.includes("__Host-unijam_")) {
    throw new Error(`${roomId} session ${index + 1} must contain a UniJam host or guest cookie`);
  }
  if (/\r|\n/.test(session.cookie)) throw new Error(`${roomId} session ${index + 1} cookie contains an invalid newline`);
  const joinedAtMs = Date.parse(session.joinedAt);
  if (!Number.isFinite(joinedAtMs)) throw new Error(`${roomId} session ${index + 1} joinedAt must be an ISO timestamp`);
  if (joinedAtMs > Date.now() + 5 * 60_000) throw new Error(`${roomId} session ${index + 1} joinedAt cannot be in the future`);
  const networkCohort = typeof session.networkCohort === "string" ? session.networkCohort.trim() : "";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(networkCohort)) {
    throw new Error(`${roomId} session ${index + 1} networkCohort must be an opaque label, not a raw IP address`);
  }
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(networkCohort) || networkCohort.includes(":")) {
    throw new Error(`${roomId} session ${index + 1} networkCohort must not contain an IP address`);
  }
  return {
    label: typeof session.label === "string" ? session.label.slice(0, 80) : `session-${index + 1}`,
    cookie: session.cookie,
    joinedAt: new Date(joinedAtMs).toISOString(),
    joinedAtMs,
    networkCohort,
  };
}

function validateRoom(room, sessionCount, label) {
  if (!room || typeof room !== "object" || Array.isArray(room)) throw new Error(`${label} is invalid`);
  const roomId = typeof room.roomId === "string" ? room.roomId.trim().toUpperCase() : "";
  if (!/^[A-Z0-9]{6,16}$/.test(roomId)) throw new Error(`${label} roomId is malformed`);
  if (!Array.isArray(room.sessions) || room.sessions.length !== sessionCount) {
    throw new Error(`${roomId} must provide exactly ${sessionCount} authenticated sessions`);
  }
  return { roomId, sessions: room.sessions.map((session, index) => validateSession(session, roomId, index)) };
}

export function validateManifest(value, profile, targetOrigin) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 3) {
    throw new Error("Load manifest must be a version 3 object");
  }
  if (typeof value.origin !== "string" || new URL(value.origin).origin !== targetOrigin || value.origin !== targetOrigin) {
    throw new Error("Load manifest origin must exactly match the target origin");
  }
  if (value.provisioning !== "normal-join-flow") {
    throw new Error("Load manifest must attest provisioning through the normal join flow");
  }
  validateCandidateReference(value.candidate, "Load manifest candidate");
  let rooms;
  if (profile === "smoke") {
    if (!Array.isArray(value.smokeRooms) || value.smokeRooms.length !== 10) {
      throw new Error("Smoke profile requires exactly 10 smokeRooms");
    }
    rooms = value.smokeRooms.map((room, index) => validateRoom(room, 20, `smokeRooms[${index}]`));
  } else if (profile === "soak") {
    rooms = [validateRoom(value.soakRoom, 25, "soakRoom")];
  } else {
    throw new Error("--profile must be smoke or soak");
  }
  const cookies = rooms.flatMap((room) => room.sessions.map((session) => session.cookie));
  if (new Set(cookies).size !== cookies.length) throw new Error("Every load participant must have a distinct authenticated cookie");
  const joinBuckets = new Map();
  for (const session of rooms.flatMap((room) => room.sessions)) {
    const bucketStartMs = Math.floor(session.joinedAtMs / JOIN_RATE_WINDOW_MS) * JOIN_RATE_WINDOW_MS;
    const key = `${session.networkCohort}:${bucketStartMs}`;
    joinBuckets.set(key, (joinBuckets.get(key) ?? 0) + 1);
    if (joinBuckets.get(key) > JOIN_RATE_LIMIT) {
      throw new Error(`Network cohort ${session.networkCohort} exceeds ${JOIN_RATE_LIMIT} normal joins in one 15-minute rate-limit bucket`);
    }
  }
  return rooms;
}

function percentile(values, percentileValue) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1)];
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function websocketUrl(origin, roomId) {
  const url = new URL(`/api/v1/rooms/${roomId}/websocket`, origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

class RoomSocket {
  constructor({ origin, roomId, session, metrics }) {
    this.origin = origin;
    this.roomId = roomId;
    this.session = session;
    this.metrics = metrics;
    this.socket = null;
    this.waiters = new Set();
    this.history = [];
    this.seenEventIds = new Map();
    this.latestSeq = 0;
  }

  onMessage(raw) {
    let message;
    try { message = JSON.parse(raw.toString()); }
    catch { this.metrics.malformedMessages += 1; return; }
    this.history.push(message);
    if (this.history.length > 100) this.history.shift();
    const events = Array.isArray(message.events) ? message.events : [];
    for (const event of events) {
      if (!event || typeof event.eventId !== "string" || !Number.isSafeInteger(event.seq)) continue;
      const signature = digest(event);
      const prior = this.seenEventIds.get(event.eventId);
      if (prior) {
        this.metrics.deliveryDuplicateEvents += 1;
        if (prior !== signature) this.metrics.canonicalEventConflicts += 1;
      } else {
        this.seenEventIds.set(event.eventId, signature);
      }
      const canonical = this.metrics.canonicalEvents.get(event.eventId);
      if (canonical && canonical !== signature) this.metrics.canonicalEventConflicts += 1;
      else this.metrics.canonicalEvents.set(event.eventId, signature);
      this.latestSeq = Math.max(this.latestSeq, event.seq);
    }
    if (Number.isSafeInteger(message.latestSeq)) this.latestSeq = Math.max(this.latestSeq, message.latestSeq);
    if (Number.isSafeInteger(message.seq)) this.latestSeq = Math.max(this.latestSeq, message.seq);
    if (message.snapshot && Number.isSafeInteger(message.snapshot.seq)) this.latestSeq = Math.max(this.latestSeq, message.snapshot.seq);
    for (const waiter of [...this.waiters]) {
      if (!waiter.predicate(message)) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(message);
    }
  }

  waitFor(predicate, timeoutMs, label) {
    const existing = this.history.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolveWaiter, rejectWaiter) => {
      const waiter = {
        predicate,
        resolve: resolveWaiter,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          rejectWaiter(new Error(`${this.roomId} timed out waiting for ${label}`));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  async connect(lastSeq = this.latestSeq) {
    const startedAt = performance.now();
    this.history = [];
    const socket = new WebSocket(websocketUrl(this.origin, this.roomId), {
      headers: sameOriginBrowserHeaders(this.origin, { Cookie: this.session.cookie }),
      handshakeTimeout: 5_000,
      maxPayload: 128 * 1024,
      perMessageDeflate: false,
    });
    this.socket = socket;
    socket.on("message", (data) => this.onMessage(data));
    const opened = new Promise((resolveOpen, rejectOpen) => {
      socket.once("open", resolveOpen);
      socket.once("unexpected-response", (_request, response) => rejectOpen(new Error(`${this.roomId} WebSocket rejected with ${response.statusCode}`)));
      socket.once("error", rejectOpen);
    });
    await opened;
    const statePromise = this.waitFor((message) => message.type === "snapshot" || message.type === "events", 5_000, "hello state");
    socket.send(JSON.stringify({ type: "hello", protocol: 1, lastSeq, clientInstanceId: `load_${randomUUID()}` }));
    await statePromise;
    return performance.now() - startedAt;
  }

  async command(ready) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error(`${this.roomId} socket is not open`);
    const commandId = `load_${randomUUID()}`;
    const responsePromise = this.waitFor((message) => message.commandId === commandId && (message.type === "ack" || message.type === "error"), 5_000, commandId);
    const startedAt = performance.now();
    this.socket.send(JSON.stringify({ type: "command", commandId, action: "participant.ready", payload: { ready } }));
    const response = await responsePromise;
    const latency = performance.now() - startedAt;
    if (response.type !== "ack") throw new Error(`${this.roomId} command rejected with ${response.code ?? "UNKNOWN"}`);
    return { latency, seq: response.seq };
  }

  async close() {
    if (!this.socket) return;
    const socket = this.socket;
    this.socket = null;
    if (socket.readyState === WebSocket.CLOSED) return;
    await new Promise((resolveClose) => {
      const timer = setTimeout(() => { socket.terminate(); resolveClose(); }, 2_000);
      socket.once("close", () => { clearTimeout(timer); resolveClose(); });
      socket.close(1000, "load reconnect");
    });
  }
}

async function canonicalState(origin, room) {
  const response = await fetch(new URL(`/api/v1/rooms/${room.roomId}/state`, origin), {
    headers: sameOriginBrowserHeaders(origin, { Cookie: room.sessions[0].cookie }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.data?.snapshot) throw new Error(`${room.roomId} state request failed with ${response.status}`);
  return body.data.snapshot;
}

function findD1Rows(value) {
  if (Array.isArray(value)) {
    if (value.every((item) => item && typeof item === "object") && value.some((item) => "room_id" in item)) return value;
    for (const child of value) {
      const rows = findD1Rows(child);
      if (rows) return rows;
    }
  } else if (value && typeof value === "object") {
    for (const child of Object.values(value)) {
      const rows = findD1Rows(child);
      if (rows) return rows;
    }
  }
  return null;
}

async function readProjectionRows(options, roomIds) {
  const quoted = roomIds.map((roomId) => `'${roomId}'`).join(",");
  const sql = `SELECT room_id, sequence, projected_at_ms FROM room_projections WHERE room_id IN (${quoted})`;
  const mode = options.projectionMode ?? (new URL(options.target).protocol === "https:" ? "remote" : "local");
  const args = [
    "wrangler", "d1", "execute", options.projectionDatabase,
    "--config", "wrangler.jsonc", `--${mode}`, "--json", "--command", sql,
  ];
  if (options.wranglerEnv) args.push("--env", options.wranglerEnv);
  const { stdout } = await execFileAsync("npx", args, { cwd: resolve(import.meta.dirname, ".."), maxBuffer: 4 * 1024 * 1024 });
  const rows = findD1Rows(JSON.parse(stdout));
  if (!rows) throw new Error("Wrangler D1 output did not contain projection rows");
  return rows;
}

async function measureProjection(options, expected, committedAt) {
  if (!options.projectionDatabase) return [];
  const pending = new Map(expected);
  const observed = [];
  const deadline = Date.now() + options.projectionTimeoutMs;
  while (pending.size > 0 && Date.now() < deadline) {
    const rows = await readProjectionRows(options, [...pending.keys()]);
    for (const row of rows) {
      const expectedSeq = pending.get(row.room_id);
      if (expectedSeq !== undefined && Number(row.sequence) >= expectedSeq) {
        observed.push(Date.now() - committedAt.get(row.room_id));
        pending.delete(row.room_id);
      }
    }
    if (pending.size > 0) await delay(250);
  }
  if (pending.size > 0) throw new Error(`Projection timeout for ${[...pending.keys()].join(", ")}`);
  return observed;
}

async function reconnect(clients, metrics) {
  await Promise.all(clients.map((client) => client.close()));
  const latencies = await Promise.all(clients.map((client) => client.connect(client.latestSeq)));
  metrics.reconnectMs.push(...latencies);
}

async function commandWave(roomGroups, metrics, cycle) {
  const ready = cycle % 2 === 0;
  const committedAt = new Map();
  const expectedSeq = new Map();
  await Promise.all(roomGroups.map(async ({ room, clients }) => {
    const results = await Promise.allSettled(clients.map((client) => client.command(ready)));
    for (const result of results) {
      if (result.status === "fulfilled") {
        metrics.ackMs.push(result.value.latency);
        expectedSeq.set(room.roomId, Math.max(expectedSeq.get(room.roomId) ?? 0, result.value.seq));
      } else {
        metrics.commandErrors.push(result.reason instanceof Error ? result.reason.message : "Unknown command error");
      }
    }
    committedAt.set(room.roomId, Date.now());
  }));
  return { expectedSeq, committedAt };
}

async function verifyConvergence(origin, roomGroups, metrics, expectedSeq) {
  await delay(300);
  for (const { room, clients } of roomGroups) {
    const snapshot = await canonicalState(origin, room);
    const expected = expectedSeq.get(room.roomId) ?? snapshot.seq;
    if (snapshot.seq < expected) metrics.divergence.push(`${room.roomId}: canonical seq ${snapshot.seq} < acknowledged ${expected}`);
    for (const client of clients) {
      if (client.latestSeq < snapshot.seq) metrics.divergence.push(`${room.roomId}: client seq ${client.latestSeq} < canonical ${snapshot.seq}`);
    }
    metrics.finalSnapshots[room.roomId] = { seq: snapshot.seq, digest: digest(snapshot) };
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) return console.log(usage());
  if (!options.manifest) throw new Error("--manifest is required; session cookies must never be passed on the command line");
  const target = new URL(options.target);
  if (!["http:", "https:"].includes(target.protocol)) throw new Error("Target must be an HTTP(S) origin");
  if (target.pathname !== "/" || target.search || target.hash) throw new Error("Target must be an origin without a path, query, or fragment");
  const production = target.hostname === "unijam.ashlr.ai";
  if (production && (!options.allowProduction || options.productionConfirmation !== PRODUCTION_CONFIRMATION)) {
    throw new Error(`Production is blocked without --allow-production and --production-confirmation ${PRODUCTION_CONFIRMATION}`);
  }
  if (production && options.profile === "soak" && options.durationMinutes < 60) {
    throw new Error("Production soak duration cannot be shortened below 60 minutes");
  }
  if (options.requireProjection && !options.projectionDatabase) throw new Error("--require-projection requires --projection-database");
  if (options.projectionMode && !["local", "remote"].includes(options.projectionMode)) throw new Error("--projection-mode must be local or remote");
  if (production && options.wranglerEnv !== "production") throw new Error("Production load requires --wrangler-env production for projection isolation");

  const manifestSource = await readFile(resolve(options.manifest), "utf8");
  const manifest = JSON.parse(manifestSource);
  const rooms = validateManifest(manifest, options.profile, target.origin);
  const expectedCandidate = validateCandidateReference(manifest.candidate, "Load manifest candidate");
  const remoteEnvironment = target.origin === "https://staging.unijam.ashlr.ai" ? "staging"
    : target.origin === "https://unijam.ashlr.ai" ? "production"
      : null;
  if (options.wranglerEnv && options.wranglerEnv !== remoteEnvironment) throw new Error("Load target and Wrangler environment do not match");
  const metrics = {
    ackMs: [], reconnectMs: [], projectionMs: [], commandErrors: [], divergence: [],
    malformedMessages: 0, deliveryDuplicateEvents: 0, canonicalEventConflicts: 0,
    canonicalEvents: new Map(), finalSnapshots: {},
  };
  const roomGroups = rooms.map((room) => ({
    room,
    clients: room.sessions.map((session) => new RoomSocket({ origin: target.origin, roomId: room.roomId, session, metrics })),
  }));
  const clients = roomGroups.flatMap((group) => group.clients);
  const candidateBefore = remoteEnvironment ? await queryActiveCandidate({
    environment: remoteEnvironment,
    expectedCommit: expectedCandidate.commit,
    expectedCandidate: expectedCandidate,
    requireClean: true,
    requireOperatorUndeployed: true,
  }) : null;
  const startedAt = new Date();
  console.log(`Starting ${options.profile} against ${target.origin}: ${rooms.length} room(s), ${clients.length} authenticated connections.`);
  if (!options.projectionDatabase) console.log("Projection lag is not measured; use --projection-database and --require-projection for a release gate.");

  let runError;
  try {
    const initialConnections = await Promise.all(clients.map((client) => client.connect(0)));
    metrics.reconnectMs.push(...initialConnections);
    if (options.profile === "smoke") {
      const wave = await commandWave(roomGroups, metrics, 0);
      metrics.projectionMs.push(...await measureProjection(options, wave.expectedSeq, wave.committedAt));
      await verifyConvergence(target.origin, roomGroups, metrics, wave.expectedSeq);
      await reconnect(clients, metrics);
      await verifyConvergence(target.origin, roomGroups, metrics, wave.expectedSeq);
    } else {
      const deadline = Date.now() + options.durationMinutes * 60_000;
      let cycle = 0;
      let nextReconnect = Date.now() + options.reconnectSeconds * 1_000;
      while (Date.now() < deadline) {
        const cycleStarted = Date.now();
        const wave = await commandWave(roomGroups, metrics, cycle);
        metrics.projectionMs.push(...await measureProjection(options, wave.expectedSeq, wave.committedAt));
        await verifyConvergence(target.origin, roomGroups, metrics, wave.expectedSeq);
        if (Date.now() >= nextReconnect) {
          await reconnect(clients, metrics);
          nextReconnect = Date.now() + options.reconnectSeconds * 1_000;
        }
        cycle += 1;
        const remaining = options.cycleSeconds * 1_000 - (Date.now() - cycleStarted);
        if (remaining > 0) await delay(Math.min(remaining, Math.max(0, deadline - Date.now())));
      }
    }
  } catch (error) {
    runError = error;
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
  }
  const finishedAt = new Date();
  let candidateAfter = null;
  let postRunCandidateError;
  if (remoteEnvironment) {
    try {
      candidateAfter = await queryActiveCandidate({
        environment: remoteEnvironment,
        expectedCommit: expectedCandidate.commit,
        expectedCandidate: expectedCandidate,
        requireClean: true,
        requireOperatorUndeployed: true,
      });
    } catch (error) {
      postRunCandidateError = error;
    }
  }
  if (runError && postRunCandidateError) throw new AggregateError([runError, postRunCandidateError], "Load run and post-run candidate verification both failed");
  if (postRunCandidateError) throw postRunCandidateError;
  if (runError) throw runError;
  const deploymentWindow = remoteEnvironment && candidateBefore && candidateAfter
    ? assertCandidateWindow(candidateBefore, candidateAfter, expectedCandidate, `${options.profile} load`)
    : null;
  const ackP95 = percentile(metrics.ackMs, 95);
  const reconnectP95 = percentile(metrics.reconnectMs, 95);
  const projectionP95 = percentile(metrics.projectionMs, 95);
  const gates = {
    acknowledgements: ackP95 !== null && ackP95 < options.ackP95Ms,
    reconnect: reconnectP95 !== null && reconnectP95 < options.reconnectP95Ms,
    projection: options.requireProjection ? projectionP95 !== null && projectionP95 < options.projectionP95Ms : true,
    zeroDivergence: metrics.divergence.length === 0,
    zeroCommandErrors: metrics.commandErrors.length === 0,
    zeroMalformedMessages: metrics.malformedMessages === 0,
    zeroDuplicateDeliveries: metrics.deliveryDuplicateEvents === 0,
    zeroCanonicalEventConflicts: metrics.canonicalEventConflicts === 0,
  };
  const report = {
    version: 2,
    profile: options.profile,
    target: target.origin,
    production,
    releaseEvidence: remoteEnvironment !== null,
    candidate: expectedCandidate,
    manifestSha256: createHash("sha256").update(manifestSource).digest("hex"),
    deploymentWindow,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    rooms: rooms.length,
    connections: clients.length,
    thresholds: { ackP95Ms: options.ackP95Ms, reconnectP95Ms: options.reconnectP95Ms, projectionP95Ms: options.projectionP95Ms },
    measurements: {
      acknowledgementCount: metrics.ackMs.length,
      acknowledgementP95Ms: ackP95,
      reconnectCount: metrics.reconnectMs.length,
      reconnectP95Ms: reconnectP95,
      projectionCount: metrics.projectionMs.length,
      projectionP95Ms: projectionP95,
      projectionRequired: options.requireProjection,
      divergence: metrics.divergence,
      commandErrors: metrics.commandErrors,
      malformedMessages: metrics.malformedMessages,
      deliveryDuplicateEvents: metrics.deliveryDuplicateEvents,
      canonicalEventConflicts: metrics.canonicalEventConflicts,
      canonicalEventCount: metrics.canonicalEvents.size,
      finalSnapshots: metrics.finalSnapshots,
    },
    gates,
    passed: Object.values(gates).every(Boolean),
  };
  const defaultOutput = resolve("test-results", "load", `${options.profile}-${startedAt.toISOString().replace(/[:.]/g, "-")}.json`);
  const output = resolve(options.output ?? defaultOutput);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ passed: report.passed, output, gates, measurements: {
    acknowledgementP95Ms: ackP95, reconnectP95Ms: reconnectP95, projectionP95Ms: projectionP95,
    divergence: metrics.divergence.length, commandErrors: metrics.commandErrors.length,
    deliveryDuplicateEvents: metrics.deliveryDuplicateEvents, canonicalEventConflicts: metrics.canonicalEventConflicts,
  } }, null, 2));
  if (!report.passed) process.exitCode = 1;
}

const isDirectExecution = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectExecution) {
  main().catch((error) => {
    console.error(`Load harness failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    process.exitCode = 1;
  });
}
