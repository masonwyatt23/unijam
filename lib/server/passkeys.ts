import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

import { prepareHostSession } from "./host-session.ts";
import { prepareRecoveryCodes } from "./recovery-codes.ts";
import { hashOpaqueToken } from "./secure-token.ts";

const CHALLENGE_TTL_MS = 5 * 60_000;

export type PasskeyRuntimeConfig = {
  APP_ENV?: string;
  APP_ORIGIN?: string;
  WEBAUTHN_RP_ID?: string;
};

type CredentialRow = {
  credential_id: string;
  account_id: string;
  public_key_base64: string;
  counter: number;
  transports_json: string;
};

function bytesToBase64(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const decoded = atob(normalized);
  const bytes = new Uint8Array(new ArrayBuffer(decoded.length));
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes;
}

export function passkeyConfig(env: PasskeyRuntimeConfig): { origin: string; rpId: string } {
  if (env.APP_ENV === "staging") {
    return { origin: "https://staging.unijam.ashlr.ai", rpId: "staging.unijam.ashlr.ai" };
  }
  if (env.APP_ENV === "development") {
    return {
      origin: env.APP_ORIGIN ?? "http://localhost:3000",
      rpId: env.WEBAUTHN_RP_ID ?? "localhost",
    };
  }
  return { origin: "https://unijam.ashlr.ai", rpId: "unijam.ashlr.ai" };
}

export function registrationAccountId(
  ceremony: "registration" | "public_registration" | "additional_registration",
  authenticatedAccountId?: string,
): string {
  if (ceremony === "registration" || ceremony === "public_registration") return crypto.randomUUID();
  if (!authenticatedAccountId) throw new Error("A recent authenticated passkey session is required");
  return authenticatedAccountId;
}

export function assertCounterAdvanced(oldCounter: number, newCounter: number, changes: number): void {
  if ((oldCounter > 0 || newCounter > 0) && changes !== 1) {
    throw new Error("Passkey counter changed during verification");
  }
}

export function normalizeEnrollmentCode(value: string): string {
  const code = value.trim().toUpperCase();
  if (!/^[A-Z0-9-]{12,128}$/.test(code)) throw new Error("Pilot enrollment is unavailable");
  return code;
}

/**
 * WebAuthn requires a device-visible username even though UniJam authenticates
 * by opaque account ID. The opaque user ID already provides uniqueness, so the
 * device-visible label must not disclose any part of UniJam's internal ID.
 */
export function bootstrapPasskeyUserName(displayName: string): string {
  return displayName;
}

/** Keep bootstrap identity validation identical at options and verification. */
export function normalizeBootstrapDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const displayName = value.trim();
  return displayName && displayName.length <= 80 && !/[\u0000-\u001f\u007f]/.test(displayName)
    ? displayName
    : null;
}

/**
 * New challenges own the normalized name. A null challenge value is accepted
 * only for a five-minute, pre-migration ceremony already in flight.
 */
export function resolveBootstrapDisplayName(challengeDisplayName: string | null, submittedDisplayName: unknown): string {
  const submitted = normalizeBootstrapDisplayName(submittedDisplayName);
  if (!submitted) throw new Error("Bootstrap display name is invalid");
  if (challengeDisplayName === null) return submitted;
  const stored = normalizeBootstrapDisplayName(challengeDisplayName);
  if (!stored || stored !== submitted) throw new Error("Bootstrap display name does not match the registration challenge");
  return stored;
}

async function saveChallenge(
  db: D1Database,
  challenge: string,
  kind: "registration" | "public_registration" | "additional_registration" | "authentication",
  accountId: string | null,
  enrollmentCodeHash: string | null = null,
  displayName: string | null = null,
  now = Date.now(),
): Promise<void> {
  await db.prepare(
    `INSERT INTO passkey_challenges (challenge_hash, challenge, kind, account_id, enrollment_code_hash, display_name, expires_at_ms, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(await hashOpaqueToken(challenge), challenge, kind, accountId, enrollmentCodeHash, displayName, now + CHALLENGE_TTL_MS, now).run();
  await db.prepare("DELETE FROM passkey_challenges WHERE expires_at_ms <= ?").bind(now).run();
}

type StoredChallenge = { challenge_hash: string; account_id: string | null; enrollment_code_hash: string | null; display_name: string | null };

export type VerifiedRegistrationCommit = {
  accountId: string;
  displayName: string;
  ceremony: "registration" | "public_registration" | "additional_registration";
  challengeHash: string;
  enrollmentCodeHash: string | null;
  credential: {
    id: string;
    publicKeyBase64: string;
    counter: number;
    transportsJson: string;
    deviceType: string;
    backedUp: boolean;
  };
  recoverySessionId?: string;
  now: number;
  consumptionMarker: number;
};

async function loadChallenge(
  db: D1Database,
  challenge: string,
  kind: "registration" | "public_registration" | "additional_registration" | "authentication",
): Promise<StoredChallenge | null> {
  const now = Date.now();
  const challengeHash = await hashOpaqueToken(challenge);
  const row = await db.prepare(
    `SELECT challenge_hash, account_id, enrollment_code_hash, display_name FROM passkey_challenges
     WHERE challenge_hash = ? AND kind = ? AND expires_at_ms > ? AND consumed_at_ms IS NULL LIMIT 1`,
  ).bind(challengeHash, kind, now).first<StoredChallenge>();
  return row ?? null;
}

function challengeConsumption(db: D1Database, challengeHash: string, consumptionMarker: number, now: number): D1PreparedStatement {
  return db.prepare(
    "UPDATE passkey_challenges SET consumed_at_ms = ? WHERE challenge_hash = ? AND consumed_at_ms IS NULL AND expires_at_ms > ?",
  ).bind(consumptionMarker, challengeHash, now);
}

function registrationCommitGuard(
  db: D1Database,
  challengeHash: string,
  consumptionMarker: number,
  credentialId: string,
  accountId: string,
): D1PreparedStatement {
  // D1 batches are transactions, but a conditional compare-and-swap that
  // affects zero rows is still a successful SQL statement. Make a lost CAS a
  // statement error so D1 rolls back every bootstrap side effect, including
  // recovery codes and the initial session.
  return db.prepare(
    `SELECT CASE WHEN EXISTS (
       SELECT 1 FROM passkey_challenges
       WHERE challenge_hash = ? AND consumed_at_ms = ?
     ) AND EXISTS (
       SELECT 1 FROM passkeys WHERE credential_id = ? AND account_id = ?
     ) THEN 1 ELSE json_extract('registration commit conflict', '$') END AS committed`,
  ).bind(challengeHash, consumptionMarker, credentialId, accountId);
}

/**
 * Atomically commits a registration that has already passed WebAuthn
 * verification. Exported so the real D1 concurrency contract can be tested
 * without replacing the cryptographic verifier.
 */
export async function commitVerifiedRegistration(
  db: D1Database,
  input: VerifiedRegistrationCommit,
  completionStatements: D1PreparedStatement[] = [],
): Promise<void> {
  const credentialValues = [
    input.credential.id,
    input.accountId,
    input.credential.publicKeyBase64,
    input.credential.counter,
    input.credential.transportsJson,
    input.credential.deviceType,
    input.credential.backedUp ? 1 : 0,
    input.now,
    input.now,
  ] as const;
  const passkeyInsert = input.recoverySessionId
    ? db.prepare(
      `INSERT INTO passkeys
       (credential_id, account_id, public_key_base64, counter, transports_json, device_type, backed_up, created_at_ms, last_used_at_ms)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM host_sessions
         WHERE session_id = ? AND account_id = ? AND passkey_verified_at_ms IS NULL
           AND recovery_enrollment_consumed_at_ms IS NULL AND recovery_enrollment_expires_at_ms > ?
       ) AND EXISTS (
         SELECT 1 FROM passkey_challenges WHERE challenge_hash = ? AND consumed_at_ms = ?
       )`,
    ).bind(
      ...credentialValues,
      input.recoverySessionId,
      input.accountId,
      input.now,
      input.challengeHash,
      input.consumptionMarker,
    )
    : db.prepare(
      `INSERT INTO passkeys
       (credential_id, account_id, public_key_base64, counter, transports_json, device_type, backed_up, created_at_ms, last_used_at_ms)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM passkey_challenges WHERE challenge_hash = ? AND consumed_at_ms = ?
       ) AND EXISTS (
         SELECT 1 FROM accounts WHERE account_id = ? AND deleted_at_ms IS NULL
       )`,
    ).bind(...credentialValues, input.challengeHash, input.consumptionMarker, input.accountId);
  const statements = [
    challengeConsumption(db, input.challengeHash, input.consumptionMarker, input.now),
    passkeyInsert,
  ];
  if (input.ceremony === "registration") {
    if (!input.enrollmentCodeHash) throw new Error("Pilot enrollment is unavailable");
    statements.splice(1, 0, db.prepare(
      `UPDATE host_enrollment_codes SET used_at_ms = ?, used_by_account_id = ?
       WHERE code_hash = ? AND used_at_ms IS NULL AND expires_at_ms > ?
         AND EXISTS (
           SELECT 1 FROM passkey_challenges WHERE challenge_hash = ? AND consumed_at_ms = ?
         )`,
    ).bind(
      input.now,
      input.accountId,
      input.enrollmentCodeHash,
      input.now,
      input.challengeHash,
      input.consumptionMarker,
    ));
    statements.splice(2, 0, db.prepare(
      `INSERT INTO accounts (account_id, display_name, created_at_ms, updated_at_ms)
       SELECT ?, ?, ?, ? WHERE EXISTS (
         SELECT 1 FROM host_enrollment_codes WHERE code_hash = ? AND used_by_account_id = ? AND used_at_ms = ?
       )`,
    ).bind(
      input.accountId,
      input.displayName,
      input.now,
      input.now,
      input.enrollmentCodeHash,
      input.accountId,
      input.now,
    ));
  } else if (input.ceremony === "public_registration") {
    statements.splice(1, 0, db.prepare(
      `INSERT INTO accounts (account_id, display_name, created_at_ms, updated_at_ms)
       SELECT ?, ?, ?, ? WHERE EXISTS (
         SELECT 1 FROM passkey_challenges WHERE challenge_hash = ? AND consumed_at_ms = ?
       )`,
    ).bind(
      input.accountId,
      input.displayName,
      input.now,
      input.now,
      input.challengeHash,
      input.consumptionMarker,
    ));
  }
  if (input.ceremony === "additional_registration" && input.recoverySessionId) {
    statements.push(db.prepare(
      `UPDATE host_sessions SET recovery_enrollment_consumed_at_ms = ?
       WHERE session_id = ? AND account_id = ? AND passkey_verified_at_ms IS NULL
         AND recovery_enrollment_consumed_at_ms IS NULL AND recovery_enrollment_expires_at_ms > ?
         AND EXISTS (
           SELECT 1 FROM passkeys WHERE credential_id = ? AND account_id = ?
         )`,
    ).bind(
      input.now,
      input.recoverySessionId,
      input.accountId,
      input.now,
      input.credential.id,
      input.accountId,
    ));
  }
  statements.push(...completionStatements);
  statements.push(registrationCommitGuard(
    db,
    input.challengeHash,
    input.consumptionMarker,
    input.credential.id,
    input.accountId,
  ));
  const results = await db.batch(statements);
  // Ignore the final read-only guard. If it failed, D1 rejected and rolled
  // back the batch before returning results.
  if (results.slice(0, -1).some((result) => (result.meta.changes ?? 0) !== 1)) {
    throw new Error(input.recoverySessionId
      ? "Recovery enrollment grant is invalid or already used"
      : "Passkey registration changed concurrently");
  }
}

export async function registrationOptions(
  db: D1Database,
  env: PasskeyRuntimeConfig,
  input: { displayName: string; enrollmentCode: string },
) {
  // Bootstrap identity is always server-generated. Existing accounts use the
  // separately authenticated additional-credential ceremony below.
  const accountId = registrationAccountId("registration");
  const displayName = normalizeBootstrapDisplayName(input.displayName);
  if (!displayName) throw new Error("A valid name is required");
  const enrollmentCode = normalizeEnrollmentCode(input.enrollmentCode);
  const enrollmentCodeHash = await hashOpaqueToken(enrollmentCode);
  const enrollment = await db.prepare(
    `SELECT code_hash FROM host_enrollment_codes
     WHERE code_hash = ? AND used_at_ms IS NULL AND expires_at_ms > ? LIMIT 1`,
  ).bind(enrollmentCodeHash, Date.now()).first<{ code_hash: string }>();
  if (!enrollment) throw new Error("Pilot enrollment is unavailable");
  const { rpId } = passkeyConfig(env);
  const credentials = await db.prepare(
    "SELECT credential_id, transports_json FROM passkeys WHERE account_id = ? AND revoked_at_ms IS NULL",
  ).bind(accountId).all<{ credential_id: string; transports_json: string }>();
  const options = await generateRegistrationOptions({
    rpName: "UniJam",
    rpID: rpId,
    userID: new TextEncoder().encode(accountId),
    userName: bootstrapPasskeyUserName(displayName),
    userDisplayName: displayName,
    timeout: CHALLENGE_TTL_MS,
    attestationType: "none",
    authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
    excludeCredentials: (credentials.results ?? []).map((credential) => ({
      id: credential.credential_id,
      transports: JSON.parse(credential.transports_json) as AuthenticatorTransportFuture[],
    })),
  });
  await saveChallenge(db, options.challenge, "registration", accountId, enrollmentCodeHash, displayName);
  return { accountId, options };
}

export async function publicRegistrationOptions(
  db: D1Database,
  env: PasskeyRuntimeConfig,
  input: { displayName: string },
) {
  const accountId = registrationAccountId("public_registration");
  const displayName = normalizeBootstrapDisplayName(input.displayName);
  if (!displayName) throw new Error("A valid name is required");
  const { rpId } = passkeyConfig(env);
  const options = await generateRegistrationOptions({
    rpName: "UniJam",
    rpID: rpId,
    userID: new TextEncoder().encode(accountId),
    userName: bootstrapPasskeyUserName(displayName),
    userDisplayName: displayName,
    timeout: CHALLENGE_TTL_MS,
    attestationType: "none",
    authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
  });
  // This distinct kind prevents a pilot invite ceremony from being replayed
  // against public membership (or vice versa).
  await saveChallenge(db, options.challenge, "public_registration", accountId, null, displayName);
  return { accountId, options };
}

export async function additionalRegistrationOptions(
  db: D1Database,
  env: PasskeyRuntimeConfig,
  authenticatedAccountId: string,
  userName: string,
  displayName: string,
) {
  const accountId = registrationAccountId("additional_registration", authenticatedAccountId);
  const { rpId } = passkeyConfig(env);
  const credentials = await db.prepare(
    "SELECT credential_id, transports_json FROM passkeys WHERE account_id = ? AND revoked_at_ms IS NULL",
  ).bind(accountId).all<{ credential_id: string; transports_json: string }>();
  const options = await generateRegistrationOptions({
    rpName: "UniJam", rpID: rpId, userID: new TextEncoder().encode(accountId),
    userName, userDisplayName: displayName, timeout: CHALLENGE_TTL_MS, attestationType: "none",
    authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
    excludeCredentials: (credentials.results ?? []).map((credential) => ({
      id: credential.credential_id,
      transports: JSON.parse(credential.transports_json) as AuthenticatorTransportFuture[],
    })),
  });
  await saveChallenge(db, options.challenge, "additional_registration", accountId);
  return { accountId, options };
}

export async function finishRegistration(
  db: D1Database,
  env: PasskeyRuntimeConfig,
  input: { accountId: string; displayName: string; response: RegistrationResponseJSON },
  ceremony: "registration" | "public_registration" | "additional_registration" = "registration",
  recoverySessionId?: string,
  completionStatements: D1PreparedStatement[] = [],
): Promise<{ accountId: string; credentialId: string }> {
  const challenge = input.response.response.clientDataJSON;
  const clientData = JSON.parse(new TextDecoder().decode(base64ToBytes(challenge))) as { challenge?: string };
  if (!clientData.challenge) throw new Error("Registration challenge is missing");
  const stored = await loadChallenge(db, clientData.challenge, ceremony);
  if (!stored || stored.account_id !== input.accountId) throw new Error("Registration challenge is invalid or expired");
  const displayName = ceremony === "registration" || ceremony === "public_registration"
    ? resolveBootstrapDisplayName(stored.display_name, input.displayName)
    : input.displayName;
  const { origin, rpId } = passkeyConfig(env);
  const verification = await verifyRegistrationResponse({
    response: input.response,
    expectedChallenge: clientData.challenge,
    expectedOrigin: origin,
    expectedRPID: rpId,
    requireUserVerification: true,
  });
  if (!verification.verified) throw new Error("Passkey registration could not be verified");
  const now = Date.now();
  // This value links conditional statements inside one D1 batch; it is not a
  // timestamp. A full uint32 avoids modulo bias and makes concurrent-marker
  // collision negligibly likely.
  const consumptionMarker = crypto.getRandomValues(new Uint32Array(1))[0];
  const info = verification.registrationInfo;
  if (ceremony === "additional_registration") {
    const account = await db.prepare("SELECT account_id FROM accounts WHERE account_id = ? AND deleted_at_ms IS NULL LIMIT 1")
      .bind(input.accountId).first<{ account_id: string }>();
    if (!account) throw new Error("Authenticated account no longer exists");
  }
  await commitVerifiedRegistration(db, {
    accountId: input.accountId,
    displayName,
    ceremony,
    challengeHash: stored.challenge_hash,
    enrollmentCodeHash: stored.enrollment_code_hash,
    credential: {
      id: info.credential.id,
      publicKeyBase64: bytesToBase64(info.credential.publicKey),
      counter: info.credential.counter,
      transportsJson: JSON.stringify(info.credential.transports ?? []),
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
    },
    recoverySessionId,
    now,
    consumptionMarker,
  }, completionStatements);
  return { accountId: input.accountId, credentialId: info.credential.id };
}

export async function finishBootstrapRegistration(
  db: D1Database,
  env: PasskeyRuntimeConfig,
  input: { accountId: string; displayName: string; response: RegistrationResponseJSON },
  mode: "pilot" | "public",
): Promise<{ accountId: string; credentialId: string; recoveryCodes: string[]; sessionCookie: string }> {
  const now = Date.now();
  const recovery = await prepareRecoveryCodes(db, input.accountId, now);
  const session = await prepareHostSession(db, input.accountId, "passkey", now);
  const result = await finishRegistration(
    db,
    env,
    input,
    mode === "pilot" ? "registration" : "public_registration",
    undefined,
    [...recovery.statements, session.statement],
  );
  return { ...result, recoveryCodes: recovery.codes, sessionCookie: session.cookie };
}

export async function authenticationOptions(db: D1Database, env: PasskeyRuntimeConfig) {
  const { rpId } = passkeyConfig(env);
  const options = await generateAuthenticationOptions({
    rpID: rpId,
    timeout: CHALLENGE_TTL_MS,
    userVerification: "required",
  });
  await saveChallenge(db, options.challenge, "authentication", null);
  return options;
}

export async function finishAuthentication(
  db: D1Database,
  env: PasskeyRuntimeConfig,
  response: AuthenticationResponseJSON,
): Promise<{ accountId: string; credentialId: string }> {
  const clientData = JSON.parse(new TextDecoder().decode(base64ToBytes(response.response.clientDataJSON))) as { challenge?: string };
  if (!clientData.challenge) throw new Error("Authentication challenge is missing");
  const challenge = await loadChallenge(db, clientData.challenge, "authentication");
  if (!challenge) throw new Error("Authentication challenge is invalid or expired");
  const credential = await db.prepare(
    `SELECT credential_id, account_id, public_key_base64, counter, transports_json FROM passkeys
     WHERE credential_id = ? AND revoked_at_ms IS NULL LIMIT 1`,
  ).bind(response.id).first<CredentialRow>();
  if (!credential) throw new Error("Passkey is not registered");
  const { origin, rpId } = passkeyConfig(env);
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: clientData.challenge,
    expectedOrigin: origin,
    expectedRPID: rpId,
    requireUserVerification: true,
    credential: {
      id: credential.credential_id,
      publicKey: base64ToBytes(credential.public_key_base64),
      counter: credential.counter,
      transports: JSON.parse(credential.transports_json) as AuthenticatorTransportFuture[],
    },
  });
  if (!verification.verified) throw new Error("Passkey authentication could not be verified");
  const now = Date.now();
  const consumptionMarker = crypto.getRandomValues(new Uint32Array(1))[0];
  const [challengeUpdate, counterUpdate] = await db.batch([
    challengeConsumption(db, challenge.challenge_hash, consumptionMarker, now),
    db.prepare(
      `UPDATE passkeys SET counter = ?, last_used_at_ms = ?
       WHERE credential_id = ? AND counter = ? AND EXISTS (
         SELECT 1 FROM passkey_challenges WHERE challenge_hash = ? AND consumed_at_ms = ?
       )`,
    ).bind(
      verification.authenticationInfo.newCounter, now, credential.credential_id, credential.counter,
      challenge.challenge_hash, consumptionMarker,
    ),
  ]);
  if ((challengeUpdate.meta.changes ?? 0) !== 1) throw new Error("Authentication challenge was already used");
  assertCounterAdvanced(credential.counter, verification.authenticationInfo.newCounter, counterUpdate.meta.changes ?? 0);
  return { accountId: credential.account_id, credentialId: credential.credential_id };
}
