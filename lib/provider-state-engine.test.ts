import assert from "node:assert/strict";
import test from "node:test";

import {
  chooseDeepLinkHandoff,
  createDestinationMachine,
  createRetrySafePublishOperation,
  getProviderCapability,
  pendingPublishItems,
  summarizeRoomReadiness,
  transitionDestination,
  type DestinationEvent,
  type DestinationMachine,
  type MusicProvider,
} from "./provider-state-engine.ts";

const START = 1_000;

function event<T extends DestinationEvent>(value: T): T {
  return value;
}

function apply(
  machine: DestinationMachine,
  destinationEvent: DestinationEvent,
): DestinationMachine {
  const result = transitionDestination(machine, destinationEvent);
  assert.equal(
    result.disposition,
    "applied",
    result.rejection ?? "transition was not applied",
  );
  return result.machine;
}

function connectedMachine(
  provider: MusicProvider,
  destinationId = `${provider}-playlist`,
): DestinationMachine {
  return apply(
    createDestinationMachine(provider),
    event({
      type: "connected",
      eventId: `${provider}-connected`,
      atMs: START,
      connection: {
        connectionId: `${provider}-connection`,
        destinationId,
        connectedAtMs: START,
      },
    }),
  );
}

function operation(provider: MusicProvider, destinationId = `${provider}-playlist`) {
  return createRetrySafePublishOperation({
    provider,
    roomId: "friday-night",
    destinationId,
    roomRevision: 17,
    items: [
      { canonicalTrackId: "canon:pink-white", providerTrackId: "track-1" },
      { canonicalTrackId: "canon:nights", providerTrackId: "track-2" },
      { canonicalTrackId: "canon:ivy", providerTrackId: "track-3" },
    ],
  });
}

test("publish operation and item idempotency keys are stable across retries", () => {
  const first = operation("spotify");
  const retry = operation("spotify");

  assert.deepEqual(first, retry);
  assert.match(first.operationId, /^publish:spotify:/);
  assert.equal(new Set(first.items.map(({ idempotencyKey }) => idempotencyKey)).size, 3);
  assert.deepEqual(
    pendingPublishItems(first, [first.items[0].idempotencyKey]).map(
      ({ canonicalTrackId }) => canonicalTrackId,
    ),
    ["canon:nights", "canon:ivy"],
  );
  assert.throws(
    () => pendingPublishItems(first, ["not-from-this-operation"]),
    /unknown publish item key/,
  );
});

test("operation construction rejects ambiguous or mutable publish payloads", () => {
  assert.throws(
    () =>
      createRetrySafePublishOperation({
        provider: "apple_music",
        roomId: "room",
        destinationId: "playlist",
        roomRevision: 1,
        items: [
          { canonicalTrackId: "same", providerTrackId: "one" },
          { canonicalTrackId: "same", providerTrackId: "two" },
        ],
      }),
    /duplicate canonicalTrackId/,
  );
  assert.throws(
    () =>
      createRetrySafePublishOperation({
        provider: "spotify",
        roomId: "room",
        destinationId: "playlist",
        roomRevision: -1,
        items: [{ canonicalTrackId: "one", providerTrackId: "one" }],
      }),
    /roomRevision/,
  );
});

test("destination progresses through validation, publish, and success", () => {
  let spotify = connectedMachine("spotify");
  assert.equal(spotify.phase.status, "ready");

  spotify = apply(
    spotify,
    event({
      type: "validation_started",
      eventId: "validate-start",
      validationId: "validation-1",
      atMs: START + 1,
    }),
  );
  assert.equal(spotify.phase.status, "validating");

  spotify = apply(
    spotify,
    event({
      type: "validation_succeeded",
      eventId: "validate-done",
      validationId: "validation-1",
      atMs: START + 2,
    }),
  );
  const publish = operation("spotify");
  spotify = apply(
    spotify,
    event({
      type: "publish_started",
      eventId: "publish-start",
      operation: publish,
      atMs: START + 3,
    }),
  );
  assert.deepEqual(spotify.phase, {
    status: "publishing",
    operationId: publish.operationId,
    attempt: 1,
  });

  spotify = apply(
    spotify,
    event({
      type: "publish_succeeded",
      eventId: "publish-done",
      operationId: publish.operationId,
      receiptId: "spotify-snapshot-22",
      atMs: START + 4,
    }),
  );
  assert.deepEqual(spotify.phase, {
    status: "succeeded",
    operationId: publish.operationId,
    publishedCount: 3,
    receiptId: "spotify-snapshot-22",
  });
  assert.equal(spotify.operations[0].pendingItemKeys.length, 0);
  assert.equal(spotify.operations[0].status, "succeeded");
});

test("duplicate delivery is a no-op and conflicting event reuse is rejected", () => {
  const spotify = connectedMachine("spotify");
  const duplicate = transitionDestination(
    spotify,
    event({
      type: "connected",
      eventId: "spotify-connected",
      atMs: START,
      connection: {
        connectionId: "spotify-connection",
        destinationId: "spotify-playlist",
        connectedAtMs: START,
      },
    }),
  );
  assert.equal(duplicate.disposition, "duplicate_event");
  assert.strictEqual(duplicate.machine, spotify);

  const conflict = transitionDestination(
    spotify,
    event({
      type: "connected",
      eventId: "spotify-connected",
      atMs: START,
      connection: {
        connectionId: "different-connection",
        destinationId: "spotify-playlist",
        connectedAtMs: START,
      },
    }),
  );
  assert.deepEqual(
    { disposition: conflict.disposition, rejection: conflict.rejection },
    { disposition: "rejected", rejection: "event_id_conflict" },
  );
});

test("partial success resumes only unapplied items after a rate limit", () => {
  let apple = connectedMachine("apple_music");
  const publish = operation("apple_music");
  apple = apply(
    apple,
    event({
      type: "publish_started",
      eventId: "apple-publish-1",
      operation: publish,
      atMs: START + 1,
    }),
  );
  apple = apply(
    apple,
    event({
      type: "publish_partial",
      eventId: "apple-partial-1",
      operationId: publish.operationId,
      appliedItemKeys: [publish.items[0].idempotencyKey],
      atMs: START + 2,
    }),
  );
  assert.deepEqual(apple.phase, {
    status: "partial",
    operationId: publish.operationId,
    appliedCount: 1,
    remainingCount: 2,
    attempt: 1,
  });

  apple = apply(
    apple,
    event({
      type: "publish_started",
      eventId: "apple-publish-2",
      operation: publish,
      atMs: START + 3,
    }),
  );
  apple = apply(
    apple,
    event({
      type: "rate_limited",
      eventId: "apple-rate-limit",
      operationId: publish.operationId,
      retryAtMs: START + 100,
      atMs: START + 4,
    }),
  );
  assert.equal(apple.phase.status, "rate_limited");

  const early = transitionDestination(
    apple,
    event({
      type: "retry_requested",
      eventId: "apple-early-retry",
      atMs: START + 99,
    }),
  );
  assert.deepEqual(
    { disposition: early.disposition, rejection: early.rejection },
    { disposition: "rejected", rejection: "retry_not_due" },
  );

  apple = apply(
    apple,
    event({
      type: "retry_requested",
      eventId: "apple-retry-due",
      atMs: START + 100,
    }),
  );
  assert.equal(apple.phase.status, "partial");
  assert.deepEqual(
    apple.operations[0].pendingItemKeys,
    publish.items.slice(1).map(({ idempotencyKey }) => idempotencyKey),
  );

  apple = apply(
    apple,
    event({
      type: "publish_started",
      eventId: "apple-publish-3",
      operation: publish,
      atMs: START + 101,
    }),
  );
  assert.equal(apple.phase.status, "publishing");
  assert.equal(apple.operations[0].attempt, 3);
});

test("expired authorization preserves a resumable operation through reconnect", () => {
  let spotify = connectedMachine("spotify");
  const publish = operation("spotify");
  spotify = apply(
    spotify,
    event({
      type: "publish_started",
      eventId: "start-before-expiry",
      operation: publish,
      atMs: START + 1,
    }),
  );
  spotify = apply(
    spotify,
    event({
      type: "authorization_expired",
      eventId: "grant-expired",
      reason: "Refresh token was revoked",
      atMs: START + 2,
    }),
  );
  assert.deepEqual(spotify.phase, {
    status: "reconnect",
    reason: "Refresh token was revoked",
    resumeOperationId: publish.operationId,
  });

  spotify = apply(
    spotify,
    event({
      type: "connected",
      eventId: "spotify-reconnected",
      atMs: START + 3,
      connection: {
        connectionId: "spotify-connection-2",
        destinationId: "spotify-playlist",
        connectedAtMs: START + 3,
      },
    }),
  );
  assert.deepEqual(spotify.phase, {
    status: "partial",
    operationId: publish.operationId,
    appliedCount: 0,
    remainingCount: 3,
    attempt: 1,
  });
});

test("a completed publish is not incorrectly resumed after a later outage", () => {
  let spotify = connectedMachine("spotify");
  const publish = operation("spotify");
  spotify = apply(
    spotify,
    event({
      type: "publish_started",
      eventId: "completed-start",
      operation: publish,
      atMs: START + 1,
    }),
  );
  spotify = apply(
    spotify,
    event({
      type: "publish_succeeded",
      eventId: "completed-done",
      operationId: publish.operationId,
      atMs: START + 2,
    }),
  );
  spotify = apply(
    spotify,
    event({
      type: "provider_unavailable",
      eventId: "later-outage",
      reason: "Maintenance",
      retryAtMs: START + 20,
      atMs: START + 3,
    }),
  );
  assert.deepEqual(spotify.phase, {
    status: "unavailable",
    reason: "Maintenance",
    retryAtMs: START + 20,
  });
});

test("Spotify and Apple failures remain independent in combined readiness", () => {
  let spotify = connectedMachine("spotify");
  const apple = createDestinationMachine("apple_music");
  let summary = summarizeRoomReadiness(spotify, apple, START);
  assert.deepEqual(
    {
      state: summary.state,
      canAcceptContributions: summary.canAcceptContributions,
      canPublishNow: summary.canPublishNow,
      providers: summary.providers,
      nextAction: summary.nextAction,
    },
    {
      state: "partially_ready",
      canAcceptContributions: true,
      canPublishNow: true,
      providers: { spotify: "publish_now", apple_music: "connect" },
      nextAction: { type: "connect", provider: "apple_music" },
    },
  );

  spotify = apply(
    spotify,
    event({
      type: "provider_unavailable",
      eventId: "spotify-outage",
      reason: "Provider returned 503",
      retryAtMs: START + 50,
      atMs: START + 1,
    }),
  );
  summary = summarizeRoomReadiness(spotify, apple, START + 2);
  assert.equal(summary.state, "action_required");
  assert.equal(summary.canAcceptContributions, true);
  assert.deepEqual(summary.blockedProviders, ["spotify", "apple_music"]);

  const appleReady = connectedMachine("apple_music");
  summary = summarizeRoomReadiness(spotify, appleReady, START + 2);
  assert.equal(summary.state, "partially_ready");
  assert.equal(summary.canPublishNow, true);
  assert.deepEqual(summary.publishableProviders, ["apple_music"]);
});

test("readiness exposes automatic retry timing without blocking the room", () => {
  let spotify = connectedMachine("spotify");
  const apple = connectedMachine("apple_music");
  spotify = apply(
    spotify,
    event({
      type: "rate_limited",
      eventId: "spotify-limit",
      retryAtMs: START + 60,
      atMs: START + 1,
    }),
  );

  assert.equal(getProviderCapability(spotify, START + 59), "wait");
  assert.equal(getProviderCapability(spotify, START + 60), "resume");
  const summary = summarizeRoomReadiness(spotify, apple, START + 59);
  assert.deepEqual(summary.nextAction, {
    type: "wait",
    provider: "spotify",
    retryAtMs: START + 60,
  });
  assert.equal(summary.canAcceptContributions, true);
});

test("deep-link handoff honors listener preference and known app installation", () => {
  const choice = chooseDeepLinkHandoff({
    surface: "ios",
    preferredProvider: "apple_music",
    roomDefaultProvider: "spotify",
    appInstallation: { apple_music: "installed" },
    targets: [
      {
        provider: "spotify",
        available: true,
        appUrl: "spotify:track:spotify-id",
        webUrl: "https://open.spotify.com/track/spotify-id",
      },
      {
        provider: "apple_music",
        available: true,
        appUrl: "music://music.apple.com/us/song/apple-id",
        universalUrl: "https://music.apple.com/us/song/apple-id",
        webUrl: "https://music.apple.com/us/song/apple-id",
      },
    ],
  });

  assert.deepEqual(choice, {
    available: true,
    provider: "apple_music",
    url: "music://music.apple.com/us/song/apple-id",
    mode: "native_app",
    reason: "preferred_provider",
    alternateProviders: ["spotify"],
  });
});

test("deep-link handoff falls back across regional catalog gaps", () => {
  const choice = chooseDeepLinkHandoff({
    surface: "android",
    preferredProvider: "apple_music",
    roomDefaultProvider: "apple_music",
    targets: [
      { provider: "apple_music", available: false },
      {
        provider: "spotify",
        available: true,
        universalUrl: "https://open.spotify.com/track/fallback",
      },
    ],
  });
  assert.deepEqual(choice, {
    available: true,
    provider: "spotify",
    url: "https://open.spotify.com/track/fallback",
    mode: "universal_link",
    reason: "only_available_provider",
    alternateProviders: [],
  });

  assert.deepEqual(
    chooseDeepLinkHandoff({
      surface: "web",
      targets: [
        { provider: "spotify", available: false },
        { provider: "apple_music", available: false },
      ],
    }),
    {
      available: false,
      reason: "no_available_provider",
      alternateProviders: [],
    },
  );
});

test("handoff never selects an app-only target known to be uninstalled", () => {
  assert.deepEqual(
    chooseDeepLinkHandoff({
      surface: "ios",
      preferredProvider: "apple_music",
      appInstallation: {
        apple_music: "not_installed",
        spotify: "unknown",
      },
      targets: [
        {
          provider: "apple_music",
          available: true,
          appUrl: "music://song/app-only",
        },
        {
          provider: "spotify",
          available: true,
          webUrl: "https://open.spotify.com/track/safe-fallback",
        },
      ],
    }),
    {
      available: true,
      provider: "spotify",
      url: "https://open.spotify.com/track/safe-fallback",
      mode: "web",
      reason: "only_available_provider",
      alternateProviders: [],
    },
  );
});

test("a generic disconnect preserves and resumes unfinished work", () => {
  let spotify = connectedMachine("spotify");
  const publish = operation("spotify");
  spotify = apply(spotify, event({
    type: "publish_started",
    eventId: "generic-disconnect-start",
    operation: publish,
    atMs: START + 1,
  }));
  spotify = apply(spotify, event({
    type: "disconnected",
    eventId: "generic-disconnect",
    atMs: START + 2,
  }));
  assert.deepEqual(spotify.phase, {
    status: "disconnected",
    resumeOperationId: publish.operationId,
  });

  spotify = apply(spotify, event({
    type: "connected",
    eventId: "generic-reconnect",
    atMs: START + 3,
    connection: {
      connectionId: "spotify-reconnected",
      destinationId: "spotify-playlist",
      connectedAtMs: START + 3,
    },
  }));
  assert.equal(spotify.phase.status, "partial");
  assert.equal(spotify.operations[0].status, "partial");
});

test("reconnecting to a different destination does not resume an old operation", () => {
  let spotify = connectedMachine("spotify");
  const publish = operation("spotify");
  spotify = apply(spotify, event({
    type: "publish_started",
    eventId: "destination-switch-start",
    operation: publish,
    atMs: START + 1,
  }));
  spotify = apply(spotify, event({
    type: "disconnected",
    eventId: "destination-switch-disconnect",
    atMs: START + 2,
  }));
  spotify = apply(spotify, event({
    type: "connected",
    eventId: "destination-switch-connect",
    atMs: START + 3,
    connection: {
      connectionId: "new-connection",
      destinationId: "different-playlist",
      connectedAtMs: START + 3,
    },
  }));
  assert.deepEqual(spotify.phase, { status: "ready" });
  assert.equal(spotify.operations[0].status, "reconnect");
});

test("provider events reject malformed identities, times, and completed-operation limits", () => {
  assert.throws(
    () => transitionDestination(createDestinationMachine("spotify"), event({
      type: "connected",
      eventId: "bad-connection",
      atMs: START,
      connection: { connectionId: "", destinationId: "playlist", connectedAtMs: START },
    })),
    /connectionId/,
  );
  assert.throws(
    () => transitionDestination(createDestinationMachine("spotify"), event({
      type: "connected",
      eventId: "bad-time",
      atMs: -1,
      connection: { connectionId: "connection", destinationId: "playlist", connectedAtMs: START },
    })),
    /atMs/,
  );

  let spotify = connectedMachine("spotify");
  const publish = operation("spotify");
  spotify = apply(spotify, event({ type: "publish_started", eventId: "done-limit-start", operation: publish, atMs: START + 1 }));
  spotify = apply(spotify, event({ type: "publish_succeeded", eventId: "done-limit-success", operationId: publish.operationId, atMs: START + 2 }));
  const limited = transitionDestination(spotify, event({ type: "rate_limited", eventId: "stale-limit", operationId: publish.operationId, retryAtMs: START + 20, atMs: START + 3 }));
  assert.deepEqual({ disposition: limited.disposition, rejection: limited.rejection }, { disposition: "rejected", rejection: "invalid_transition" });
});

test("handoffs reject unsafe URLs and ambiguous duplicate provider targets", () => {
  assert.deepEqual(
    chooseDeepLinkHandoff({
      surface: "web",
      targets: [{ provider: "spotify", available: true, webUrl: "javascript:alert(1)" }],
    }),
    { available: false, reason: "no_available_provider", alternateProviders: [] },
  );
  assert.throws(
    () => chooseDeepLinkHandoff({
      surface: "web",
      targets: [
        { provider: "spotify", available: true, webUrl: "https://open.spotify.com/one" },
        { provider: "spotify", available: true, webUrl: "https://open.spotify.com/two" },
      ],
    }),
    /at most one entry per provider/,
  );
});
