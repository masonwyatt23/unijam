import type { CatalogCandidate, RecordingMetadata } from "../catalog/resolver.ts";
import type { MusicProvider } from "../provider-state-engine.ts";

export interface ProviderRequestContext {
  readonly requestId: string;
  readonly provider: MusicProvider;
  readonly credentialRef?: string;
  readonly storefront: "US";
}

export interface ProviderCatalogQuery extends RecordingMetadata {
  readonly limit: number;
}

export interface ProviderPlaylistItem {
  readonly providerRecordingId: string;
  readonly position: number;
}

export interface ProviderPlaylistSnapshot {
  readonly provider: MusicProvider;
  readonly playlistId: string;
  readonly revisionToken?: string;
  readonly items: readonly ProviderPlaylistItem[];
  readonly observedAtMs: number;
}

export interface ProviderMutationReceipt {
  readonly provider: MusicProvider;
  readonly playlistId: string;
  readonly revisionToken?: string;
  readonly acceptedCount: number;
}

export interface CreatePrivatePlaylistRequest {
  readonly name: string;
  readonly description: string;
}

export interface AppendPlaylistItemsRequest {
  readonly playlistId: string;
  readonly providerRecordingIds: readonly string[];
  readonly expectedRevisionToken?: string;
}

/** Catalog operations implemented inside the connector Worker only. */
export interface ProviderCatalogAdapter {
  readonly provider: MusicProvider;
  getRecording(
    context: ProviderRequestContext,
    providerRecordingId: string,
  ): Promise<CatalogCandidate | null>;
  lookupIsrc(
    context: ProviderRequestContext,
    isrc: string,
  ): Promise<readonly CatalogCandidate[]>;
  search(
    context: ProviderRequestContext,
    query: ProviderCatalogQuery,
  ): Promise<readonly CatalogCandidate[]>;
}

/** Playlist writes are intentionally append-oriented and destination scoped. */
export interface ProviderPublishingAdapter {
  readonly provider: MusicProvider;
  createPrivatePlaylist(
    context: ProviderRequestContext,
    request: CreatePrivatePlaylistRequest,
  ): Promise<ProviderPlaylistSnapshot>;
  readPlaylist(
    context: ProviderRequestContext,
    playlistId: string,
  ): Promise<ProviderPlaylistSnapshot>;
  appendItems(
    context: ProviderRequestContext,
    request: AppendPlaylistItemsRequest,
  ): Promise<ProviderMutationReceipt>;
}

export type ProviderFailureKind =
  | "authorization"
  | "rate_limit"
  | "retryable"
  | "ambiguous_write"
  | "invalid_response"
  | "permanent";

export interface ProviderFailure {
  readonly kind: ProviderFailureKind;
  readonly provider: MusicProvider;
  readonly retryAtMs?: number;
  readonly safeMessage: string;
}

export interface ProviderAdapter
  extends ProviderCatalogAdapter,
    ProviderPublishingAdapter {}
