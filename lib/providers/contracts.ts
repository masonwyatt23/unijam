import type { CatalogCandidate, RecordingArtwork, RecordingMetadata } from "../catalog/resolver.ts";
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

export interface ProviderLibraryPageRequest {
  readonly cursor?: string;
  readonly limit: number;
}

export interface ProviderLibrarySearchRequest extends ProviderLibraryPageRequest {
  readonly query: string;
}

export interface ProviderLibraryTrack {
  readonly provider: MusicProvider;
  /** A queueable catalog recording identifier, never a provider library-row ID. */
  readonly providerRecordingId: string;
  readonly libraryItemId?: string;
  readonly title: string;
  readonly artists: readonly string[];
  readonly album?: string;
  readonly durationMs?: number;
  readonly explicit?: boolean;
  readonly artwork?: RecordingArtwork;
  readonly providerUrl: string;
  readonly addedAt?: string;
}

export interface ProviderLibraryPage {
  readonly items: readonly ProviderLibraryTrack[];
  readonly nextCursor: string | null;
  readonly total?: number;
}

export interface ProviderPlaylistItem {
  readonly providerRecordingId: string;
  readonly position: number;
}

export interface ProviderPlaylistSnapshot {
  readonly provider: MusicProvider;
  readonly playlistId: string;
  readonly destinationUrl?: string;
  readonly name?: string;
  readonly recoveryMarker?: string;
  readonly rawItemCount?: number;
  readonly isPrivate?: boolean;
  readonly ownershipVerified?: boolean;
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
  libraryTracks(
    context: ProviderRequestContext,
    request: ProviderLibraryPageRequest,
  ): Promise<ProviderLibraryPage>;
  searchLibrary(
    context: ProviderRequestContext,
    request: ProviderLibrarySearchRequest,
  ): Promise<ProviderLibraryPage>;
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
