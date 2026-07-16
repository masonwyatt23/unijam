import type { DestinationPublishState } from "../lib/publishing/model.ts";
import type { MusicProvider } from "../lib/provider-state-engine.ts";
import type { TokenEnvelope } from "../lib/providers/token-envelope.ts";
import type {
  ConnectorStore,
  OAuthAttempt,
  PublishJobRecord,
  StoredPublishPreview,
  StoredConnection,
} from "./types.ts";

interface OAuthRow {
  state_hash: string;
  account_id: string;
  connection_id: string;
  connection_generation: number;
  code_verifier: string;
  expires_at_ms: number;
}

interface ConnectionRow {
  account_id: string;
  connection_id: string;
  provider: MusicProvider;
  envelope_json: string;
  storefront: "US";
  generation: number;
  created_at_ms: number;
  updated_at_ms: number;
}

interface PublishRow {
  operation_id: string;
  account_id: string;
  connection_id: string;
  provider: MusicProvider;
  connection_generation: number;
  revision: number;
  destination_playlist_id: string | null;
  destination_url: string | null;
  reconciliation_attempts: number;
  reconciliation_not_before_ms: number | null;
  last_observed_ids_json: string | null;
  state_json: string;
  mutation_token: string | null;
  mutation_stage: "create_playlist" | "append_items" | null;
  mutation_acquired_at_ms: number | null;
  mutation_expires_at_ms: number | null;
  mutation_marker: string | null;
  recovery_code: "PLAYLIST_CREATION_OUTCOME_UNKNOWN" | null;
  recovery_marker: string | null;
  recovery_detected_at_ms: number | null;
  recovery_resolved_marker: string | null;
  recovery_playlist_hash: string | null;
  recovery_resolved_by: string | null;
  recovery_resolved_at_ms: number | null;
  updated_at_ms: number;
}

interface PreviewRow {
  preview_json: string;
  connection_id: string;
  expires_at_ms: number;
}

function oauth(row: OAuthRow): OAuthAttempt {
  return {
    stateHash: row.state_hash,
    accountId: row.account_id,
    connectionId: row.connection_id,
    connectionGeneration: row.connection_generation,
    codeVerifier: row.code_verifier,
    expiresAtMs: row.expires_at_ms,
  };
}

export class D1ConnectorStore implements ConnectorStore {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async saveOAuthAttempt(attempt: OAuthAttempt): Promise<void> {
    await this.db.prepare(
      `INSERT INTO connector_oauth_attempts
       (state_hash, account_id, connection_id, connection_generation, code_verifier, expires_at_ms)
       SELECT ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM connector_connection_fences
         WHERE account_id = ? AND connection_id = ? AND provider = 'spotify'
           AND generation = ? AND status = 'active'
       )`,
    ).bind(
      attempt.stateHash,
      attempt.accountId,
      attempt.connectionId,
      attempt.connectionGeneration,
      attempt.codeVerifier,
      attempt.expiresAtMs,
      attempt.accountId,
      attempt.connectionId,
      attempt.connectionGeneration,
    ).run();
  }

  async consumeOAuthAttempt(stateHash: string, nowMs: number): Promise<OAuthAttempt | null> {
    const row = await this.db.prepare(
      `DELETE FROM connector_oauth_attempts
       WHERE state_hash = ? AND expires_at_ms >= ?
       RETURNING state_hash, account_id, connection_id, connection_generation, code_verifier, expires_at_ms`,
    ).bind(stateHash, nowMs).first<OAuthRow>();
    return row ? oauth(row) : null;
  }

  async saveConnection(connection: StoredConnection): Promise<void> {
    if (connection.generation > 0) {
      await this.db.prepare(
        `INSERT INTO connector_connections
         (account_id, connection_id, provider, envelope_json, storefront, generation, created_at_ms, updated_at_ms)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM connector_connection_fences
           WHERE account_id = ? AND connection_id = ? AND provider = ?
             AND generation = ? AND status = 'active'
         )
         ON CONFLICT(account_id, connection_id, provider) DO UPDATE SET
           envelope_json = excluded.envelope_json,
           storefront = excluded.storefront,
           updated_at_ms = excluded.updated_at_ms
         WHERE connector_connections.generation = excluded.generation`,
      ).bind(
        connection.accountId, connection.connectionId, connection.provider,
        JSON.stringify(connection.envelope), connection.storefront, connection.generation,
        connection.createdAtMs, connection.updatedAtMs,
        connection.accountId, connection.connectionId, connection.provider, connection.generation,
      ).run();
      return;
    }
    await this.db.batch([
      this.db.prepare(
        `INSERT INTO connector_connection_fences
         (account_id, connection_id, provider, generation, status, updated_at_ms)
         VALUES (?, ?, ?, 1, 'active', ?)
         ON CONFLICT(account_id, connection_id, provider) DO UPDATE SET
           generation = CASE WHEN status = 'revoked' THEN generation + 1 ELSE generation END,
           status = 'active',
           updated_at_ms = excluded.updated_at_ms`,
      ).bind(connection.accountId, connection.connectionId, connection.provider, connection.updatedAtMs),
      this.db.prepare(
      `INSERT INTO connector_connections
       (account_id, connection_id, provider, envelope_json, storefront, generation, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?,
         (SELECT generation FROM connector_connection_fences
          WHERE account_id = ? AND connection_id = ? AND provider = ?), ?, ?)
       ON CONFLICT(account_id, connection_id, provider) DO UPDATE SET
         envelope_json = excluded.envelope_json,
         storefront = excluded.storefront,
         generation = excluded.generation,
         updated_at_ms = excluded.updated_at_ms`,
    ).bind(
      connection.accountId,
      connection.connectionId,
      connection.provider,
      JSON.stringify(connection.envelope),
      connection.storefront,
      connection.accountId,
      connection.connectionId,
      connection.provider,
      connection.createdAtMs,
      connection.updatedAtMs,
    ),
    ]);
  }

  async reserveConnection(accountId: string, connectionId: string, provider: MusicProvider, nowMs: number): Promise<number> {
    const row = await this.db.prepare(
      `INSERT INTO connector_connection_fences
       (account_id, connection_id, provider, generation, status, updated_at_ms)
       VALUES (?, ?, ?, 1, 'active', ?)
       ON CONFLICT(account_id, connection_id, provider) DO UPDATE SET
         generation = CASE WHEN status = 'revoked' THEN generation + 1 ELSE generation END,
         status = 'active', updated_at_ms = excluded.updated_at_ms
       RETURNING generation`,
    ).bind(accountId, connectionId, provider, nowMs).first<{ generation: number }>();
    if (!row) throw new Error("connection generation could not be reserved");
    return row.generation;
  }

  async getConnection(
    accountId: string,
    connectionId: string,
    provider: MusicProvider,
  ): Promise<StoredConnection | null> {
    const row = await this.db.prepare(
      `SELECT account_id, connection_id, provider, envelope_json, storefront,
              generation, created_at_ms, updated_at_ms
       FROM connector_connections
       WHERE account_id = ? AND connection_id = ? AND provider = ?`,
    ).bind(accountId, connectionId, provider).first<ConnectionRow>();
    if (!row) return null;
    return {
      accountId: row.account_id,
      connectionId: row.connection_id,
      provider: row.provider,
      envelope: JSON.parse(row.envelope_json) as TokenEnvelope,
      storefront: row.storefront,
      generation: row.generation,
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
    };
  }

  async getConnectionGeneration(accountId: string, connectionId: string, provider: MusicProvider): Promise<number | null> {
    const row = await this.db.prepare(
      `SELECT generation FROM connector_connection_fences
       WHERE account_id = ? AND connection_id = ? AND provider = ? AND status = 'active'`,
    ).bind(accountId, connectionId, provider).first<{ generation: number }>();
    return row?.generation ?? null;
  }

  async purgeProviderData(accountId: string, connectionId: string, provider: MusicProvider, nowMs: number): Promise<void> {
    await this.db.batch([
      this.db.prepare(
        `INSERT INTO connector_connection_fences
         (account_id, connection_id, provider, generation, status, updated_at_ms)
         VALUES (?, ?, ?, 1, 'revoked', ?)
         ON CONFLICT(account_id, connection_id, provider) DO UPDATE SET
           generation = generation + 1, status = 'revoked', updated_at_ms = excluded.updated_at_ms`,
      ).bind(accountId, connectionId, provider, nowMs),
      this.db.prepare("DELETE FROM connector_connections WHERE account_id = ? AND connection_id = ? AND provider = ?")
        .bind(accountId, connectionId, provider),
      this.db.prepare("DELETE FROM connector_publish_previews WHERE account_id = ? AND connection_id = ?")
        .bind(accountId, connectionId),
      this.db.prepare("DELETE FROM connector_publish_jobs WHERE account_id = ? AND connection_id = ? AND provider = ?")
        .bind(accountId, connectionId, provider),
      this.db.prepare("DELETE FROM connector_oauth_attempts WHERE account_id = ? AND connection_id = ?")
        .bind(accountId, connectionId),
    ]);
  }

  async purgeAccountData(accountId: string, nowMs: number): Promise<void> {
    await this.db.batch([
      this.db.prepare(
        `UPDATE connector_connection_fences
         SET generation = generation + 1, status = 'revoked', updated_at_ms = ?
         WHERE account_id = ?`,
      ).bind(nowMs, accountId),
      this.db.prepare("DELETE FROM connector_connections WHERE account_id = ?").bind(accountId),
      this.db.prepare("DELETE FROM connector_publish_previews WHERE account_id = ?").bind(accountId),
      this.db.prepare("DELETE FROM connector_publish_jobs WHERE account_id = ?").bind(accountId),
      this.db.prepare("DELETE FROM connector_oauth_attempts WHERE account_id = ?").bind(accountId),
    ]);
  }

  async purgeExpiredData(nowMs: number): Promise<void> {
    const completedCutoff = nowMs - 30 * 24 * 60 * 60_000;
    await this.db.batch([
      this.db.prepare("DELETE FROM connector_oauth_attempts WHERE expires_at_ms < ?").bind(nowMs),
      this.db.prepare("DELETE FROM connector_publish_previews WHERE expires_at_ms < ?").bind(nowMs),
      this.db.prepare(
        `DELETE FROM connector_publish_jobs
         WHERE updated_at_ms < ?
           AND json_extract(state_json, '$.phase') IN ('succeeded', 'failed', 'cancelled')`,
      ).bind(completedCutoff),
    ]);
  }

  async savePublishPreview(record: StoredPublishPreview): Promise<void> {
    await this.db.prepare(
      `INSERT INTO connector_publish_previews
       (preview_id, account_id, connection_id, preview_json, expires_at_ms)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(preview_id) DO UPDATE SET
         preview_json = excluded.preview_json,
         connection_id = excluded.connection_id,
         expires_at_ms = excluded.expires_at_ms`,
    ).bind(
      record.preview.previewId,
      record.preview.ownerAccountId,
      record.connectionId,
      JSON.stringify(record.preview),
      record.expiresAtMs,
    ).run();
  }

  async getPublishPreview(accountId: string, previewId: string, nowMs: number): Promise<StoredPublishPreview | null> {
    const row = await this.db.prepare(
      `SELECT preview_json, connection_id, expires_at_ms
       FROM connector_publish_previews
       WHERE account_id = ? AND preview_id = ? AND expires_at_ms >= ?`,
    ).bind(accountId, previewId, nowMs).first<PreviewRow>();
    return row ? {
      preview: JSON.parse(row.preview_json) as StoredPublishPreview["preview"],
      connectionId: row.connection_id,
      expiresAtMs: row.expires_at_ms,
    } : null;
  }

  async deletePublishPreview(accountId: string, previewId: string): Promise<void> {
    await this.db.prepare(
      "DELETE FROM connector_publish_previews WHERE account_id = ? AND preview_id = ?",
    ).bind(accountId, previewId).run();
  }

  async getPublishJob(operationId: string): Promise<PublishJobRecord | null> {
    const row = await this.db.prepare(
      `SELECT operation_id, account_id, connection_id, provider,
              connection_generation, revision,
              destination_playlist_id, destination_url, reconciliation_attempts,
              reconciliation_not_before_ms, last_observed_ids_json,
              state_json, mutation_token, mutation_stage, mutation_acquired_at_ms,
              mutation_expires_at_ms, mutation_marker, recovery_code,
              recovery_marker, recovery_detected_at_ms, recovery_resolved_marker,
              recovery_playlist_hash, recovery_resolved_by, recovery_resolved_at_ms,
              updated_at_ms
       FROM connector_publish_jobs WHERE operation_id = ? AND cancelled = 0`,
    ).bind(operationId).first<PublishRow>();
    if (!row) return null;
    return {
      operationId: row.operation_id,
      accountId: row.account_id,
      connectionId: row.connection_id,
      provider: row.provider,
      connectionGeneration: row.connection_generation,
      revision: row.revision,
      ...(row.destination_playlist_id ? { destinationPlaylistId: row.destination_playlist_id } : {}),
      ...(row.destination_url ? { destinationUrl: row.destination_url } : {}),
      reconciliationAttempts: row.reconciliation_attempts,
      ...(row.reconciliation_not_before_ms === null ? {} : { reconciliationNotBeforeMs: row.reconciliation_not_before_ms }),
      ...(row.last_observed_ids_json === null ? {} : { lastObservedProviderRecordingIds: JSON.parse(row.last_observed_ids_json) as string[] }),
      ...(row.mutation_token && row.mutation_stage && row.mutation_acquired_at_ms !== null && row.mutation_expires_at_ms !== null && row.mutation_marker
        ? { mutationLease: { token: row.mutation_token, stage: row.mutation_stage, acquiredAtMs: row.mutation_acquired_at_ms, expiresAtMs: row.mutation_expires_at_ms, marker: row.mutation_marker } }
        : {}),
      ...(row.recovery_code && row.recovery_marker && row.recovery_detected_at_ms !== null
        ? { recoveryRequired: { code: row.recovery_code, marker: row.recovery_marker, detectedAtMs: row.recovery_detected_at_ms } }
        : {}),
      ...(row.recovery_resolved_marker && row.recovery_playlist_hash && row.recovery_resolved_by && row.recovery_resolved_at_ms !== null
        ? { recoveryResolution: {
          marker: row.recovery_resolved_marker,
          destinationPlaylistHash: row.recovery_playlist_hash,
          resolvedBy: row.recovery_resolved_by,
          resolvedAtMs: row.recovery_resolved_at_ms,
        } }
        : {}),
      state: JSON.parse(row.state_json) as DestinationPublishState,
      updatedAtMs: row.updated_at_ms,
    };
  }

  async savePublishJob(job: PublishJobRecord): Promise<boolean> {
    const result = await this.db.prepare(
      `INSERT INTO connector_publish_jobs
       (operation_id, account_id, connection_id, provider, connection_generation, revision, destination_playlist_id, destination_url,
        reconciliation_attempts, reconciliation_not_before_ms,
        last_observed_ids_json, state_json, recovery_code, recovery_marker,
        recovery_detected_at_ms, updated_at_ms, cancelled)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0
       WHERE EXISTS (
         SELECT 1 FROM connector_connection_fences
         WHERE account_id = ? AND connection_id = ? AND provider = ?
           AND generation = ? AND status = 'active'
       )
       ON CONFLICT(operation_id) DO UPDATE SET
         destination_playlist_id = excluded.destination_playlist_id,
         destination_url = excluded.destination_url,
         reconciliation_attempts = excluded.reconciliation_attempts,
         reconciliation_not_before_ms = excluded.reconciliation_not_before_ms,
         last_observed_ids_json = excluded.last_observed_ids_json,
         state_json = excluded.state_json,
         recovery_code = excluded.recovery_code,
         recovery_marker = excluded.recovery_marker,
         recovery_detected_at_ms = excluded.recovery_detected_at_ms,
         revision = connector_publish_jobs.revision + 1,
         updated_at_ms = excluded.updated_at_ms
       WHERE connector_publish_jobs.revision = excluded.revision
         AND connector_publish_jobs.mutation_token IS NULL
         AND connector_publish_jobs.cancelled = 0`,
    ).bind(
      job.operationId,
      job.accountId,
      job.connectionId,
      job.provider,
      job.connectionGeneration,
      job.revision,
      job.destinationPlaylistId ?? null,
      job.destinationUrl ?? null,
      job.reconciliationAttempts ?? 0,
      job.reconciliationNotBeforeMs ?? null,
      job.lastObservedProviderRecordingIds ? JSON.stringify(job.lastObservedProviderRecordingIds) : null,
      JSON.stringify(job.state),
      job.recoveryRequired?.code ?? null,
      job.recoveryRequired?.marker ?? null,
      job.recoveryRequired?.detectedAtMs ?? null,
      job.updatedAtMs,
      job.accountId,
      job.connectionId,
      job.provider,
      job.connectionGeneration,
    ).run();
    return (result.meta.changes ?? 0) === 1;
  }

  async acquirePublishMutation(input: Parameters<ConnectorStore["acquirePublishMutation"]>[0]): Promise<Awaited<ReturnType<ConnectorStore["acquirePublishMutation"]>>> {
    const result = await this.db.prepare(
      `UPDATE connector_publish_jobs
       SET state_json = ?, revision = revision + 1, mutation_token = ?, mutation_stage = ?,
           mutation_acquired_at_ms = ?, mutation_expires_at_ms = ?, mutation_marker = ?, updated_at_ms = ?
       WHERE operation_id = ? AND revision = ? AND connection_generation = ?
         AND cancelled = 0 AND mutation_token IS NULL AND recovery_code IS NULL
         AND EXISTS (
           SELECT 1 FROM connector_connection_fences f
           WHERE f.account_id = connector_publish_jobs.account_id
             AND f.connection_id = connector_publish_jobs.connection_id
             AND f.provider = connector_publish_jobs.provider
             AND f.generation = connector_publish_jobs.connection_generation
             AND f.status = 'active'
         )`,
    ).bind(
      JSON.stringify(input.state), input.lease.token, input.lease.stage,
      input.lease.acquiredAtMs, input.lease.expiresAtMs, input.lease.marker,
      input.updatedAtMs, input.operationId, input.expectedRevision, input.connectionGeneration,
    ).run();
    if ((result.meta.changes ?? 0) === 1) {
      const job = await this.getPublishJob(input.operationId);
      return job ? { kind: "acquired", job } : { kind: "missing" };
    }
    const job = await this.getPublishJob(input.operationId);
    if (!job) return { kind: "missing" };
    const generation = await this.getConnectionGeneration(job.accountId, job.connectionId, job.provider);
    if (generation !== job.connectionGeneration) return { kind: "revoked" };
    if (job.mutationLease) {
      return job.mutationLease.expiresAtMs <= input.updatedAtMs
        ? { kind: "orphaned", job }
        : { kind: "busy", retryAtMs: job.mutationLease.expiresAtMs };
    }
    return { kind: "busy", retryAtMs: input.updatedAtMs + 1_000 };
  }

  async validatePublishMutation(operationId: string, leaseToken: string, connectionGeneration: number, nowMs: number): Promise<boolean> {
    const row = await this.db.prepare(
      `SELECT 1 AS valid FROM connector_publish_jobs j
       JOIN connector_connection_fences f
         ON f.account_id = j.account_id AND f.connection_id = j.connection_id AND f.provider = j.provider
       WHERE j.operation_id = ? AND j.mutation_token = ? AND j.connection_generation = ?
         AND j.cancelled = 0 AND j.mutation_expires_at_ms >= ?
         AND f.generation = j.connection_generation AND f.status = 'active'`,
    ).bind(operationId, leaseToken, connectionGeneration, nowMs).first<{ valid: number }>();
    return row?.valid === 1;
  }

  async completePublishMutation(job: PublishJobRecord, leaseToken: string): Promise<boolean> {
    const result = await this.db.prepare(
      `UPDATE connector_publish_jobs SET
         destination_playlist_id = ?, destination_url = ?, reconciliation_attempts = ?, reconciliation_not_before_ms = ?,
         last_observed_ids_json = ?, state_json = ?, recovery_code = ?, recovery_marker = ?,
         recovery_detected_at_ms = ?, mutation_token = NULL, mutation_stage = NULL,
         mutation_acquired_at_ms = NULL, mutation_expires_at_ms = NULL, mutation_marker = NULL,
         revision = revision + 1, updated_at_ms = ?
       WHERE operation_id = ? AND mutation_token = ? AND connection_generation = ? AND cancelled = 0`,
    ).bind(
      job.destinationPlaylistId ?? null, job.destinationUrl ?? null, job.reconciliationAttempts ?? 0,
      job.reconciliationNotBeforeMs ?? null,
      job.lastObservedProviderRecordingIds ? JSON.stringify(job.lastObservedProviderRecordingIds) : null,
      JSON.stringify(job.state), job.recoveryRequired?.code ?? null,
      job.recoveryRequired?.marker ?? null, job.recoveryRequired?.detectedAtMs ?? null,
      job.updatedAtMs, job.operationId, leaseToken, job.connectionGeneration,
    ).run();
    return (result.meta.changes ?? 0) === 1;
  }

  async recoverPublishPlaylist(input: Parameters<ConnectorStore["recoverPublishPlaylist"]>[0]): Promise<Awaited<ReturnType<ConnectorStore["recoverPublishPlaylist"]>>> {
    const result = await this.db.prepare(
      `UPDATE connector_publish_jobs SET
         destination_playlist_id = ?, destination_url = ?, recovery_code = NULL, recovery_marker = NULL,
         recovery_detected_at_ms = NULL, recovery_resolved_marker = ?,
         recovery_playlist_hash = ?, recovery_resolved_by = ?, recovery_resolved_at_ms = ?,
         revision = revision + 1, updated_at_ms = ?
       WHERE operation_id = ? AND destination_playlist_id IS NULL
         AND recovery_code = 'PLAYLIST_CREATION_OUTCOME_UNKNOWN' AND recovery_marker = ?
         AND mutation_token IS NULL AND cancelled = 0
         AND EXISTS (
           SELECT 1 FROM connector_connection_fences f
           WHERE f.account_id = connector_publish_jobs.account_id
             AND f.connection_id = connector_publish_jobs.connection_id
             AND f.provider = connector_publish_jobs.provider
             AND f.generation = connector_publish_jobs.connection_generation
             AND f.status = 'active'
         )`,
    ).bind(
      input.destinationPlaylistId, input.destinationUrl ?? null, input.expectedMarker, input.destinationPlaylistHash,
      input.resolvedBy, input.resolvedAtMs, input.resolvedAtMs,
      input.operationId, input.expectedMarker,
    ).run();
    if ((result.meta.changes ?? 0) === 1) {
      const job = await this.getPublishJob(input.operationId);
      return job ? { kind: "recovered", job } : { kind: "missing" };
    }

    const job = await this.getPublishJob(input.operationId);
    if (!job) return { kind: "missing" };
    const generation = await this.getConnectionGeneration(job.accountId, job.connectionId, job.provider);
    if (generation !== job.connectionGeneration) return { kind: "revoked" };
    if (
      job.destinationPlaylistId === input.destinationPlaylistId &&
      job.recoveryResolution?.marker === input.expectedMarker &&
      job.recoveryResolution.destinationPlaylistHash === input.destinationPlaylistHash
    ) {
      return { kind: "already_recovered", job };
    }
    return { kind: "conflict" };
  }
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url secret");
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0));
}

export async function importTokenEncryptionKey(value: string): Promise<CryptoKey> {
  const bytes = decodeBase64Url(value);
  if (bytes.byteLength !== 32) throw new Error("TOKEN_ENCRYPTION_KEY_B64URL must encode 32 bytes");
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return crypto.subtle.importKey("raw", buffer, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomBase64Url(byteLength = 32): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return encodeBase64Url(new Uint8Array(digest));
}
