import type { MusicProvider } from "../lib/provider-state-engine.ts";
import { decryptTokenEnvelope, encryptTokenEnvelope } from "../lib/providers/token-envelope.ts";
import { isRecord, numberValue, stringValue } from "./catalog-shape.ts";
import { importTokenEncryptionKey } from "./storage.ts";
import type { ConnectorEnv, ConnectorStore, StoredProviderTokens } from "./types.ts";

function parseTokens(value: string): StoredProviderTokens {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) throw new Error("invalid encrypted provider token payload");
  const accessToken = stringValue(parsed.accessToken);
  const refreshToken = stringValue(parsed.refreshToken);
  const expiresAtMs = numberValue(parsed.expiresAtMs);
  const scopes = Array.isArray(parsed.scopes)
    ? parsed.scopes.filter((scope): scope is string => typeof scope === "string")
    : [];
  if (!accessToken) throw new Error("encrypted provider token payload has no access token");
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
    scopes,
  };
}

export async function saveEncryptedConnection(input: {
  readonly env: ConnectorEnv;
  readonly store: ConnectorStore;
  readonly accountId: string;
  readonly connectionId: string;
  readonly provider: MusicProvider;
  readonly tokens: StoredProviderTokens;
  readonly nowMs: number;
  readonly connectionGeneration?: number;
}): Promise<boolean> {
  const key = await importTokenEncryptionKey(input.env.TOKEN_ENCRYPTION_KEY_B64URL);
  const existing = await input.store.getConnection(input.accountId, input.connectionId, input.provider);
  const envelope = await encryptTokenEnvelope({
    plaintext: JSON.stringify(input.tokens),
    key,
    keyVersion: input.env.TOKEN_KEY_VERSION,
    context: { accountId: input.accountId, connectionId: input.connectionId, provider: input.provider },
    encryptedAtMs: input.nowMs,
  });
  const expectedGeneration = existing?.generation ?? input.connectionGeneration ?? 0;
  await input.store.saveConnection({
    accountId: input.accountId,
    connectionId: input.connectionId,
    provider: input.provider,
    envelope,
    storefront: "US",
    // Stores replace this hint with their authoritative connection-fence generation.
    generation: expectedGeneration,
    createdAtMs: existing?.createdAtMs ?? input.nowMs,
    updatedAtMs: input.nowMs,
  });
  const saved = await input.store.getConnection(input.accountId, input.connectionId, input.provider);
  return Boolean(saved && (expectedGeneration === 0 || saved.generation === expectedGeneration));
}

export async function loadEncryptedConnection(input: {
  readonly env: ConnectorEnv;
  readonly store: ConnectorStore;
  readonly accountId: string;
  readonly connectionId: string;
  readonly provider: MusicProvider;
}): Promise<StoredProviderTokens | null> {
  const connection = await input.store.getConnection(input.accountId, input.connectionId, input.provider);
  if (!connection) return null;
  if (connection.envelope.keyVersion !== input.env.TOKEN_KEY_VERSION) {
    throw new Error("provider connection requires key rotation migration");
  }
  const key = await importTokenEncryptionKey(input.env.TOKEN_ENCRYPTION_KEY_B64URL);
  const plaintext = await decryptTokenEnvelope({
    envelope: connection.envelope,
    key,
    context: { accountId: input.accountId, connectionId: input.connectionId, provider: input.provider },
  });
  return parseTokens(plaintext);
}
