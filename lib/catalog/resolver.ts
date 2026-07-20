import type { MusicProvider } from "../provider-state-engine.ts";
import type { TrackVersion } from "../room-engine.ts";

export interface RecordingMetadata {
  readonly title: string;
  readonly artists: readonly string[];
  readonly album?: string;
  readonly durationMs?: number;
  readonly isrc?: string;
  readonly explicit?: boolean;
  readonly version?: TrackVersion;
  readonly edition?: "standard" | "deluxe" | "expanded" | "unknown";
  readonly artwork?: RecordingArtwork;
}

export interface RecordingArtwork {
  readonly url: string;
  readonly width: number;
  readonly height: number;
}

export interface ResolutionRequest extends RecordingMetadata {
  readonly provider: MusicProvider;
  readonly providerRecordingId?: string;
  readonly storefront: "US";
}

export interface CatalogCandidate extends RecordingMetadata {
  readonly provider: MusicProvider;
  readonly providerRecordingId: string;
  readonly providerUrl?: string;
  readonly storefronts?: readonly string[];
}

export type ResolutionEvidence =
  | "provider_id"
  | "isrc"
  | "title"
  | "artist"
  | "album"
  | "duration"
  | "explicit"
  | "version"
  | "edition";

export type ResolutionHoldReason =
  | "ambiguous_candidates"
  | "duration_mismatch"
  | "explicit_conflict"
  | "version_conflict"
  | "edition_conflict"
  | "storefront_unknown"
  | "storefront_unavailable";

export interface ScoredCatalogCandidate {
  readonly candidate: CatalogCandidate;
  readonly score: number;
  readonly evidence: readonly ResolutionEvidence[];
  readonly conflicts: readonly ResolutionHoldReason[];
}

export type CatalogResolution =
  | {
      readonly status: "matched";
      readonly storefront: "US";
      readonly match: ScoredCatalogCandidate;
      readonly alternatives: readonly ScoredCatalogCandidate[];
    }
  | {
      readonly status: "hold";
      readonly storefront: "US";
      readonly reasons: readonly ResolutionHoldReason[];
      readonly candidates: readonly ScoredCatalogCandidate[];
    }
  | { readonly status: "no_match"; readonly storefront: "US" };

const MATCH_THRESHOLD = 0.82;
const MINIMUM_MARGIN = 0.08;
const MAXIMUM_DURATION_DIFFERENCE_MS = 5_000;

function normalize(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/\b(feat|featuring|ft)\.?\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenSimilarity(left: string | undefined, right: string | undefined): number {
  const a = new Set(normalize(left).split(" ").filter(Boolean));
  const b = new Set(normalize(right).split(" ").filter(Boolean));
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / new Set([...a, ...b]).size;
}

function artistSimilarity(left: readonly string[], right: readonly string[]): number {
  return tokenSimilarity(left.join(" "), right.join(" "));
}

function normalizedIsrc(value: string | undefined): string {
  return (value ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

function roundScore(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 10_000) / 10_000;
}

/** Scores neutral catalog metadata without AI/ML or provider-derived embeddings. */
export function scoreCatalogCandidate(
  request: ResolutionRequest,
  candidate: CatalogCandidate,
): ScoredCatalogCandidate {
  const evidence: ResolutionEvidence[] = [];
  const conflicts: ResolutionHoldReason[] = [];

  if (candidate.provider !== request.provider) {
    return Object.freeze({ candidate, score: 0, evidence: Object.freeze([]), conflicts: Object.freeze([]) });
  }

  const providerIdMatch = Boolean(
    request.providerRecordingId &&
      request.providerRecordingId === candidate.providerRecordingId,
  );
  const requestIsrc = normalizedIsrc(request.isrc);
  const candidateIsrc = normalizedIsrc(candidate.isrc);
  const isrcMatch = Boolean(requestIsrc && requestIsrc === candidateIsrc);
  if (providerIdMatch) evidence.push("provider_id");
  if (isrcMatch) evidence.push("isrc");

  const title = tokenSimilarity(request.title, candidate.title);
  const artist = artistSimilarity(request.artists, candidate.artists);
  const album = request.album && candidate.album
    ? tokenSimilarity(request.album, candidate.album)
    : 0;
  if (title === 1) evidence.push("title");
  if (artist === 1) evidence.push("artist");
  if (album === 1) evidence.push("album");

  let duration = 0;
  if (request.durationMs !== undefined && candidate.durationMs !== undefined) {
    const difference = Math.abs(request.durationMs - candidate.durationMs);
    if (difference <= MAXIMUM_DURATION_DIFFERENCE_MS) {
      duration = 1 - difference / (MAXIMUM_DURATION_DIFFERENCE_MS * 2);
      evidence.push("duration");
    } else {
      conflicts.push("duration_mismatch");
    }
  }

  let explicit = 0;
  if (request.explicit !== undefined && candidate.explicit !== undefined) {
    if (request.explicit === candidate.explicit) {
      explicit = 1;
      evidence.push("explicit");
    } else {
      conflicts.push("explicit_conflict");
    }
  }

  let version = 0;
  if (request.version && candidate.version) {
    if (request.version === candidate.version) {
      version = 1;
      evidence.push("version");
    } else if (request.version !== "unknown" && candidate.version !== "unknown") {
      conflicts.push("version_conflict");
    }
  }

  let edition = 0;
  if (request.edition && candidate.edition) {
    if (request.edition === candidate.edition) {
      edition = 1;
      evidence.push("edition");
    } else if (request.edition !== "unknown" && candidate.edition !== "unknown") {
      conflicts.push("edition_conflict");
    }
  }

  const weightedScore =
    title * 0.32 +
    artist * 0.28 +
    album * 0.12 +
    duration * 0.12 +
    version * 0.1 +
    explicit * 0.06 +
    edition * 0.08;
  const availableWeight =
    0.32 +
    0.28 +
    (request.album && candidate.album ? 0.12 : 0) +
    (request.durationMs !== undefined && candidate.durationMs !== undefined ? 0.12 : 0) +
    (request.version && candidate.version ? 0.1 : 0) +
    (request.explicit !== undefined && candidate.explicit !== undefined ? 0.06 : 0) +
    (request.edition && candidate.edition ? 0.08 : 0);
  const metadataScore = weightedScore / availableWeight;
  const score = providerIdMatch ? 1 : isrcMatch ? Math.max(0.98, metadataScore) : metadataScore;
  return Object.freeze({
    candidate,
    score: roundScore(score),
    evidence: Object.freeze(evidence),
    conflicts: Object.freeze(conflicts),
  });
}

function availabilityReason(
  candidate: CatalogCandidate,
): ResolutionHoldReason | undefined {
  if (!candidate.storefronts) return "storefront_unknown";
  return candidate.storefronts.map((value) => value.toUpperCase()).includes("US")
    ? undefined
    : "storefront_unavailable";
}

/** Resolves only a US-storefront match, holding any material ambiguity/conflict. */
export function resolveUsCatalogRecording(
  request: ResolutionRequest,
  candidates: readonly CatalogCandidate[],
): CatalogResolution {
  if (request.storefront !== "US") {
    throw new Error("pilot resolution supports only the US storefront");
  }
  const ranked = candidates
    .map((candidate) => scoreCatalogCandidate(request, candidate))
    .filter(({ score }) => score >= MATCH_THRESHOLD)
    .sort((left, right) =>
      right.score - left.score ||
      left.candidate.providerRecordingId.localeCompare(right.candidate.providerRecordingId),
    );
  if (ranked.length === 0) return Object.freeze({ status: "no_match", storefront: "US" });

  const winner = ranked[0];
  const reasons = new Set<ResolutionHoldReason>(winner.conflicts);
  const availability = availabilityReason(winner.candidate);
  if (availability) reasons.add(availability);
  if (ranked[1]) {
    const exactProviderId = winner.evidence.includes("provider_id");
    const runnerHasSameProviderId = ranked[1].evidence.includes("provider_id");
    if (
      (exactProviderId && runnerHasSameProviderId) ||
      (!exactProviderId && winner.score - ranked[1].score < MINIMUM_MARGIN)
    ) {
      reasons.add("ambiguous_candidates");
    }
  }
  if (reasons.size > 0) {
    return Object.freeze({
      status: "hold",
      storefront: "US",
      reasons: Object.freeze([...reasons]),
      candidates: Object.freeze(ranked),
    });
  }
  return Object.freeze({
    status: "matched",
    storefront: "US",
    match: winner,
    alternatives: Object.freeze(ranked.slice(1)),
  });
}
