import type { DestinationPublishState, PublishPreview } from "../lib/publishing/model.ts";
import type { MusicProvider } from "../lib/provider-state-engine.ts";
import type { TokenEnvelope } from "../lib/providers/token-envelope.ts";

export interface ConnectorEnv {
  readonly CONNECTOR_DB: D1Database;
  readonly CONNECTOR_SHARED_SECRET: string;
  readonly CONNECTOR_OPERATOR_SECRET: string;
  readonly TOKEN_ENCRYPTION_KEY_B64URL: string;
  readonly TOKEN_KEY_VERSION: string;
  readonly SPOTIFY_PILOT_ACCOUNT_ALLOWLIST?: string;
  readonly APPLE_MUSIC_PILOT_ACCOUNT_ALLOWLIST?: string;
  readonly PUBLIC_APP_ORIGIN: string;
  readonly SPOTIFY_CLIENT_ID: string;
  readonly APPLE_TEAM_ID: string;
  readonly APPLE_KEY_ID: string;
  readonly APPLE_PRIVATE_KEY_JWK: string;
  readonly SPOTIFY_ENABLED?: string;
  readonly APPLE_MUSIC_ENABLED?: string;
  readonly SPOTIFY_PUBLISHING_ENABLED?: string;
  readonly APPLE_MUSIC_PUBLISHING_ENABLED?: string;
  readonly PUBLISH_QUEUE?: Queue<ConnectorQueueMessage>;
}

export interface StoredProviderTokens {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAtMs?: number;
  readonly scopes: readonly string[];
}

export interface StoredConnection {
  readonly accountId: string;
  readonly connectionId: string;
  readonly provider: MusicProvider;
  readonly envelope: TokenEnvelope;
  readonly storefront: "US";
  readonly generation: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface OAuthAttempt {
  readonly stateHash: string;
  readonly accountId: string;
  readonly connectionId: string;
  readonly connectionGeneration: number;
  readonly codeVerifier: string;
  readonly expiresAtMs: number;
}

export interface PublishJobRecord {
  readonly operationId: string;
  readonly accountId: string;
  readonly connectionId: string;
  readonly provider: MusicProvider;
  readonly connectionGeneration: number;
  readonly revision: number;
  readonly destinationPlaylistId?: string;
  readonly destinationUrl?: string;
  readonly reconciliationAttempts?: number;
  readonly reconciliationNotBeforeMs?: number;
  readonly lastObservedProviderRecordingIds?: readonly string[];
  readonly mutationLease?: PublishMutationLease;
  readonly recoveryRequired?: PublishRecoveryRequired;
  readonly recoveryResolution?: PublishRecoveryResolution;
  readonly state: DestinationPublishState;
  readonly updatedAtMs: number;
}

export type PublishMutationStage = "create_playlist" | "append_items";

export interface PublishMutationLease {
  readonly token: string;
  readonly stage: PublishMutationStage;
  readonly acquiredAtMs: number;
  readonly expiresAtMs: number;
  readonly marker: string;
}

export interface PublishRecoveryRequired {
  readonly code: "PLAYLIST_CREATION_OUTCOME_UNKNOWN";
  readonly marker: string;
  readonly detectedAtMs: number;
}

export interface PublishRecoveryResolution {
  readonly marker: string;
  readonly destinationPlaylistHash: string;
  readonly resolvedBy: string;
  readonly resolvedAtMs: number;
}

export type PublishRecoveryResult =
  | { readonly kind: "recovered" | "already_recovered"; readonly job: PublishJobRecord }
  | { readonly kind: "conflict" | "missing" | "revoked" };

export type PublishLeaseResult =
  | { readonly kind: "acquired"; readonly job: PublishJobRecord }
  | { readonly kind: "busy"; readonly retryAtMs: number }
  | { readonly kind: "orphaned"; readonly job: PublishJobRecord }
  | { readonly kind: "revoked" | "missing" };

export interface StoredPublishPreview {
  readonly preview: PublishPreview;
  readonly connectionId: string;
  readonly expiresAtMs: number;
}

export interface ConnectorStore {
  saveOAuthAttempt(attempt: OAuthAttempt): Promise<void>;
  consumeOAuthAttempt(stateHash: string, nowMs: number): Promise<OAuthAttempt | null>;
  saveConnection(connection: StoredConnection): Promise<void>;
  reserveConnection(accountId: string, connectionId: string, provider: MusicProvider, nowMs: number): Promise<number>;
  getConnection(accountId: string, connectionId: string, provider: MusicProvider): Promise<StoredConnection | null>;
  getConnectionGeneration(accountId: string, connectionId: string, provider: MusicProvider): Promise<number | null>;
  purgeProviderData(accountId: string, connectionId: string, provider: MusicProvider, nowMs: number): Promise<void>;
  purgeAccountData(accountId: string, nowMs: number): Promise<void>;
  purgeExpiredData(nowMs: number): Promise<void>;
  savePublishPreview(preview: StoredPublishPreview): Promise<void>;
  getPublishPreview(accountId: string, previewId: string, nowMs: number): Promise<StoredPublishPreview | null>;
  deletePublishPreview(accountId: string, previewId: string): Promise<void>;
  getPublishJob(operationId: string): Promise<PublishJobRecord | null>;
  savePublishJob(job: PublishJobRecord): Promise<boolean>;
  acquirePublishMutation(input: {
    readonly operationId: string;
    readonly expectedRevision: number;
    readonly connectionGeneration: number;
    readonly lease: PublishMutationLease;
    readonly state: DestinationPublishState;
    readonly updatedAtMs: number;
  }): Promise<PublishLeaseResult>;
  validatePublishMutation(operationId: string, leaseToken: string, connectionGeneration: number, nowMs: number): Promise<boolean>;
  completePublishMutation(job: PublishJobRecord, leaseToken: string): Promise<boolean>;
  recoverPublishPlaylist(input: {
    readonly operationId: string;
    readonly expectedMarker: string;
    readonly destinationPlaylistId: string;
    readonly destinationUrl?: string;
    readonly destinationPlaylistHash: string;
    readonly resolvedBy: string;
    readonly resolvedAtMs: number;
  }): Promise<PublishRecoveryResult>;
}

export interface ConnectorQueueMessage {
  readonly version: 1;
  readonly type: "publish_destination" | "reconcile_destination";
  readonly operationId: string;
}

export interface QueueMessageLike<T> {
  readonly body: T;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface QueueBatchLike<T> {
  readonly messages: readonly QueueMessageLike<T>[];
}
