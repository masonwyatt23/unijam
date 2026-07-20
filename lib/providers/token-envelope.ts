import type { MusicProvider } from "../provider-state-engine.ts";

const TOKEN_ENVELOPE_ALGORITHM = "AES-GCM";
const TOKEN_ENVELOPE_VERSION = 1;
const IV_BYTES = 12;

export interface TokenEnvelopeContext {
  readonly accountId: string;
  readonly connectionId: string;
  readonly provider: MusicProvider;
}

export interface TokenEnvelope {
  readonly envelopeVersion: 1;
  readonly algorithm: "AES-GCM";
  readonly keyVersion: string;
  readonly iv: string;
  readonly ciphertext: string;
  readonly encryptedAtMs: number;
}

export interface EncryptTokenEnvelopeInput {
  readonly plaintext: string;
  readonly key: CryptoKey;
  readonly keyVersion: string;
  readonly context: TokenEnvelopeContext;
  readonly encryptedAtMs: number;
  readonly iv?: Uint8Array;
  readonly crypto?: Crypto;
}

export interface DecryptTokenEnvelopeInput {
  readonly envelope: TokenEnvelope;
  readonly key: CryptoKey;
  readonly context: TokenEnvelopeContext;
  readonly crypto?: Crypto;
}

function requireValue(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must not be empty`);
  return normalized;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid token envelope encoding");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function additionalData(context: TokenEnvelopeContext, keyVersion: string): Uint8Array {
  const accountId = requireValue(context.accountId, "accountId");
  const connectionId = requireValue(context.connectionId, "connectionId");
  return new TextEncoder().encode(
    ["unijam-token", `v${TOKEN_ENVELOPE_VERSION}`, keyVersion, context.provider, accountId, connectionId]
      .map(encodeURIComponent)
      .join("|"),
  );
}

function cryptoRuntime(value: Crypto | undefined): Crypto {
  const runtime = value ?? globalThis.crypto;
  if (!runtime?.subtle) throw new Error("Web Crypto is unavailable");
  return runtime;
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function assertAes256GcmKey(key: CryptoKey, usage: "encrypt" | "decrypt"): void {
  const algorithm = key.algorithm as AesKeyAlgorithm;
  if (
    algorithm.name !== TOKEN_ENVELOPE_ALGORITHM ||
    algorithm.length !== 256 ||
    !key.usages.includes(usage)
  ) {
    throw new Error(`token envelope key must be a 256-bit AES-GCM ${usage} key`);
  }
}

/** Encrypts a provider token with versioned, connection-bound AAD. */
export async function encryptTokenEnvelope(
  input: EncryptTokenEnvelopeInput,
): Promise<TokenEnvelope> {
  const runtime = cryptoRuntime(input.crypto);
  assertAes256GcmKey(input.key, "encrypt");
  if (!input.plaintext.trim()) throw new Error("plaintext must not be empty");
  const plaintext = input.plaintext;
  const keyVersion = requireValue(input.keyVersion, "keyVersion");
  if (!Number.isSafeInteger(input.encryptedAtMs) || input.encryptedAtMs < 0) {
    throw new Error("encryptedAtMs must be a non-negative safe integer");
  }
  const iv = input.iv ? Uint8Array.from(input.iv) : runtime.getRandomValues(new Uint8Array(IV_BYTES));
  if (iv.byteLength !== IV_BYTES) throw new Error(`AES-GCM IV must be ${IV_BYTES} bytes`);
  const ciphertext = await runtime.subtle.encrypt(
    {
      name: TOKEN_ENVELOPE_ALGORITHM,
      iv: asArrayBuffer(iv),
      additionalData: asArrayBuffer(additionalData(input.context, keyVersion)),
      tagLength: 128,
    },
    input.key,
    new TextEncoder().encode(plaintext),
  );
  return Object.freeze({
    envelopeVersion: TOKEN_ENVELOPE_VERSION,
    algorithm: TOKEN_ENVELOPE_ALGORITHM,
    keyVersion,
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
    encryptedAtMs: input.encryptedAtMs,
  });
}

/** Decrypts only when key version and contextual AAD match the connection. */
export async function decryptTokenEnvelope(
  input: DecryptTokenEnvelopeInput,
): Promise<string> {
  const runtime = cryptoRuntime(input.crypto);
  assertAes256GcmKey(input.key, "decrypt");
  const { envelope } = input;
  if (
    envelope.envelopeVersion !== TOKEN_ENVELOPE_VERSION ||
    envelope.algorithm !== TOKEN_ENVELOPE_ALGORITHM
  ) {
    throw new Error("unsupported token envelope");
  }
  const plaintext = await runtime.subtle.decrypt(
    {
      name: TOKEN_ENVELOPE_ALGORITHM,
      iv: asArrayBuffer(base64UrlToBytes(envelope.iv)),
      additionalData: asArrayBuffer(additionalData(input.context, envelope.keyVersion)),
      tagLength: 128,
    },
    input.key,
    asArrayBuffer(base64UrlToBytes(envelope.ciphertext)),
  );
  return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
}
