import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCanonicalCatalog,
  buildFairQueue,
  canonicalizeSubmission,
  createAddOnlyPublishPlan,
  detectDuplicate,
  triageTrackMatch,
  type Availability,
  type CanonicalTrack,
  type CatalogTrackReference,
  type MusicService,
  type TrackMetadata,
  type TrackSubmission,
} from "./room-engine.ts";

function catalogTrack(
  service: MusicService,
  externalId: string,
  metadata: TrackMetadata,
  availability: Availability = { state: "available" },
): CatalogTrackReference {
  return { service, externalId, metadata, availability };
}

function submission(
  submissionId: string,
  contributorId: string,
  service: MusicService,
  externalId: string,
  metadata: TrackMetadata,
  submittedAtMs: number,
): TrackSubmission {
  return {
    submissionId,
    contributorId,
    submittedAtMs,
    source: {
      ...catalogTrack(service, externalId, metadata),
      submittedBy: contributorId,
      observedAtMs: submittedAtMs,
    },
  };
}

function canonical(
  id: string,
  title: string,
  durationMs = 180_000,
  version: TrackMetadata["version"] = "studio",
): CanonicalTrack {
  return {
    canonicalId: id,
    metadata: { title, artists: ["Example Artist"], durationMs, version },
    provenance: [],
    contributorIds: ["guest-1"],
    firstSubmittedAtMs: 1,
  };
}

test("canonical catalog normalizes identity and retains cross-service provenance", () => {
  const metadata = {
    title: "  Pink + White ",
    artists: ["Frank Ocean"],
    durationMs: 184_516,
    isrc: "US-UM7-16-03087",
  } as const;
  const result = buildCanonicalCatalog([
    submission("s2", "mason", "apple_music", "am-2", metadata, 20),
    submission("s1", "jordan", "spotify", "sp-1", metadata, 10),
  ]);

  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].canonicalId, "isrc:USUM71603087");
  assert.deepEqual(result.tracks[0].contributorIds, ["jordan", "mason"]);
  assert.deepEqual(
    result.tracks[0].provenance.map(({ service, externalId }) => ({ service, externalId })),
    [
      { service: "spotify", externalId: "sp-1" },
      { service: "apple_music", externalId: "am-2" },
    ],
  );
});

test("metadata identity does not exactly merge distinct same-title recordings", () => {
  const result = buildCanonicalCatalog([
    submission("s1", "guest-one", "web", "one", { title: "Home", artists: ["Example Artist"], album: "First", durationMs: 180_000 }, 1),
    submission("s2", "guest-two", "web", "two", { title: "Home", artists: ["Example Artist"], album: "Second", durationMs: 240_000 }, 2),
  ]);

  assert.equal(result.tracks.length, 2);
  assert.notEqual(result.tracks[0].canonicalId, result.tracks[1].canonicalId);
});

test("unresolved identical metadata candidates retain unique aggregate IDs", () => {
  const metadata = { title: "A Song", artists: ["Example Artist"], album: "Album", durationMs: 180_000 } as const;
  const result = buildCanonicalCatalog([
    submission("spotify-observation", "guest-one", "spotify", "sp-one", metadata, 1),
    submission("apple-observation", "guest-two", "apple_music", "am-one", metadata, 2),
  ]);

  assert.equal(result.tracks.length, 2);
  assert.notEqual(result.tracks[0].canonicalId, result.tracks[1].canonicalId);
  assert.equal(result.duplicateReviews.length, 1);
  assert.notEqual(result.duplicateReviews[0].canonicalTrackId, result.duplicateReviews[0].possibleDuplicateOf);
});

test("match triage combines confidence, ambiguity, and storefront availability", () => {
  assert.equal(
    triageTrackMatch({
      method: "isrc",
      confidence: 0.98,
      availability: { state: "available" },
    }).status,
    "publishable",
  );
  assert.deepEqual(
    triageTrackMatch({
      method: "metadata",
      confidence: 0.97,
      ambiguityMargin: 0.01,
      availability: { state: "available" },
    }).reasons,
    ["ambiguous_candidates"],
  );
  assert.equal(
    triageTrackMatch({
      method: "metadata",
      confidence: 0.99,
      availability: { state: "region_restricted", availableStorefronts: ["US"] },
    }).status,
    "unavailable",
  );
  assert.equal(
    triageTrackMatch({
      method: "metadata",
      confidence: 0.99,
      storefront: "us",
      availability: { state: "region_restricted", availableStorefronts: ["US"] },
    }).status,
    "publishable",
  );
  assert.deepEqual(
    triageTrackMatch({
      method: "user_override",
      confidence: 0.7,
      variantConflict: true,
      durationDifferenceMs: 30_000,
      availability: { state: "available" },
    }).reasons,
    ["user_confirmed"],
  );
});

test("fair queue rotates contributors and ranks each person's picks by votes", () => {
  const queue = buildFairQueue(
    [
      { id: "a-old", contributorId: "a", submittedAtMs: 1, votes: 1 },
      { id: "a-hit", contributorId: "a", submittedAtMs: 4, votes: 9 },
      { id: "a-last", contributorId: "a", submittedAtMs: 5, votes: 0 },
      { id: "b-one", contributorId: "b", submittedAtMs: 2, votes: 2 },
      { id: "b-two", contributorId: "b", submittedAtMs: 6, votes: 0 },
      { id: "c-one", contributorId: "c", submittedAtMs: 3, votes: 0 },
    ],
    { afterContributorId: "a" },
  );

  assert.deepEqual(
    queue.map(({ item }) => item.id),
    ["b-one", "c-one", "a-hit", "b-two", "a-old", "a-last"],
  );
  assert.deepEqual(
    queue.map(({ round }) => round),
    [1, 1, 1, 2, 2, 3],
  );
});

test("duplicate detection is exact for shared IDs, probable for metadata, and variant-safe", () => {
  const original = canonical("room:original", "Midnight City", 244_000, "studio");
  const metadataTwin = canonical("room:twin", "Midnight City", 247_500, "studio");
  const liveVersion = canonical("room:live", "Midnight City (Live)", 245_000, "live");

  assert.equal(detectDuplicate(original, [original]).kind, "exact");
  assert.equal(detectDuplicate(metadataTwin, [original]).kind, "probable");
  assert.equal(detectDuplicate(liveVersion, [original]).kind, "none");
});

test("add-only plan appends safe matches while preserving target state and warnings", () => {
  const alreadyThere = canonical("room:one", "First Track");
  const safeToAdd = canonical("room:two", "Second Track");
  const needsReview = canonical("room:three", "Third Track");
  const duplicateRoomEntry = canonical("room:two", "Second Track");
  const availableTriage = triageTrackMatch({
    method: "isrc",
    confidence: 0.99,
    availability: { state: "available" },
  });
  const reviewTriage = triageTrackMatch({
    method: "metadata",
    confidence: 0.86,
    availability: { state: "available" },
  });
  const input = {
    service: "spotify" as const,
    destinationId: "playlist-friday-night",
    roomRevision: 17,
    snapshotId: "snapshot-17",
    desiredTracks: [alreadyThere, safeToAdd, needsReview, duplicateRoomEntry],
    targetTracks: [
      {
        position: 0,
        canonicalTrackId: alreadyThere.canonicalId,
        track: catalogTrack("spotify", "spotify-existing", alreadyThere.metadata),
      },
      {
        position: 1,
        track: catalogTrack("spotify", "host-only-track", {
          title: "Host's Existing Song",
          artists: ["Host Artist"],
          durationMs: 200_000,
        }),
      },
    ],
    resolutions: [
      {
        canonicalTrackId: safeToAdd.canonicalId,
        target: catalogTrack("spotify", "spotify-two", safeToAdd.metadata),
        triage: availableTriage,
      },
      {
        canonicalTrackId: needsReview.canonicalId,
        target: catalogTrack("spotify", "spotify-three", needsReview.metadata),
        triage: reviewTriage,
      },
    ],
  };

  const plan = createAddOnlyPublishPlan(input);
  assert.deepEqual(plan, createAddOnlyPublishPlan(input), "plan must be deterministic");
  assert.deepEqual(plan.operations, [
    {
      type: "add",
      canonicalTrackId: "room:two",
      destinationId: "playlist-friday-night",
      roomRevision: 17,
      destinationExternalId: "spotify-two",
      appendOrder: 1,
      idempotencyKey: "add:spotify:playlist-friday-night:r17:room%3Atwo:spotify-two",
    },
  ]);
  assert.ok(plan.operations.every((operation) => operation.type === "add"));
  assert.equal(plan.summary.preservedTargetTracks, 1);
  assert.equal(plan.publishable, true);
  assert.equal(plan.complete, false);
  assert.ok(plan.warnings.some(({ code }) => code === "target_tracks_preserved"));
  assert.ok(plan.warnings.some(({ code }) => code === "match_requires_review"));
  assert.deepEqual(
    plan.skipped.map(({ reason }) => reason),
    ["already_present", "requires_review", "duplicate_in_room"],
  );
});

test("canonicalization rejects provenance attributed to a different contributor", () => {
  const malformed = submission(
    "s1",
    "guest-one",
    "web",
    "track-one",
    { title: "A Song", artists: ["An Artist"] },
    1,
  );
  assert.throws(
    () =>
      canonicalizeSubmission({
        ...malformed,
        source: { ...malformed.source, submittedBy: "guest-two" },
      }),
    /must match/,
  );
});

test("canonical catalog and fair queue reject colliding or invalid identities", () => {
  const metadata = { title: "A Song", artists: ["Example Artist"], durationMs: 180_000 } as const;
  assert.throws(
    () => buildCanonicalCatalog([
      submission("same", "guest-one", "spotify", "sp-one", metadata, 1),
      submission("same", "guest-two", "apple_music", "am-one", metadata, 2),
    ]),
    /duplicate submissionId/,
  );
  assert.throws(
    () => buildFairQueue([
      { id: "same", contributorId: "one", submittedAtMs: 1, votes: 1 },
      { id: "same", contributorId: "two", submittedAtMs: 2, votes: 2 },
    ]),
    /duplicate queue item id/,
  );
  assert.throws(
    () => buildFairQueue([{ id: "bad-votes", contributorId: "one", submittedAtMs: 1, votes: -1 }]),
    /queue votes/,
  );
});

test("publish plan rejects a target snapshot from the wrong service", () => {
  assert.throws(
    () => createAddOnlyPublishPlan({
      service: "spotify",
      destinationId: "playlist",
      roomRevision: 2,
      desiredTracks: [],
      resolutions: [],
      targetTracks: [{
        position: 0,
        track: catalogTrack("apple_music", "apple-track", { title: "Wrong Service", artists: ["Artist"] }),
      }],
    }),
    /different destination service/,
  );
});
