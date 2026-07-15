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
  ceremony: "registration" | "additional_registration",
  authenticatedAccountId?: string,
): string {
  if (ceremony === "registration") return crypto.randomUUID();
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

async function saveChallenge(
  db: D1Database,
  challenge: string,
  kind: "registration" | "additional_registration" | "authentication",
  accountId: string | null,
  enrollmentCodeHash: string | null = null,
  now = Date.now(),
): Promise<void> {
  await db.prepare(
    `INSERT INTO passkey_challenges (challenge_hash, challenge, kind, account_id, enrollment_code_hash, expires_at_ms, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(await hashOpaqueToken(challenge), challenge, kind, accountId, enrollmentCodeHash, now + CHALLENGE_TTL_MS, now).run();
  await db.prepare("DELETE FROM passkey_challenges WHERE expires_at_ms <= ?").bind(now).run();
}

type StoredChallenge = { challenge_hash: string; account_id: string | null; enrollment_code_hash: string | null };

async function loadChallenge(
  db: D1Database,
  challenge: string,
  kind: "registration" | "additional_registration" | "authentication",
): Promise<StoredChallenge | null> {
  const now = Date.now();
  const challengeHash = await hashOpaqueToken(challenge);
  const row = await db.prepare(
    `SELECT challenge_hash, account_id, enrollment_code_hash FROM passkey_challenges
     WHERE challenge_hash = ? AND kind = ? AND expires_at_ms > ? AND consumed_at_ms IS NULL LIMIT 1`,
  ).bind(challengeHash, kind, now).first<StoredChallenge>();
  return row ?? null;
}

function challengeConsumption(db: D1Database, challengeHash: string, consumptionMarker: number, now: number): D1PreparedStatement {
  return db.prepare(
    "UPDATE passkey_challenges SET consumed_at_ms = ? WHERE challenge_hash = ? AND consumed_at_ms IS NULL AND expires_at_ms > ?",
  ).bind(consumptionMarker, challengeHash, now);
}

export async function registrationOptions(
  db: D1Database,
  env: PasskeyRuntimeConfig,
  input: { userName: string; displayName: string; enrollmentCode: string },
) {
  // Bootstrap identity is always server-generated. Existing accounts use the
  // separately authenticated additional-credential ceremony below.
  const accountId = registrationAccountId("registration");
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
    userName: input.userName,
    userDisplayName: input.displayName,
    timeout: CHALLENGE_TTL_MS,
    attestationType: "none",
    authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
    excludeCredentials: (credentials.results ?? []).map((credential) => ({
      id: credential.credential_id,
      transports: JSON.parse(credential.transports_json) as AuthenticatorTransportFuture[],
    })),
  });
  await saveChallenge(db, options.challenge, "registration", accountId, enrollmentCodeHash);
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
  ceremony: "registration" | "additional_registration" = "registration",
  recoverySessionId?: string,
): Promise<{ accountId: string; credentialId: string }> {
  const challenge = input.response.response.clientDataJSON;
  const clientData = JSON.parse(new TextDecoder().decode(base64ToBytes(challenge))) as { challenge?: string };
  if (!clientData.challenge) throw new Error("Registration challenge is missing");
  const stored = await loadChallenge(db, clientData.challenge, ceremony);
  if (!stored || stored.account_id !== input.accountId) throw new Error("Registration challenge is invalid or expired");
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
  const consumptionMarker = now * 1_000 + crypto.getRandomValues(new Uint16Array(1))[0] % 1_000;
  const info = verification.registrationInfo;
  const credentialValues = [
    info.credential.id,
    input.accountId,
    bytesToBase64(info.credential.publicKey),
    info.credential.counter,
    JSON.stringify(info.credential.transports ?? []),
    info.credentialDeviceType,
    info.credentialBackedUp ? 1 : 0,
    now,
    now,
  ] as const;
  const passkeyInsert = recoverySessionId
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
    ).bind(...credentialValues, recoverySessionId, input.accountId, now, stored.challenge_hash, consumptionMarker)
    : db.prepare(
      `INSERT INTO passkeys
       (credential_id, account_id, public_key_base64, counter, transports_json, device_type, backed_up, created_at_ms, last_used_at_ms)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM passkey_challenges WHERE challenge_hash = ? AND consumed_at_ms = ?
       ) AND EXISTS (
         SELECT 1 FROM accounts WHERE account_id = ? AND deleted_at_ms IS NULL
       )`,
    ).bind(...credentialValues, stored.challenge_hash, consumptionMarker, input.accountId);
  const statements = [
    challengeConsumption(db, stored.challenge_hash, consumptionMarker, now),
    passkeyInsert,
  ];
  if (ceremony === "registration") {
    if (!stored.enrollment_code_hash) throw new Error("Pilot enrollment is unavailable");
    statements.splice(1, 0, db.prepare(
      `UPDATE host_enrollment_codes SET used_at_ms = ?, used_by_account_id = ?
       WHERE code_hash = ? AND used_at_ms IS NULL AND expires_at_ms > ?`,
    ).bind(now, input.accountId, stored.enrollment_code_hash, now));
    statements.splice(2, 0, db.prepare(
      `INSERT INTO accounts (account_id, display_name, created_at_ms, updated_at_ms)
       SELECT ?, ?, ?, ? WHERE EXISTS (
         SELECT 1 FROM host_enrollment_codes WHERE code_hash = ? AND used_by_account_id = ? AND used_at_ms = ?
       )`,
    ).bind(input.accountId, input.displayName, now, now, stored.enrollment_code_hash, input.accountId, now));
  } else {
    const account = await db.prepare("SELECT account_id FROM accounts WHERE account_id = ? AND deleted_at_ms IS NULL LIMIT 1")
      .bind(input.accountId).first<{ account_id: string }>();
    if (!account) throw new Error("Authenticated account no longer exists");
    if (recoverySessionId) {
      statements.push(db.prepare(
        `UPDATE host_sessions SET recovery_enrollment_consumed_at_ms = ?
         WHERE session_id = ? AND account_id = ? AND passkey_verified_at_ms IS NULL
           AND recovery_enrollment_consumed_at_ms IS NULL AND recovery_enrollment_expires_at_ms > ?`,
      ).bind(now, recoverySessionId, input.accountId, now));
    }
  }
  const results = await db.batch(statements);
  if (results.some((result) => (result.meta.changes ?? 0) !== 1)) {
    throw new Error(recoverySessionId ? "Recovery enrollment grant is invalid or already used" : "Passkey registration changed concurrently");
  }
  return { accountId: input.accountId, credentialId: info.credential.id };
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
  const consumptionMarker = now * 1_000 + crypto.getRandomValues(new Uint16Array(1))[0] % 1_000;
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
