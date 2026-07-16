#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";

import { sameOriginBrowserHeaders } from "./release-request-headers.mjs";

export const STAGING_ORIGIN = "https://staging.unijam.ashlr.ai";
const MINIMUM_HIBERNATION_IDLE_SECONDS = 12;
const DEFAULT_IDLE_SECONDS = 15;
const DEFAULT_TIMEOUT_MS = 10_000;

export function usage() {
  return `UniJam staging hibernation and revocation assurance

Usage:
  node scripts/verify-room-hibernation.mjs --manifest <private.json> [options]

Required fixture:
  A disposable staging room with a recently passkey-confirmed host session and
  one active guest session. The run rotates the invite and logs the host out.

Options:
  --target <origin>       Must be exactly ${STAGING_ORIGIN}
  --idle-seconds <n>      Inactivity before wake-up; minimum ${MINIMUM_HIBERNATION_IDLE_SECONDS}, default ${DEFAULT_IDLE_SECONDS}
  --timeout-ms <n>        Per-operation timeout; default ${DEFAULT_TIMEOUT_MS}
  --output <path>         Redacted JSON evidence path
`;
}

export function parseArguments(argv) {
  const options = {
    target: STAGING_ORIGIN,
    idleSeconds: DEFAULT_IDLE_SECONDS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  const valueFlags = new Set(["manifest", "target", "idle-seconds", "timeout-ms", "output"]);
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (raw === "--help" || raw === "-h") return { help: true };
    if (!raw.startsWith("--") || !valueFlags.has(raw.slice(2))) throw new Error(`Unknown argument: ${raw}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${raw} requires a value`);
    index += 1;
    const key = raw.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    options[key] = value;
  }
  options.idleSeconds = Number(options.idleSeconds);
  options.timeoutMs = Number(options.timeoutMs);
  if (!Number.isFinite(options.idleSeconds) || options.idleSeconds < MINIMUM_HIBERNATION_IDLE_SECONDS || options.idleSeconds > 300) {
    throw new Error(`idleSeconds must be between ${MINIMUM_HIBERNATION_IDLE_SECONDS} and 300`);
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1_000 || options.timeoutMs > 60_000) {
    throw new Error("timeoutMs must be between 1000 and 60000");
  }
  return options;
}

export function validateStagingTarget(value) {
  let target;
  try { target = new URL(value); }
  catch { throw new Error("Target must be a valid URL"); }
  if (target.origin !== STAGING_ORIGIN || target.pathname !== "/" || target.search || target.hash) {
    throw new Error(`Remote hibernation assurance is staging-only and requires exactly ${STAGING_ORIGIN}`);
  }
  return target.origin;
}

function validateCookie(value, name) {
  if (typeof value !== "string" || value.length > 4_096 || /[;\r\n\s]/.test(value)) {
    throw new Error(`${name} must be one bounded Cookie header pair`);
  }
  const prefix = `${name}=`;
  if (!value.startsWith(prefix) || value.length < prefix.length + 20) {
    throw new Error(`${name} is missing or malformed`);
  }
  return value;
}

export function validateManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1) {
    throw new Error("Assurance manifest must be a version 1 object");
  }
  if (value.origin !== STAGING_ORIGIN) throw new Error("Assurance manifest origin does not match staging");
  if (value.disposable !== true) throw new Error("Assurance manifest must explicitly mark the room disposable");
  const roomId = typeof value.roomId === "string" ? value.roomId.trim().toUpperCase() : "";
  if (!/^[A-Z0-9]{6,16}$/.test(roomId)) throw new Error("Assurance roomId is malformed");
  const hostCookie = validateCookie(value.hostCookie, "__Host-unijam_host");
  const guestCookie = validateCookie(value.guestCookie, "__Host-unijam_guest");
  return { roomId, hostCookie, guestCookie };
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function socketUrl(origin, roomId) {
  const url = new URL(`/api/v1/rooms/${roomId}/websocket`, origin);
  url.protocol = "wss:";
  return url.toString();
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

class ProbeSocket {
  constructor({ origin, roomId, cookie, timeoutMs }) {
    this.origin = origin;
    this.roomId = roomId;
    this.cookie = cookie;
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.messages = [];
    this.waiters = new Set();
  }

  async connect() {
    const socket = new WebSocket(socketUrl(this.origin, this.roomId), {
      headers: sameOriginBrowserHeaders(this.origin, { Cookie: this.cookie }),
      handshakeTimeout: this.timeoutMs,
      maxPayload: 128 * 1024,
      perMessageDeflate: false,
    });
    this.socket = socket;
    socket.on("message", (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); }
      catch { return; }
      this.messages.push(message);
      if (this.messages.length > 50) this.messages.shift();
      for (const waiter of this.waiters) {
        if (!waiter.predicate(message)) continue;
        this.waiters.delete(waiter);
        waiter.resolve(message);
      }
    });
    await withTimeout(new Promise((resolveOpen, rejectOpen) => {
      socket.once("open", resolveOpen);
      socket.once("unexpected-response", (_request, response) => rejectOpen(new Error(`WebSocket rejected with status ${response.statusCode}`)));
      socket.once("error", rejectOpen);
    }), this.timeoutMs, "WebSocket upgrade");
  }

  waitFor(predicate, label) {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return withTimeout(new Promise((resolveWaiter) => {
      const waiter = { predicate, resolve: resolveWaiter };
      this.waiters.add(waiter);
    }), this.timeoutMs, label);
  }

  async hello(lastSeq) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error("WebSocket is not open");
    const response = this.waitFor(
      (message) => (message.type === "snapshot" || message.type === "events") && Number.isSafeInteger(message.latestSeq),
      "hello state",
    );
    this.socket.send(JSON.stringify({
      type: "hello",
      protocol: 1,
      lastSeq,
      clientInstanceId: `assurance_${randomUUID()}`,
    }));
    const message = await response;
    this.messages = this.messages.filter((candidate) => candidate !== message);
    return message.latestSeq;
  }

  expectClose(code) {
    if (!this.socket) throw new Error("WebSocket is not initialized");
    return withTimeout(new Promise((resolveClose, rejectClose) => {
      this.socket.once("close", (actualCode) => {
        if (actualCode !== code) rejectClose(new Error(`WebSocket closed with ${actualCode}; expected ${code}`));
        else resolveClose(actualCode);
      });
    }), this.timeoutMs, `WebSocket close ${code}`);
  }

  destroy() {
    if (!this.socket || this.socket.readyState === WebSocket.CLOSED) return;
    this.socket.terminate();
  }
}

async function jsonPost(origin, path, cookie, timeoutMs) {
  const response = await fetch(new URL(path, origin), {
    method: "POST",
    headers: sameOriginBrowserHeaders(origin, { Cookie: cookie, "Content-Type": "application/json" }),
    body: "{}",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

async function expectUpgradeRejected(origin, roomId, cookie, timeoutMs) {
  const socket = new WebSocket(socketUrl(origin, roomId), {
    headers: sameOriginBrowserHeaders(origin, { Cookie: cookie }),
    handshakeTimeout: timeoutMs,
    maxPayload: 128 * 1024,
    perMessageDeflate: false,
  });
  return withTimeout(new Promise((resolveRejected, rejectRejected) => {
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      socket.terminate();
      resolveRejected(response.statusCode);
    });
    socket.once("open", () => {
      socket.terminate();
      rejectRejected(new Error("Revoked session unexpectedly opened a WebSocket"));
    });
    socket.once("error", (error) => rejectRejected(new Error(`Revoked-session upgrade failed without an HTTP status: ${error.message}`)));
  }), timeoutMs, "revoked-session WebSocket rejection");
}

export async function runAssurance({ origin, manifest, idleSeconds, timeoutMs }) {
  origin = validateStagingTarget(origin);
  const host = new ProbeSocket({ origin, roomId: manifest.roomId, cookie: manifest.hostCookie, timeoutMs });
  const guest = new ProbeSocket({ origin, roomId: manifest.roomId, cookie: manifest.guestCookie, timeoutMs });
  const startedAt = new Date().toISOString();
  try {
    await Promise.all([host.connect(), guest.connect()]);
    const [hostInitialSeq, guestInitialSeq] = await Promise.all([host.hello(0), guest.hello(0)]);

    const idleStartedAt = new Date().toISOString();
    await delay(idleSeconds * 1_000);
    const [hostResumeSeq, guestResumeSeq] = await Promise.all([
      host.hello(hostInitialSeq),
      guest.hello(guestInitialSeq),
    ]);
    const idleCompletedAt = new Date().toISOString();

    const guestClosed = guest.expectClose(1008);
    const rotation = await jsonPost(origin, `/api/v1/rooms/${manifest.roomId}/invite/rotate`, manifest.hostCookie, timeoutMs);
    if (rotation.status !== 200 || rotation.body?.error || rotation.body?.data?.roomEventRecorded !== true) {
      throw new Error(`Invite rotation failed with status ${rotation.status}`);
    }
    const guestCloseCode = await guestClosed;
    const guestRejectedStatus = await expectUpgradeRejected(origin, manifest.roomId, manifest.guestCookie, timeoutMs);
    if (guestRejectedStatus !== 401) throw new Error(`Revoked guest upgrade returned ${guestRejectedStatus}; expected 401`);

    const logout = await jsonPost(origin, "/api/v1/auth/logout", manifest.hostCookie, timeoutMs);
    if (logout.status !== 200 || logout.body?.error || logout.body?.data?.loggedOut !== true) {
      throw new Error(`Host logout failed with status ${logout.status}`);
    }
    const hostClosed = host.expectClose(1008);
    host.socket.send(JSON.stringify({
      type: "hello",
      protocol: 1,
      lastSeq: hostResumeSeq,
      clientInstanceId: `assurance_${randomUUID()}`,
    }));
    const hostCloseCode = await hostClosed;
    const hostRejectedStatus = await expectUpgradeRejected(origin, manifest.roomId, manifest.hostCookie, timeoutMs);
    if (hostRejectedStatus !== 401) throw new Error(`Revoked host upgrade returned ${hostRejectedStatus}; expected 401`);

    return {
      schemaVersion: 1,
      kind: "unijam-room-hibernation-assurance",
      targetOrigin: origin,
      startedAt,
      completedAt: new Date().toISOString(),
      idleWindow: {
        requestedSeconds: idleSeconds,
        startedAt: idleStartedAt,
        completedAt: idleCompletedAt,
        hostConnectionResumedWithoutReconnect: true,
        guestConnectionResumedWithoutReconnect: true,
        hostInitialSeq,
        hostResumeSeq,
        guestInitialSeq,
        guestResumeSeq,
      },
      guestRevocation: {
        rotationStatus: rotation.status,
        roomEventRecorded: true,
        existingSocketCloseCode: guestCloseCode,
        revokedCookieUpgradeStatus: guestRejectedStatus,
      },
      hostRevocation: {
        logoutStatus: logout.status,
        existingSocketCloseCode: hostCloseCode,
        revokedCookieUpgradeStatus: hostRejectedStatus,
      },
      passed: true,
      redaction: "No cookies, capabilities, participant identity, room identity, or response bodies are recorded.",
    };
  } finally {
    host.destroy();
    guest.destroy();
  }
}

export function redactError(value) {
  return String(value)
    .replace(/__Host-unijam_(?:host|guest)=[^;\s]+/g, "[REDACTED_SESSION]")
    .replace(/#cap=[^\s]+/g, "#cap=[REDACTED]")
    .replace(/\/api\/v1\/rooms\/[A-Z0-9]{6,16}\/websocket/gi, "/api/v1/rooms/[REDACTED]/websocket");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  // Validate the destination before reading the credential-bearing manifest.
  const origin = validateStagingTarget(options.target);
  if (!options.manifest) throw new Error("--manifest is required");
  const manifest = validateManifest(JSON.parse(await readFile(resolve(options.manifest), "utf8")));
  const evidence = await runAssurance({ origin, manifest, idleSeconds: options.idleSeconds, timeoutMs: options.timeoutMs });
  const safeTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const output = resolve(options.output ?? `test-results/assurance/room-hibernation-${safeTimestamp}.json`);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  await chmod(output, 0o600);
  process.stdout.write(`PASS: staging hibernation and revocation assurance. Redacted evidence: ${output}\n`);
}

const isDirectExecution = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectExecution) {
  main().catch((error) => {
    process.stderr.write(`Assurance failed: ${redactError(error instanceof Error ? error.message : error)}\n`);
    process.exitCode = 1;
  });
}
