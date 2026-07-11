/**
 * Pure domain primitives for UniJam rooms.
 *
 * The engine deliberately performs no network, storage, clock, or random work.
 * That makes its decisions replayable in jobs, API handlers, and audit tooling.
 */

export type MusicService =
  | "spotify"
  | "apple_music"
  | "youtube_music"
  | "tidal"
  | "soundcloud"
  | "web";

export type TrackVersion =
  | "studio"
  | "live"
  | "remix"
  | "acoustic"
  | "instrumental"
  | "radio_edit"
  | "unknown";

export type Availability =
  | { readonly state: "available" }
  | { readonly state: "unknown" }
  | { readonly state: "unavailable"; readonly reason?: string }
  | {
      readonly state: "region_restricted";
      readonly availableStorefronts?: readonly string[];
    };

export interface TrackMetadata {
  readonly title: string;
  readonly artists: readonly string[];
  readonly album?: string;
  readonly durationMs?: number;
  readonly isrc?: string;
  readonly explicit?: boolean;
  readonly version?: TrackVersion;
}

export interface TrackLocator {
  readonly service: MusicService;
  readonly externalId: string;
  readonly url?: string;
  readonly storefront?: string;
}

export interface CatalogTrackReference extends TrackLocator {
  readonly metadata: TrackMetadata;
  readonly availability: Availability;
}

/** A catalog observation retained for attribution and later reconciliation. */
export interface SourceProvenance extends CatalogTrackReference {
  readonly submittedBy: string;
  readonly observedAtMs: number;
}

export interface TrackSubmission {
  readonly submissionId: string;
  readonly contributorId: string;
  readonly submittedAtMs: number;
  readonly source: SourceProvenance;
}

export interface CanonicalTrack {
  readonly canonicalId: string;
  readonly metadata: TrackMetadata;
  readonly provenance: readonly SourceProvenance[];
  readonly contributorIds: readonly string[];
  readonly firstSubmittedAtMs: number;
}

export interface DuplicateReview {
  readonly canonicalTrackId: string;
  readonly possibleDuplicateOf: string;
  readonly reasons: readonly DuplicateReason[];
}

export interface CanonicalCatalogResult {
  readonly tracks: readonly CanonicalTrack[];
  readonly duplicateReviews: readonly DuplicateReview[];
}

export type MatchMethod =
  | "catalog_id"
  | "isrc"
  | "metadata"
  | "embedding"
  | "user_override";

export interface MatchEvidence {
  readonly method: MatchMethod;
  readonly confidence: number;
  readonly availability: Availability;
  /** Difference between the selected candidate and the runner-up, if known. */
  readonly ambiguityMargin?: number;
  readonly durationDifferenceMs?: number;
  readonly variantConflict?: boolean;
  /** Destination storefront used to evaluate region-restricted candidates. */
  readonly storefront?: string;
}

export type MatchTriageStatus =
  | "publishable"
  | "needs_review"
  | "unavailable"
  | "no_match";

export type MatchTriageReason =
  | "verified_identifier"
  | "user_confirmed"
  | "high_confidence"
  | "availability_unknown"
  | "region_restricted"
  | "catalog_unavailable"
  | "ambiguous_candidates"
  | "duration_mismatch"
  | "variant_conflict"
  | "medium_confidence"
  | "low_confidence";

export interface MatchTriageResult {
  readonly status: MatchTriageStatus;
  readonly confidenceBand: "high" | "medium" | "low";
  readonly reasons: readonly MatchTriageReason[];
  readonly confidence: number;
}

export interface MatchTriageThresholds {
  readonly autoPublishConfidence: number;
  readonly reviewConfidence: number;
  readonly minimumAmbiguityMargin: number;
  readonly maximumDurationDifferenceMs: number;
}

export const DEFAULT_MATCH_THRESHOLDS: MatchTriageThresholds = Object.freeze({
  autoPublishConfidence: 0.94,
  reviewConfidence: 0.78,
  minimumAmbiguityMargin: 0.03,
  maximumDurationDifferenceMs: 5_000,
});

export interface QueueSubmission {
  readonly id: string;
  readonly contributorId: string;
  readonly submittedAtMs: number;
  readonly votes?: number;
}

export interface FairQueueOptions {
  /** Contributor whose item most recently played; the next rotation starts after them. */
  readonly afterContributorId?: string;
  readonly maximumItems?: number;
}

export interface FairQueueEntry<T extends QueueSubmission = QueueSubmission> {
  readonly item: T;
  readonly position: number;
  readonly round: number;
}

export type DuplicateReason =
  | "same_canonical_id"
  | "same_isrc"
  | "same_source_track"
  | "matching_metadata"
  | "matching_duration"
  | "explicit_variant_difference";

export interface DuplicateResult {
  readonly kind: "exact" | "probable" | "none";
  readonly matchedTrackId?: string;
  readonly reasons: readonly DuplicateReason[];
}

export interface DuplicateOptions {
  readonly durationToleranceMs?: number;
}

export interface DestinationResolution {
  readonly canonicalTrackId: string;
  readonly target: CatalogTrackReference;
  readonly triage: MatchTriageResult;
}

export interface PlaylistTrackSnapshot {
  readonly position: number;
  readonly track: CatalogTrackReference;
  readonly canonicalTrackId?: string;
}

export interface AddOnlyPublishInput {
  readonly service: MusicService;
  /** Stable external playlist/library destination identifier used to scope retries. */
  readonly destinationId: string;
  /** Monotonic room revision; a later legitimate re-add receives a new key. */
  readonly roomRevision: number;
  readonly desiredTracks: readonly CanonicalTrack[];
  readonly targetTracks: readonly PlaylistTrackSnapshot[];
  readonly resolutions: readonly DestinationResolution[];
  readonly snapshotId?: string;
}

export interface AddTrackOperation {
  readonly type: "add";
  readonly canonicalTrackId: string;
  readonly destinationId: string;
  readonly roomRevision: number;
  readonly destinationExternalId: string;
  readonly appendOrder: number;
  readonly idempotencyKey: string;
}

export type PublishSkipReason =
  | "already_present"
  | "possible_already_present"
  | "duplicate_in_room"
  | "possible_duplicate_in_room"
  | "missing_resolution"
  | "requires_review"
  | "unavailable"
  | "no_match"
  | "wrong_destination"
  | "duplicate_destination";

export interface PublishSkip {
  readonly canonicalTrackId: string;
  readonly reason: PublishSkipReason;
  readonly relatedTrackId?: string;
}

export type PublishWarningCode =
  | "target_tracks_preserved"
  | "possible_duplicate"
  | "unresolved_match"
  | "match_requires_review"
  | "unavailable_in_storefront"
  | "resolution_service_mismatch"
  | "duplicate_destination_mapping"
  | "nothing_to_add";

export interface PublishWarning {
  readonly code: PublishWarningCode;
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly canonicalTrackId?: string;
}

export interface AddOnlyPublishPlan {
  readonly mode: "add_only";
  readonly service: MusicService;
  readonly snapshotId?: string;
  readonly operations: readonly AddTrackOperation[];
  readonly skipped: readonly PublishSkip[];
  readonly warnings: readonly PublishWarning[];
  readonly summary: {
    readonly requested: number;
    readonly additions: number;
    readonly alreadyPresent: number;
    readonly needsAttention: number;
    readonly preservedTargetTracks: number;
  };
  readonly publishable: boolean;
  readonly complete: boolean;
}

export class RoomEngineValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoomEngineValidationError";
  }
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new RoomEngineValidationError(`${field} must not be empty`);
  }
  return normalized;
}

function requireFiniteNonNegative(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RoomEngineValidationError(`${field} must be a finite, non-negative number`);
  }
  return value;
}

/** Locale-independent comparator for deterministic worker/job replay. */
function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeComparisonText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function inferVersion(title: string, supplied?: TrackVersion): TrackVersion {
  if (supplied && supplied !== "unknown") return supplied;
  const normalized = normalizeComparisonText(title);
  if (/\blive\b/.test(normalized)) return "live";
  if (/\bremix(ed)?\b/.test(normalized)) return "remix";
  if (/\bacoustic\b/.test(normalized)) return "acoustic";
  if (/\binstrumental\b/.test(normalized)) return "instrumental";
  if (/\bradio edit\b/.test(normalized)) return "radio_edit";
  return supplied ?? "studio";
}

function baseTitle(title: string): string {
  return normalizeComparisonText(title)
    .replace(/\b(feat|featuring|ft)\b.*$/, "")
    .replace(/\b(live|remix(ed)?|acoustic|instrumental|radio edit)\b/g, "")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeIsrc(isrc?: string): string | undefined {
  if (!isrc) return undefined;
  const compact = isrc.replace(/[^a-z0-9]/gi, "").toUpperCase();
  return compact.length === 12 ? compact : undefined;
}

function normalizeMetadata(metadata: TrackMetadata): TrackMetadata {
  const title = requireNonEmpty(metadata.title, "metadata.title");
  const artists = [...new Set(metadata.artists.map((artist) => artist.trim()).filter(Boolean))];
  if (artists.length === 0) {
    throw new RoomEngineValidationError("metadata.artists must contain at least one artist");
  }
  if (metadata.durationMs !== undefined) {
    requireFiniteNonNegative(metadata.durationMs, "metadata.durationMs");
  }

  return {
    title,
    artists,
    ...(metadata.album?.trim() ? { album: metadata.album.trim() } : {}),
    ...(metadata.durationMs !== undefined ? { durationMs: Math.round(metadata.durationMs) } : {}),
    ...(normalizeIsrc(metadata.isrc) ? { isrc: normalizeIsrc(metadata.isrc) } : {}),
    ...(metadata.explicit !== undefined ? { explicit: metadata.explicit } : {}),
    version: inferVersion(title, metadata.version),
  };
}

function normalizeAvailability(availability: Availability): Availability {
  if (availability.state !== "region_restricted") return availability;
  const availableStorefronts = [...new Set(availability.availableStorefronts ?? [])]
    .map((storefront) => storefront.trim().toLocaleUpperCase("en-US"))
    .filter(Boolean)
    .sort();
  return {
    state: "region_restricted",
    ...(availableStorefronts.length > 0 ? { availableStorefronts } : {}),
  };
}

function normalizeSource(source: SourceProvenance): SourceProvenance {
  requireFiniteNonNegative(source.observedAtMs, "source.observedAtMs");
  return {
    service: source.service,
    externalId: requireNonEmpty(source.externalId, "source.externalId"),
    ...(source.url?.trim() ? { url: source.url.trim() } : {}),
    ...(source.storefront?.trim()
      ? { storefront: source.storefront.trim().toLocaleUpperCase("en-US") }
      : {}),
    metadata: normalizeMetadata(source.metadata),
    availability: normalizeAvailability(source.availability),
    submittedBy: requireNonEmpty(source.submittedBy, "source.submittedBy"),
    observedAtMs: source.observedAtMs,
  };
}

function metadataFingerprint(metadata: TrackMetadata): string {
  const normalized = normalizeMetadata(metadata);
  const artists = normalized.artists.map(normalizeComparisonText).join("+");
  const album = normalizeComparisonText(normalized.album ?? "");
  const duration = normalized.durationMs === undefined ? "u" : String(Math.round(normalized.durationMs / 1000));
  const version = normalized.version ?? "studio";
  const explicit = normalized.explicit === undefined ? "u" : normalized.explicit ? "e" : "c";
  return [baseTitle(normalized.title), artists, album, duration, version, explicit]
    .map((part) => encodeURIComponent(part))
    .join(":");
}

export function deriveCanonicalTrackId(metadata: TrackMetadata): string {
  const normalized = normalizeMetadata(metadata);
  return normalized.isrc ? `isrc:${normalized.isrc}` : `meta:${metadataFingerprint(normalized)}`;
}

export function canonicalizeSubmission(submission: TrackSubmission): CanonicalTrack {
  requireNonEmpty(submission.submissionId, "submission.submissionId");
  const contributorId = requireNonEmpty(submission.contributorId, "submission.contributorId");
  requireFiniteNonNegative(submission.submittedAtMs, "submission.submittedAtMs");
  const source = normalizeSource(submission.source);
  if (source.submittedBy !== contributorId) {
    throw new RoomEngineValidationError(
      "source.submittedBy must match submission.contributorId",
    );
  }

  return {
    canonicalId: deriveCanonicalTrackId(source.metadata),
    metadata: source.metadata,
    provenance: [source],
    contributorIds: [contributorId],
    firstSubmittedAtMs: submission.submittedAtMs,
  };
}

function sourceIdentity(source: TrackLocator): string {
  return `${source.service}:${source.storefront ?? "*"}:${source.externalId}`;
}

function compareSources(left: SourceProvenance, right: SourceProvenance): number {
  return (
    left.observedAtMs - right.observedAtMs ||
    compareCodeUnits(left.service, right.service) ||
    compareCodeUnits(left.externalId, right.externalId)
  );
}

function metadataQuality(metadata: TrackMetadata): number {
  return (
    (metadata.isrc ? 8 : 0) +
    (metadata.durationMs !== undefined ? 4 : 0) +
    (metadata.album ? 2 : 0) +
    (metadata.explicit !== undefined ? 1 : 0) +
    Math.min(metadata.artists.length, 3)
  );
}

function preferredMetadata(left: TrackMetadata, right: TrackMetadata): TrackMetadata {
  const qualityDifference = metadataQuality(right) - metadataQuality(left);
  if (qualityDifference !== 0) return qualityDifference > 0 ? right : left;
  const leftKey = JSON.stringify(left);
  const rightKey = JSON.stringify(right);
  return compareCodeUnits(rightKey, leftKey) < 0 ? right : left;
}

function preferredCanonicalId(left: string, right: string): string {
  if (left.startsWith("isrc:") !== right.startsWith("isrc:")) {
    return left.startsWith("isrc:") ? left : right;
  }
  return compareCodeUnits(left, right) <= 0 ? left : right;
}

function mergeCanonicalTracks(left: CanonicalTrack, right: CanonicalTrack): CanonicalTrack {
  const provenance = [...left.provenance, ...right.provenance]
    .filter(
      (source, index, all) =>
        all.findIndex((candidate) => sourceIdentity(candidate) === sourceIdentity(source)) === index,
    )
    .sort(compareSources);

  return {
    canonicalId: preferredCanonicalId(left.canonicalId, right.canonicalId),
    metadata: preferredMetadata(left.metadata, right.metadata),
    provenance,
    contributorIds: [...new Set([...left.contributorIds, ...right.contributorIds])].sort(),
    firstSubmittedAtMs: Math.min(left.firstSubmittedAtMs, right.firstSubmittedAtMs),
  };
}

/**
 * Merges only exact identities. Probable metadata matches remain separate and are
 * returned for review so live/remix/clean variants are never collapsed silently.
 */
export function buildCanonicalCatalog(
  submissions: readonly TrackSubmission[],
): CanonicalCatalogResult {
  const submissionIds = new Set<string>();
  for (const submission of submissions) {
    const submissionId = requireNonEmpty(submission.submissionId, "submissionId");
    if (submissionIds.has(submissionId)) {
      throw new RoomEngineValidationError(`duplicate submissionId: ${submissionId}`);
    }
    submissionIds.add(submissionId);
  }
  const ordered = [...submissions].sort(
    (left, right) =>
      left.submittedAtMs - right.submittedAtMs ||
      compareCodeUnits(left.submissionId, right.submissionId),
  );
  const tracks: CanonicalTrack[] = [];
  const duplicateReviews: DuplicateReview[] = [];

  for (const submission of ordered) {
    let incoming = canonicalizeSubmission(submission);
    const duplicate = detectDuplicate(incoming, tracks);
    if (duplicate.kind === "exact" && duplicate.matchedTrackId) {
      const index = tracks.findIndex((track) => track.canonicalId === duplicate.matchedTrackId);
      tracks[index] = mergeCanonicalTracks(tracks[index], incoming);
      continue;
    }
    if (duplicate.kind === "probable" && duplicate.matchedTrackId) {
      if (incoming.canonicalId === duplicate.matchedTrackId) {
        incoming = {
          ...incoming,
          canonicalId: `${incoming.canonicalId}:candidate:${encodeURIComponent(submission.submissionId)}`,
        };
      }
      duplicateReviews.push({
        canonicalTrackId: incoming.canonicalId,
        possibleDuplicateOf: duplicate.matchedTrackId,
        reasons: duplicate.reasons,
      });
    }
    tracks.push(incoming);
  }

  return { tracks, duplicateReviews };
}

function validateThresholds(thresholds: MatchTriageThresholds): void {
  const confidenceFields: ReadonlyArray<keyof MatchTriageThresholds> = [
    "autoPublishConfidence",
    "reviewConfidence",
    "minimumAmbiguityMargin",
  ];
  for (const field of confidenceFields) {
    const value = thresholds[field];
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new RoomEngineValidationError(`${field} must be between 0 and 1`);
    }
  }
  if (thresholds.reviewConfidence > thresholds.autoPublishConfidence) {
    throw new RoomEngineValidationError(
      "reviewConfidence must not exceed autoPublishConfidence",
    );
  }
  requireFiniteNonNegative(
    thresholds.maximumDurationDifferenceMs,
    "maximumDurationDifferenceMs",
  );
}

export function triageTrackMatch(
  evidence: MatchEvidence,
  thresholds: MatchTriageThresholds = DEFAULT_MATCH_THRESHOLDS,
): MatchTriageResult {
  validateThresholds(thresholds);
  if (!Number.isFinite(evidence.confidence) || evidence.confidence < 0 || evidence.confidence > 1) {
    throw new RoomEngineValidationError("evidence.confidence must be between 0 and 1");
  }
  if (evidence.ambiguityMargin !== undefined) {
    requireFiniteNonNegative(evidence.ambiguityMargin, "evidence.ambiguityMargin");
  }
  if (evidence.durationDifferenceMs !== undefined) {
    requireFiniteNonNegative(evidence.durationDifferenceMs, "evidence.durationDifferenceMs");
  }

  const confidenceBand =
    evidence.confidence >= thresholds.autoPublishConfidence
      ? "high"
      : evidence.confidence >= thresholds.reviewConfidence
        ? "medium"
        : "low";
  const result = (
    status: MatchTriageStatus,
    reasons: readonly MatchTriageReason[],
  ): MatchTriageResult => ({ status, confidenceBand, reasons, confidence: evidence.confidence });

  if (evidence.availability.state === "unavailable") {
    return result("unavailable", ["catalog_unavailable"]);
  }
  if (evidence.availability.state === "region_restricted") {
    const requestedStorefront = evidence.storefront?.trim().toUpperCase();
    const available = evidence.availability.availableStorefronts?.some(
      (storefront) => storefront.trim().toUpperCase() === requestedStorefront,
    );
    if (!requestedStorefront || !available) {
      return result("unavailable", ["region_restricted"]);
    }
  }
  if (evidence.availability.state === "unknown") {
    return result("needs_review", ["availability_unknown"]);
  }
  if (evidence.method === "user_override") {
    return result("publishable", ["user_confirmed"]);
  }
  if (evidence.variantConflict) {
    return result("needs_review", ["variant_conflict"]);
  }
  if (
    evidence.durationDifferenceMs !== undefined &&
    evidence.durationDifferenceMs > thresholds.maximumDurationDifferenceMs
  ) {
    return result("needs_review", ["duration_mismatch"]);
  }
  if (
    evidence.ambiguityMargin !== undefined &&
    evidence.ambiguityMargin < thresholds.minimumAmbiguityMargin
  ) {
    return result("needs_review", ["ambiguous_candidates"]);
  }
  if (
    (evidence.method === "isrc" || evidence.method === "catalog_id") &&
    evidence.confidence >= thresholds.reviewConfidence
  ) {
    return result("publishable", ["verified_identifier"]);
  }
  if (evidence.confidence >= thresholds.autoPublishConfidence) {
    return result("publishable", ["high_confidence"]);
  }
  if (evidence.confidence >= thresholds.reviewConfidence) {
    return result("needs_review", ["medium_confidence"]);
  }
  return result("no_match", ["low_confidence"]);
}

function queueItemComparator<T extends QueueSubmission>(left: T, right: T): number {
  return (
    (right.votes ?? 0) - (left.votes ?? 0) ||
    left.submittedAtMs - right.submittedAtMs ||
    compareCodeUnits(left.id, right.id)
  );
}

/**
 * Round-robins contributors while preserving each contributor's highest-voted
 * ordering. Consecutive items occur only when every other contributor is empty.
 */
export function buildFairQueue<T extends QueueSubmission>(
  items: readonly T[],
  options: FairQueueOptions = {},
): readonly FairQueueEntry<T>[] {
  if (options.maximumItems !== undefined) {
    requireFiniteNonNegative(options.maximumItems, "options.maximumItems");
    if (!Number.isSafeInteger(options.maximumItems)) {
      throw new RoomEngineValidationError("options.maximumItems must be a safe integer");
    }
  }

  const contributorOrder: string[] = [];
  const itemIds = new Set<string>();
  const orderedByArrival = [...items].sort(
    (left, right) => left.submittedAtMs - right.submittedAtMs || compareCodeUnits(left.id, right.id),
  );
  const groups = new Map<string, T[]>();
  for (const item of orderedByArrival) {
    const itemId = requireNonEmpty(item.id, "queue item id");
    if (itemIds.has(itemId)) {
      throw new RoomEngineValidationError(`duplicate queue item id: ${itemId}`);
    }
    itemIds.add(itemId);
    const contributorId = requireNonEmpty(item.contributorId, "queue contributorId");
    requireFiniteNonNegative(item.submittedAtMs, "queue submittedAtMs");
    if (item.votes !== undefined) {
      requireFiniteNonNegative(item.votes, "queue votes");
      if (!Number.isSafeInteger(item.votes)) {
        throw new RoomEngineValidationError("queue votes must be a safe integer");
      }
    }
    if (!groups.has(contributorId)) {
      groups.set(contributorId, []);
      contributorOrder.push(contributorId);
    }
    groups.get(contributorId)?.push(item);
  }
  for (const group of groups.values()) group.sort(queueItemComparator);

  const afterIndex = options.afterContributorId
    ? contributorOrder.indexOf(options.afterContributorId)
    : -1;
  const rotation =
    afterIndex >= 0
      ? [...contributorOrder.slice(afterIndex + 1), ...contributorOrder.slice(0, afterIndex + 1)]
      : contributorOrder;
  const limit = Math.min(
    items.length,
    options.maximumItems === undefined ? items.length : Math.floor(options.maximumItems),
  );
  const queue: FairQueueEntry<T>[] = [];
  let round = 1;

  while (queue.length < limit) {
    let addedThisRound = 0;
    for (const contributorId of rotation) {
      const item = groups.get(contributorId)?.shift();
      if (!item) continue;
      queue.push({ item, position: queue.length + 1, round });
      addedThisRound += 1;
      if (queue.length === limit) break;
    }
    if (addedThisRound === 0) break;
    round += 1;
  }

  return queue;
}

function normalizedArtists(metadata: TrackMetadata): readonly string[] {
  return metadata.artists.map(normalizeComparisonText).filter(Boolean);
}

function artistMatch(left: TrackMetadata, right: TrackMetadata): boolean {
  const leftArtists = normalizedArtists(left);
  const rightArtists = normalizedArtists(right);
  if (leftArtists[0] === rightArtists[0]) return true;
  return leftArtists.some((artist) => rightArtists.includes(artist));
}

function versionsConflict(left: TrackMetadata, right: TrackMetadata): boolean {
  const leftVersion = inferVersion(left.title, left.version);
  const rightVersion = inferVersion(right.title, right.version);
  return leftVersion !== rightVersion;
}

function detectPairDuplicate(
  incoming: CanonicalTrack,
  candidate: CanonicalTrack,
  toleranceMs: number,
): DuplicateResult {
  if (incoming.canonicalId === candidate.canonicalId && !incoming.canonicalId.startsWith("meta:")) {
    return {
      kind: "exact",
      matchedTrackId: candidate.canonicalId,
      reasons: ["same_canonical_id"],
    };
  }

  const incomingIsrc = normalizeIsrc(incoming.metadata.isrc);
  const candidateIsrc = normalizeIsrc(candidate.metadata.isrc);
  if (incomingIsrc && candidateIsrc && incomingIsrc === candidateIsrc) {
    return {
      kind: "exact",
      matchedTrackId: candidate.canonicalId,
      reasons: ["same_isrc"],
    };
  }

  const candidateSources = new Set(candidate.provenance.map(sourceIdentity));
  if (incoming.provenance.some((source) => candidateSources.has(sourceIdentity(source)))) {
    return {
      kind: "exact",
      matchedTrackId: candidate.canonicalId,
      reasons: ["same_source_track"],
    };
  }

  if (
    baseTitle(incoming.metadata.title) !== baseTitle(candidate.metadata.title) ||
    !artistMatch(incoming.metadata, candidate.metadata) ||
    versionsConflict(incoming.metadata, candidate.metadata)
  ) {
    return { kind: "none", reasons: [] };
  }

  const explicitDifference =
    incoming.metadata.explicit !== undefined &&
    candidate.metadata.explicit !== undefined &&
    incoming.metadata.explicit !== candidate.metadata.explicit;
  const incomingDuration = incoming.metadata.durationMs;
  const candidateDuration = candidate.metadata.durationMs;
  const durationMatches =
    incomingDuration !== undefined &&
    candidateDuration !== undefined &&
    Math.abs(incomingDuration - candidateDuration) <= toleranceMs;
  if (
    incomingDuration !== undefined &&
    candidateDuration !== undefined &&
    !durationMatches
  ) {
    return { kind: "none", reasons: [] };
  }

  return {
    kind: "probable",
    matchedTrackId: candidate.canonicalId,
    reasons: [
      "matching_metadata",
      ...(durationMatches ? (["matching_duration"] as const) : []),
      ...(explicitDifference ? (["explicit_variant_difference"] as const) : []),
    ],
  };
}

export function detectDuplicate(
  incoming: CanonicalTrack,
  existing: readonly CanonicalTrack[],
  options: DuplicateOptions = {},
): DuplicateResult {
  const toleranceMs = options.durationToleranceMs ?? 5_000;
  requireFiniteNonNegative(toleranceMs, "durationToleranceMs");

  let probable: DuplicateResult | undefined;
  for (const candidate of existing) {
    const result = detectPairDuplicate(incoming, candidate, toleranceMs);
    if (result.kind === "exact") return result;
    if (result.kind === "probable" && !probable) probable = result;
  }
  return probable ?? { kind: "none", reasons: [] };
}

function canonicalFromSnapshot(snapshot: PlaylistTrackSnapshot): CanonicalTrack {
  return {
    canonicalId:
      snapshot.canonicalTrackId ??
      `destination:${sourceIdentity(snapshot.track)}:${metadataFingerprint(snapshot.track.metadata)}`,
    metadata: normalizeMetadata(snapshot.track.metadata),
    provenance: [],
    contributorIds: [],
    firstSubmittedAtMs: 0,
  };
}

function warningForSkipped(skip: PublishSkip): PublishWarning | undefined {
  switch (skip.reason) {
    case "possible_already_present":
    case "possible_duplicate_in_room":
      return {
        code: "possible_duplicate",
        severity: "warning",
        message: "A probable duplicate was held for confirmation.",
        canonicalTrackId: skip.canonicalTrackId,
      };
    case "missing_resolution":
    case "no_match":
      return {
        code: "unresolved_match",
        severity: "error",
        message: "No safe destination match is available.",
        canonicalTrackId: skip.canonicalTrackId,
      };
    case "requires_review":
      return {
        code: "match_requires_review",
        severity: "warning",
        message: "The destination match needs review before publishing.",
        canonicalTrackId: skip.canonicalTrackId,
      };
    case "unavailable":
      return {
        code: "unavailable_in_storefront",
        severity: "warning",
        message: "The track is unavailable in the destination storefront.",
        canonicalTrackId: skip.canonicalTrackId,
      };
    case "wrong_destination":
      return {
        code: "resolution_service_mismatch",
        severity: "error",
        message: "The catalog resolution belongs to a different destination service.",
        canonicalTrackId: skip.canonicalTrackId,
      };
    case "duplicate_destination":
      return {
        code: "duplicate_destination_mapping",
        severity: "warning",
        message: "Two room tracks resolve to the same destination track.",
        canonicalTrackId: skip.canonicalTrackId,
      };
    default:
      return undefined;
  }
}

/**
 * Produces append operations only. Existing destination tracks are never removed
 * or reordered, and uncertain matches are held from the executable operation list.
 */
export function createAddOnlyPublishPlan(input: AddOnlyPublishInput): AddOnlyPublishPlan {
  const destinationId = requireNonEmpty(input.destinationId, "destinationId");
  requireFiniteNonNegative(input.roomRevision, "roomRevision");
  if (!Number.isSafeInteger(input.roomRevision)) {
    throw new RoomEngineValidationError("roomRevision must be a safe integer");
  }
  for (const target of input.targetTracks) {
    requireFiniteNonNegative(target.position, "target track position");
    requireNonEmpty(target.track.externalId, "target track externalId");
    if (target.track.service !== input.service) {
      throw new RoomEngineValidationError("target track belongs to a different destination service");
    }
  }
  const resolutionMap = new Map<string, DestinationResolution>();
  for (const resolution of input.resolutions) {
    requireNonEmpty(resolution.canonicalTrackId, "resolution canonicalTrackId");
    requireNonEmpty(resolution.target.externalId, "resolution target externalId");
    if (resolutionMap.has(resolution.canonicalTrackId)) {
      throw new RoomEngineValidationError(
        `multiple resolutions supplied for ${resolution.canonicalTrackId}`,
      );
    }
    resolutionMap.set(resolution.canonicalTrackId, resolution);
  }

  const operations: AddTrackOperation[] = [];
  const skipped: PublishSkip[] = [];
  const acceptedRoomTracks: CanonicalTrack[] = [];
  const targetCanonicalTracks = input.targetTracks.map(canonicalFromSnapshot);
  const targetSourceIds = new Set(input.targetTracks.map(({ track }) => sourceIdentity(track)));
  const plannedDestinationIds = new Set<string>();

  for (const desired of input.desiredTracks) {
    const roomDuplicate = detectDuplicate(desired, acceptedRoomTracks);
    if (roomDuplicate.kind !== "none") {
      skipped.push({
        canonicalTrackId: desired.canonicalId,
        reason:
          roomDuplicate.kind === "exact" ? "duplicate_in_room" : "possible_duplicate_in_room",
        relatedTrackId: roomDuplicate.matchedTrackId,
      });
      continue;
    }
    acceptedRoomTracks.push(desired);

    const targetDuplicate = detectDuplicate(desired, targetCanonicalTracks);
    if (targetDuplicate.kind !== "none") {
      skipped.push({
        canonicalTrackId: desired.canonicalId,
        reason:
          targetDuplicate.kind === "exact" ? "already_present" : "possible_already_present",
        relatedTrackId: targetDuplicate.matchedTrackId,
      });
      continue;
    }

    const resolution = resolutionMap.get(desired.canonicalId);
    if (!resolution) {
      skipped.push({ canonicalTrackId: desired.canonicalId, reason: "missing_resolution" });
      continue;
    }
    if (resolution.target.service !== input.service) {
      skipped.push({ canonicalTrackId: desired.canonicalId, reason: "wrong_destination" });
      continue;
    }
    if (resolution.target.availability.state === "unknown") {
      skipped.push({ canonicalTrackId: desired.canonicalId, reason: "requires_review" });
      continue;
    }
    if (resolution.target.availability.state !== "available") {
      skipped.push({ canonicalTrackId: desired.canonicalId, reason: "unavailable" });
      continue;
    }
    if (resolution.triage.status !== "publishable") {
      const reason: PublishSkipReason =
        resolution.triage.status === "needs_review"
          ? "requires_review"
          : resolution.triage.status === "unavailable"
            ? "unavailable"
            : "no_match";
      skipped.push({ canonicalTrackId: desired.canonicalId, reason });
      continue;
    }

    const destinationIdentity = sourceIdentity(resolution.target);
    if (targetSourceIds.has(destinationIdentity)) {
      skipped.push({ canonicalTrackId: desired.canonicalId, reason: "already_present" });
      continue;
    }
    if (plannedDestinationIds.has(destinationIdentity)) {
      skipped.push({ canonicalTrackId: desired.canonicalId, reason: "duplicate_destination" });
      continue;
    }
    plannedDestinationIds.add(destinationIdentity);
    operations.push({
      type: "add",
      canonicalTrackId: desired.canonicalId,
      destinationId,
      roomRevision: input.roomRevision,
      destinationExternalId: resolution.target.externalId,
      appendOrder: operations.length + 1,
      idempotencyKey: `add:${input.service}:${encodeURIComponent(destinationId)}:r${input.roomRevision}:${encodeURIComponent(desired.canonicalId)}:${encodeURIComponent(
        resolution.target.externalId,
      )}`,
    });
  }

  const desiredIds = new Set(input.desiredTracks.map((track) => track.canonicalId));
  const preservedTargetTracks = input.targetTracks.filter(
    (target) => !target.canonicalTrackId || !desiredIds.has(target.canonicalTrackId),
  ).length;
  const warnings = skipped
    .map(warningForSkipped)
    .filter((warning): warning is PublishWarning => Boolean(warning));
  if (preservedTargetTracks > 0) {
    warnings.unshift({
      code: "target_tracks_preserved",
      severity: "info",
      message: `${preservedTargetTracks} destination track${preservedTargetTracks === 1 ? " was" : "s were"} preserved by add-only mode.`,
    });
  }
  if (operations.length === 0) {
    warnings.push({
      code: "nothing_to_add",
      severity: "info",
      message: "No new destination tracks are safe to add.",
    });
  }

  const alreadyPresent = skipped.filter(
    (skip) => skip.reason === "already_present" || skip.reason === "possible_already_present",
  ).length;
  const needsAttention = skipped.filter(
    (skip) =>
      skip.reason !== "already_present" &&
      skip.reason !== "duplicate_in_room",
  ).length;

  return {
    mode: "add_only",
    service: input.service,
    ...(input.snapshotId ? { snapshotId: input.snapshotId } : {}),
    operations,
    skipped,
    warnings,
    summary: {
      requested: input.desiredTracks.length,
      additions: operations.length,
      alreadyPresent,
      needsAttention,
      preservedTargetTracks,
    },
    publishable: operations.length > 0,
    complete: !warnings.some((warning) => warning.severity === "error" || warning.severity === "warning"),
  };
}
