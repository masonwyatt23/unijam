import assert from "node:assert/strict";
import test from "node:test";

import { createPublishPreview, confirmPublishPreview, createDestinationPublishState, publishRecoveryMarker, recordPublishAttemptOutcome, startPublishAttempt } from "../lib/publishing/model.ts";
import type { ProviderAdapter } from "../lib/providers/contracts.ts";
import type { MusicProvider } from "../lib/provider-state-engine.ts";
import { AppleMusicAdapter, createAppleDeveloperToken } from "./apple-music.ts";
import { saveEncryptedConnection } from "./connections.ts";
import { ConnectorProviderError, failureForResponse } from "./errors.ts";
import { providerFetch, providerJson } from "./http.ts";
import { exchangeSpotifyAuthorizationCode, spotifyCallbackUrl, startSpotifyAuthorization } from "./oauth.ts";
import { processPublishJob } from "./queue.ts";
import { handleConnectorRequest } from "./router.ts";
import { encodeBase64Url } from "./storage.ts";
import { SpotifyAdapter, spotifyOEmbedMetadata } from "./spotify.ts";
import type { ConnectorEnv, ConnectorStore, OAuthAttempt, PublishJobRecord, StoredConnection, StoredPublishPreview } from "./types.ts";

class MemoryStore implements ConnectorStore {
  readonly attempts = new Map<string, OAuthAttempt>();
  readonly connections = new Map<string, StoredConnection>();
  readonly jobs = new Map<string, PublishJobRecord>();
  readonly previews = new Map<string, StoredPublishPreview>();
  readonly fences = new Map<string, { generation: number; status: "active" | "revoked" }>();

  key(accountId: string, connectionId: string, provider: MusicProvider) {
    return `${accountId}:${connectionId}:${provider}`;
  }
  async saveOAuthAttempt(attempt: OAuthAttempt) {
    if (await this.getConnectionGeneration(attempt.accountId, attempt.connectionId, "spotify") === attempt.connectionGeneration) {
      this.attempts.set(attempt.stateHash, attempt);
    }
  }
  async consumeOAuthAttempt(stateHash: string, nowMs: number) {
    const attempt = this.attempts.get(stateHash);
    this.attempts.delete(stateHash);
    return attempt && attempt.expiresAtMs >= nowMs ? attempt : null;
  }
  async saveConnection(connection: StoredConnection) {
    const key = this.key(connection.accountId, connection.connectionId, connection.provider);
    const prior = this.fences.get(key);
    if (connection.generation > 0) {
      if (prior?.status === "active" && prior.generation === connection.generation) {
        this.connections.set(key, connection);
      }
      return;
    }
    const generation = prior ? prior.generation + (prior.status === "revoked" ? 1 : 0) : 1;
    this.fences.set(key, { generation, status: "active" });
    this.connections.set(key, { ...connection, generation });
  }
  async reserveConnection(accountId: string, connectionId: string, provider: MusicProvider, _nowMs: number) {
    void _nowMs;
    const key = this.key(accountId, connectionId, provider);
    const prior = this.fences.get(key);
    const generation = prior ? prior.generation + (prior.status === "revoked" ? 1 : 0) : 1;
    this.fences.set(key, { generation, status: "active" });
    return generation;
  }
  async getConnection(accountId: string, connectionId: string, provider: MusicProvider) { return this.connections.get(this.key(accountId, connectionId, provider)) ?? null; }
  async getConnectionGeneration(accountId: string, connectionId: string, provider: MusicProvider) {
    const fence = this.fences.get(this.key(accountId, connectionId, provider));
    return fence?.status === "active" ? fence.generation : null;
  }
  async purgeProviderData(accountId: string, connectionId: string, provider: MusicProvider, nowMs: number) {
    void nowMs;
    const key = this.key(accountId, connectionId, provider);
    const prior = this.fences.get(key);
    this.fences.set(key, { generation: (prior?.generation ?? 0) + 1, status: "revoked" });
    this.connections.delete(key);
    for (const [previewKey, preview] of this.previews) {
      if (preview.preview.ownerAccountId === accountId && preview.connectionId === connectionId) this.previews.delete(previewKey);
    }
    for (const [operationId, job] of this.jobs) {
      if (job.accountId === accountId && job.connectionId === connectionId && job.provider === provider) this.jobs.delete(operationId);
    }
    for (const [stateHash, attempt] of this.attempts) {
      if (attempt.accountId === accountId && attempt.connectionId === connectionId) this.attempts.delete(stateHash);
    }
  }
  async purgeAccountData(accountId: string, nowMs: number) {
    void nowMs;
    for (const connection of [...this.connections.values()]) {
      if (connection.accountId === accountId) await this.purgeProviderData(accountId, connection.connectionId, connection.provider, 0);
    }
    for (const [previewKey, preview] of this.previews) if (preview.preview.ownerAccountId === accountId) this.previews.delete(previewKey);
    for (const [operationId, job] of this.jobs) if (job.accountId === accountId) this.jobs.delete(operationId);
    for (const [stateHash, attempt] of this.attempts) if (attempt.accountId === accountId) this.attempts.delete(stateHash);
    for (const key of this.fences.keys()) if (key.startsWith(`${accountId}:`)) this.fences.delete(key);
  }
  async purgeExpiredData(nowMs: number) {
    for (const [stateHash, attempt] of this.attempts) if (attempt.expiresAtMs < nowMs) this.attempts.delete(stateHash);
    for (const [key, preview] of this.previews) if (preview.expiresAtMs < nowMs) this.previews.delete(key);
  }
  async savePublishPreview(preview: StoredPublishPreview) { this.previews.set(`${preview.preview.ownerAccountId}:${preview.preview.previewId}`, preview); }
  async getPublishPreview(accountId: string, previewId: string, nowMs: number) {
    const value = this.previews.get(`${accountId}:${previewId}`);
    return value && value.expiresAtMs >= nowMs ? value : null;
  }
  async deletePublishPreview(accountId: string, previewId: string) { this.previews.delete(`${accountId}:${previewId}`); }
  async getPublishJob(operationId: string) { return this.jobs.get(operationId) ?? null; }
  async savePublishJob(job: PublishJobRecord) {
    const current = this.jobs.get(job.operationId);
    const generation = await this.getConnectionGeneration(job.accountId, job.connectionId, job.provider);
    if (!current && generation === job.connectionGeneration) {
      this.jobs.set(job.operationId, job);
      return true;
    }
    if (current && current.revision === job.revision && !current.mutationLease) {
      this.jobs.set(job.operationId, { ...job, revision: job.revision + 1 });
      return true;
    }
    return false;
  }
  async acquirePublishMutation(input: Parameters<ConnectorStore["acquirePublishMutation"]>[0]) {
    const job = this.jobs.get(input.operationId);
    if (!job) return { kind: "missing" as const };
    const generation = await this.getConnectionGeneration(job.accountId, job.connectionId, job.provider);
    if (generation !== input.connectionGeneration) return { kind: "revoked" as const };
    if (job.mutationLease) {
      return job.mutationLease.expiresAtMs <= input.updatedAtMs
        ? { kind: "orphaned" as const, job }
        : { kind: "busy" as const, retryAtMs: job.mutationLease.expiresAtMs };
    }
    if (job.revision !== input.expectedRevision || job.recoveryRequired) {
      return { kind: "busy" as const, retryAtMs: input.updatedAtMs + 1_000 };
    }
    const acquired = { ...job, state: input.state, mutationLease: input.lease, revision: job.revision + 1, updatedAtMs: input.updatedAtMs };
    this.jobs.set(job.operationId, acquired);
    return { kind: "acquired" as const, job: acquired };
  }
  async validatePublishMutation(operationId: string, leaseToken: string, connectionGeneration: number, nowMs: number) {
    const job = this.jobs.get(operationId);
    if (!job || job.mutationLease?.token !== leaseToken || job.mutationLease.expiresAtMs < nowMs) return false;
    return await this.getConnectionGeneration(job.accountId, job.connectionId, job.provider) === connectionGeneration;
  }
  async completePublishMutation(job: PublishJobRecord, leaseToken: string) {
    const current = this.jobs.get(job.operationId);
    if (!current || current.mutationLease?.token !== leaseToken) return false;
    const { mutationLease: _lease, ...withoutLease } = job;
    void _lease;
    this.jobs.set(job.operationId, { ...withoutLease, revision: current.revision + 1 });
    return true;
  }
  async recoverPublishPlaylist(input: Parameters<ConnectorStore["recoverPublishPlaylist"]>[0]) {
    const job = this.jobs.get(input.operationId);
    if (!job) return { kind: "missing" as const };
    const generation = await this.getConnectionGeneration(job.accountId, job.connectionId, job.provider);
    if (generation !== job.connectionGeneration) return { kind: "revoked" as const };
    if (
      job.destinationPlaylistId === input.destinationPlaylistId &&
      job.recoveryResolution?.marker === input.expectedMarker &&
      job.recoveryResolution.destinationPlaylistHash === input.destinationPlaylistHash
    ) {
      return { kind: "already_recovered" as const, job };
    }
    if (
      job.destinationPlaylistId || job.recoveryRequired?.marker !== input.expectedMarker ||
      job.mutationLease
    ) {
      return { kind: "conflict" as const };
    }
    const recovered: PublishJobRecord = {
      ...job,
      destinationPlaylistId: input.destinationPlaylistId,
      ...(input.destinationUrl ? { destinationUrl: input.destinationUrl } : {}),
      recoveryRequired: undefined,
      recoveryResolution: {
        marker: input.expectedMarker,
        destinationPlaylistHash: input.destinationPlaylistHash,
        resolvedBy: input.resolvedBy,
        resolvedAtMs: input.resolvedAtMs,
      },
      revision: job.revision + 1,
      updatedAtMs: input.resolvedAtMs,
    };
    this.jobs.set(input.operationId, recovered);
    return { kind: "recovered" as const, job: recovered };
  }
}

function env(changes: Partial<ConnectorEnv> = {}): ConnectorEnv {
  return {
    CONNECTOR_DB: {} as D1Database,
    CONNECTOR_SHARED_SECRET: ["internal", "fixture", "secret"].join("-"),
    CONNECTOR_OPERATOR_SECRET: ["operator", "fixture", "secret"].join("-"),
    TOKEN_ENCRYPTION_KEY_B64URL: encodeBase64Url(new Uint8Array(32).fill(7)),
    TOKEN_KEY_VERSION: ["fixture", "key", "v1"].join("-"),
    SPOTIFY_PILOT_ACCOUNT_ALLOWLIST: "allowed-account",
    APPLE_MUSIC_PILOT_ACCOUNT_ALLOWLIST: "allowed-account",
    PUBLIC_APP_ORIGIN: "https://unijam.ashlr.ai",
    SPOTIFY_CLIENT_ID: "spotify-client-fixture",
    APPLE_TEAM_ID: "TEAMFIXTURE",
    APPLE_KEY_ID: "KEYFIXTURE",
    APPLE_PRIVATE_KEY_JWK: "{}",
    SPOTIFY_ENABLED: "true",
    APPLE_MUSIC_ENABLED: "true",
    SPOTIFY_PUBLISHING_ENABLED: "true",
    APPLE_MUSIC_PUBLISHING_ENABLED: "true",
    ...changes,
  };
}

test("Spotify PKCE uses one-time state, S256, exact callback, and no client secret", async () => {
  const store = new MemoryStore();
  const values = ["s".repeat(43), "v".repeat(86)];
  const started = await startSpotifyAuthorization({
    store,
    clientId: "client-id",
    appOrigin: "https://unijam.ashlr.ai",
    accountId: "allowed-account",
    connectionId: "connection-1",
    nowMs: 1_000,
    random: () => values.shift()!,
  });
  const authorize = new URL(started.authorizeUrl);
  assert.equal(authorize.origin, "https://accounts.spotify.com");
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.deepEqual(new Set(authorize.searchParams.get("scope")?.split(" ")), new Set([
    "playlist-modify-private", "playlist-read-private", "user-read-private", "user-library-read",
  ]));
  assert.equal(authorize.searchParams.get("redirect_uri"), spotifyCallbackUrl("https://unijam.ashlr.ai"));
  assert.equal(store.attempts.size, 1);
  assert.equal([...store.attempts.values()][0].codeVerifier, "v".repeat(86));

  let tokenRequest: Request | undefined;
  const tokens = await exchangeSpotifyAuthorizationCode({
    clientId: "client-id",
    appOrigin: "https://unijam.ashlr.ai",
    code: "authorization-code",
    codeVerifier: "v".repeat(86),
    nowMs: 2_000,
    fetcher: async (input, init) => {
      tokenRequest = new Request(input, init);
      return Response.json({
        access_token: "access-fixture",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "refresh-fixture",
        scope: "playlist-modify-private playlist-read-private user-read-private user-library-read",
      });
    },
  });
  assert.equal(tokens.accessToken, "access-fixture");
  assert.equal(tokenRequest?.headers.get("Authorization"), null);
  const tokenBody = new URLSearchParams(await tokenRequest?.text());
  assert.equal(tokenBody.get("client_id"), "client-id");
  assert.equal(tokenBody.get("code_verifier"), "v".repeat(86));
  assert.equal(tokenBody.get("redirect_uri"), "https://unijam.ashlr.ai/api/v1/providers/spotify/callback");
});

test("Spotify adapter uses current private-playlist and playlist-item contracts", async () => {
  const requests: Request[] = [];
  const responses = [
    Response.json({ id: "playlist-fixture", snapshot_id: "snapshot-1", external_urls: { spotify: "https://open.spotify.com/playlist/playlist-fixture" } }),
    Response.json({ snapshot_id: "snapshot-2", name: "Fixture", description: "Synthetic", public: false, owner: { id: "owner-1" }, items: { total: 1 }, external_urls: { spotify: "https://open.spotify.com/playlist/playlist-fixture" } }),
    Response.json({ id: "owner-1" }),
    Response.json({ items: [{ item: { id: "4uLU6hMCjMI75M1A2tKUQC", type: "track" } }], next: null }),
    Response.json({ tracks: { items: [] } }),
  ];
  const adapter = new SpotifyAdapter({
    accessToken: "access-fixture",
    now: () => 5_000,
    fetcher: async (input, init) => {
      requests.push(new Request(input, init));
      return responses.shift()!;
    },
  });
  const context = { requestId: "request", provider: "spotify" as const, storefront: "US" as const };
  const created = await adapter.createPrivatePlaylist(context, { name: "Fixture", description: "Synthetic" });
  assert.equal(requests[0].url, "https://api.spotify.com/v1/me/playlists");
  assert.deepEqual(await requests[0].json(), { name: "Fixture", description: "Synthetic", public: false });
  assert.equal(created.playlistId, "playlist-fixture");
  assert.equal(created.destinationUrl, "https://open.spotify.com/playlist/playlist-fixture");
  const read = await adapter.readPlaylist(context, "playlist-fixture");
  assert.match(requests[1].url, /items\.total/);
  assert.doesNotMatch(requests[1].url, /tracks\.total/);
  assert.match(requests[3].url, /limit=50/);
  assert.deepEqual(read.items, [{ providerRecordingId: "4uLU6hMCjMI75M1A2tKUQC", position: 0 }]);
  assert.equal(read.rawItemCount, 1);
  assert.equal(read.ownershipVerified, true);
  await adapter.search(context, { title: "Fixture", artists: ["Artist"], limit: 50 });
  assert.equal(new URL(requests[4].url).searchParams.get("limit"), "10");
});

test("Spotify library pages and saved-track search return validated artwork and official links", async () => {
  const firstId = "4uLU6hMCjMI75M1A2tKUQC";
  const secondId = "6habFhsOp2NvshLv26DqMb";
  const track = (id: string, imageUrl: string) => ({
    id,
    name: `Track ${id.slice(0, 2)}`,
    artists: [{ name: "Fixture Artist" }],
    album: { name: "Fixture Album", images: [{ url: imageUrl, width: 300, height: 300 }] },
    duration_ms: 180_000,
    explicit: false,
    available_markets: ["US"],
  });
  const requests: Request[] = [];
  const responses = [
    Response.json({
      items: [{ added_at: "2026-01-02T03:04:05Z", track: track(firstId, "https://i.scdn.co/image/fixtureArtwork01") }],
      next: "https://api.spotify.com/v1/me/tracks?offset=20&limit=20",
      total: 21,
    }),
    Response.json({ tracks: { items: [
      track(firstId, "https://i.scdn.co/image/fixtureArtwork01"),
      track(secondId, "https://evil.test/image/fixtureArtwork02"),
    ] } }),
    Response.json([true, false]),
  ];
  const adapter = new SpotifyAdapter({
    accessToken: "access",
    fetcher: async (input, init) => {
      requests.push(new Request(input, init));
      return responses.shift()!;
    },
  });
  const context = { requestId: "r", provider: "spotify" as const, storefront: "US" as const };
  const page = await adapter.libraryTracks(context, { limit: 50 });
  assert.equal(new URL(requests[0].url).searchParams.get("limit"), "20");
  assert.equal(page.nextCursor, "20");
  assert.equal(page.total, 21);
  assert.deepEqual(page.items[0], {
    provider: "spotify",
    providerRecordingId: firstId,
    title: "Track 4u",
    artists: ["Fixture Artist"],
    album: "Fixture Album",
    durationMs: 180_000,
    explicit: false,
    artwork: { url: "https://i.scdn.co/image/fixtureArtwork01", width: 300, height: 300 },
    providerUrl: `https://open.spotify.com/track/${firstId}`,
    addedAt: "2026-01-02T03:04:05Z",
  });
  const searched = await adapter.searchLibrary(context, { query: "Fixture", limit: 20 });
  assert.equal(new URL(requests[1].url).searchParams.get("limit"), "10");
  assert.equal(new URL(requests[2].url).pathname, "/v1/me/library/contains");
  assert.deepEqual(searched.items.map((item) => item.providerRecordingId), [firstId]);
  await assert.rejects(adapter.libraryTracks(context, { limit: 20, cursor: "https://evil.test" }), /invalid Spotify library cursor/);
});

test("Spotify oEmbed source metadata is title-only and rejects spoofed embeds", async () => {
  const id = "4uLU6hMCjMI75M1A2tKUQC";
  const metadata = await spotifyOEmbedMetadata(id, { fetcher: async () => Response.json({
    provider_name: "Spotify",
    provider_url: "https://spotify.com",
    type: "rich",
    title: "Never Gonna Give You Up",
    iframe_url: `https://open.spotify.com/embed/track/${id}?utm_source=oembed`,
  }) });
  assert.deepEqual(metadata, {
    provider: "spotify",
    providerRecordingId: id,
    title: "Never Gonna Give You Up",
    metadataComplete: false,
  });
  await assert.rejects(
    spotifyOEmbedMetadata(id, { fetcher: async () => Response.json({
      provider_name: "Spotify",
      provider_url: "https://spotify.com",
      type: "rich",
      title: "Spoofed",
      iframe_url: `https://evil.test/embed/track/${id}`,
    }) }),
    /invalid response/i,
  );
});

test("provider failures map auth, Retry-After, 5xx writes, and malformed bodies safely", async () => {
  assert.equal(failureForResponse("spotify", new Response(null, { status: 401 }), 1_000, false).failure.kind, "authorization");
  const rateLimit = failureForResponse("spotify", new Response(null, { status: 429, headers: { "Retry-After": "12" } }), 1_000, false);
  assert.equal(rateLimit.failure.retryAtMs, 13_000);
  assert.equal(failureForResponse("apple_music", new Response(null, { status: 503 }), 1_000, true).failure.kind, "ambiguous_write");

  const adapter = new SpotifyAdapter({ accessToken: "access", fetcher: async () => new Response("not-json", { status: 200 }) });
  await assert.rejects(
    adapter.getRecording({ requestId: "r", provider: "spotify", storefront: "US" }, "4uLU6hMCjMI75M1A2tKUQC"),
    (error: unknown) => error instanceof ConnectorProviderError && error.failure.kind === "invalid_response",
  );

  const malformedMutation = new SpotifyAdapter({ accessToken: "access", fetcher: async () => Response.json({}) });
  await assert.rejects(
    malformedMutation.appendItems(
      { requestId: "r", provider: "spotify", storefront: "US" },
      { playlistId: "playlist", providerRecordingIds: ["4uLU6hMCjMI75M1A2tKUQC"] },
    ),
    (error: unknown) => error instanceof ConnectorProviderError && error.failure.kind === "ambiguous_write",
  );
});

test("provider JSON is bounded by declared and streamed bytes", async () => {
  const validate = (value: unknown): value is { ok: boolean } =>
    Boolean(value && typeof value === "object" && "ok" in value && (value as { ok?: unknown }).ok === true);
  const declared = providerJson("https://provider.test/data", {}, {
    provider: "spotify",
    fetcher: async () => new Response("{}", { headers: { "Content-Length": "1048577" } }),
  }, validate);
  await assert.rejects(declared, (error: unknown) =>
    error instanceof ConnectorProviderError && error.failure.kind === "invalid_response");

  let cancelled = false;
  const oversizedStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(600_000).fill(32));
      controller.enqueue(new Uint8Array(600_000).fill(32));
    },
    cancel() { cancelled = true; },
  });
  const chunked = providerJson("https://provider.test/data", {}, {
    provider: "apple_music",
    mutation: true,
    fetcher: async () => new Response(oversizedStream),
  }, validate);
  await assert.rejects(chunked, (error: unknown) =>
    error instanceof ConnectorProviderError && error.failure.kind === "ambiguous_write");
  assert.equal(cancelled, true);

  const encoded = new TextEncoder().encode('{"ok":true}');
  const validStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded.slice(0, 5));
      controller.enqueue(encoded.slice(5));
      controller.close();
    },
  });
  assert.deepEqual(await providerJson("https://provider.test/data", {}, {
    provider: "spotify",
    fetcher: async () => new Response(validStream),
  }, validate), { ok: true });
});

test("provider fetches reject redirects without forwarding credentials", async () => {
  let redirectMode: RequestRedirect | undefined;
  const redirected = providerFetch("https://provider.test/start", {
    headers: { Authorization: "Bearer fixture" },
    redirect: "follow",
  }, {
    provider: "spotify",
    fetcher: async (_input, init) => {
      redirectMode = init?.redirect;
      return new Response(null, { status: 302, headers: { Location: "https://evil.test/collect" } });
    },
  });
  await assert.rejects(redirected, (error: unknown) =>
    error instanceof ConnectorProviderError && error.failure.kind === "permanent");
  assert.equal(redirectMode, "error");
});

test("provider playlist links are accepted only from official HTTPS origins", async () => {
  const spotify = new SpotifyAdapter({
    accessToken: "access",
    fetcher: async () => Response.json({
      id: "playlist-safe",
      external_urls: { spotify: "https://spotify.example/playlist/playlist-safe" },
    }),
  });
  const spotifyCreated = await spotify.createPrivatePlaylist(
    { requestId: "r", provider: "spotify", storefront: "US" },
    { name: "Fixture", description: "Synthetic" },
  );
  assert.equal(spotifyCreated.destinationUrl, undefined);

  const apple = new AppleMusicAdapter({
    developerToken: "developer-token",
    musicUserToken: "music-user-token",
    fetcher: async () => Response.json({
      data: [{ id: "library-playlist", attributes: { url: "https://music.apple.example/us/playlist/fake" } }],
    }),
  });
  const appleCreated = await apple.createPrivatePlaylist(
    { requestId: "r", provider: "apple_music", storefront: "US" },
    { name: "Fixture", description: "Synthetic" },
  );
  assert.equal(appleCreated.destinationUrl, undefined);
});

test("Apple developer token is short lived and Music User Token is validated against US", async () => {
  const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", key.privateKey);
  const token = await createAppleDeveloperToken({ teamId: "TEAM", keyId: "KEY", privateKeyJwk: jwk, nowMs: 100_000 });
  const [header, claims, signature] = token.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { alg: "ES256", kid: "KEY", typ: "JWT" });
  assert.deepEqual(JSON.parse(Buffer.from(claims, "base64url").toString()), { iss: "TEAM", iat: 100, exp: 1000 });
  assert.ok(signature.length > 40);

  let request: Request | undefined;
  const adapter = new AppleMusicAdapter({
    developerToken: token,
    musicUserToken: "music-user-fixture",
    fetcher: async (input, init) => {
      request = new Request(input, init);
      return Response.json({ data: [{ id: "us", type: "storefronts" }] });
    },
  });
  assert.equal(await adapter.validateMusicUserToken(), "US");
  assert.equal(request?.headers.get("Music-User-Token"), "music-user-fixture");
  assert.match(request?.headers.get("Authorization") ?? "", /^Bearer /);

  let createRequest: Request | undefined;
  const createAdapter = new AppleMusicAdapter({
    developerToken: token,
    musicUserToken: "music-user-fixture",
    fetcher: async (input, init) => {
      createRequest = new Request(input, init);
      return Response.json({ data: [{ id: "library-playlist", type: "library-playlists", attributes: { url: "https://music.apple.com/us/playlist/fixture/pl.u-fixture" } }] });
    },
  });
  const createdPlaylist = await createAdapter.createPrivatePlaylist(
    { requestId: "r", provider: "apple_music", storefront: "US" },
    { name: "Fixture", description: "Synthetic" },
  );
  assert.deepEqual(await createRequest?.json(), {
    attributes: { name: "Fixture", description: "Synthetic" },
  });
  assert.equal(createdPlaylist.destinationUrl, "https://music.apple.com/us/playlist/fixture/pl.u-fixture");

  const developerResponse = await handleConnectorRequest(
    new Request("https://connector/v1/apple-music/developer-token", {
      method: "POST",
      headers: { Authorization: "Bearer internal-fixture-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: "allowed-account", origin: "https://unijam.ashlr.ai" }),
    }),
    env({ APPLE_PRIVATE_KEY_JWK: JSON.stringify(jwk) }),
    { store: new MemoryStore(), now: () => 100_000 },
  );
  assert.equal(developerResponse.status, 200);
  const developerBody = await developerResponse.json() as { data: { developerToken: string; expiresAtMs: number } };
  assert.equal(developerBody.data.expiresAtMs, 1_000_000);
  assert.equal(developerBody.data.developerToken.split(".").length, 3);
  const browserClaims = JSON.parse(Buffer.from(developerBody.data.developerToken.split(".")[1], "base64url").toString());
  assert.deepEqual(browserClaims.origin, ["https://unijam.ashlr.ai"]);
  assert.equal(JSON.stringify(developerBody).includes(jwk.d!), false);
});

test("Apple playlist reconciliation maps library song IDs to catalog IDs and fails closed when unmappable", async () => {
  const responses = [
    Response.json({ data: [{ id: "p.library", attributes: { name: "Fixture", description: { standard: "Synthetic" }, isPublic: false, canEdit: true } }] }),
    Response.json({ data: [{ id: "i.library-song", type: "library-songs", attributes: { playParams: { catalogId: "203709340" } } }], next: null }),
  ];
  const adapter = new AppleMusicAdapter({
    developerToken: "developer",
    musicUserToken: "user",
    fetcher: async () => responses.shift()!,
  });
  const snapshot = await adapter.readPlaylist({ requestId: "r", provider: "apple_music", storefront: "US" }, "p.library");
  assert.deepEqual(snapshot.items, [{ providerRecordingId: "203709340", position: 0 }]);
  assert.equal(snapshot.rawItemCount, 1);
  assert.equal(snapshot.ownershipVerified, true);

  const malformed = new AppleMusicAdapter({
    developerToken: "developer",
    musicUserToken: "user",
    fetcher: async (input) => String(input).includes("/tracks")
      ? Response.json({ data: [{ id: "i.no-catalog-id", type: "library-songs", attributes: {} }], next: null })
      : Response.json({ data: [{ id: "p.library", attributes: { canEdit: true } }] }),
  });
  await assert.rejects(
    malformed.readPlaylist({ requestId: "r", provider: "apple_music", storefront: "US" }, "p.library"),
    (error: unknown) => error instanceof ConnectorProviderError && error.failure.kind === "invalid_response",
  );
});

test("Apple Music library pages and search use catalog IDs and validated artwork", async () => {
  const librarySong = (libraryId: string, catalogId: string | undefined, artworkUrl: string) => ({
    id: libraryId,
    type: "library-songs",
    attributes: {
      name: "Fixture Song",
      artistName: "Fixture Artist",
      albumName: "Fixture Album",
      durationInMillis: 181_000,
      contentRating: "explicit",
      artwork: { url: artworkUrl, width: 1200, height: 1200 },
      playParams: catalogId ? { catalogId } : {},
    },
  });
  const requests: Request[] = [];
  const responses = [
    Response.json({
      data: [
        librarySong("i.fixture", "203709340", "https://is5-ssl.mzstatic.com/image/thumb/Music1/fixture/{w}x{h}bb.jpg"),
        librarySong("i.unmapped", undefined, "https://is5-ssl.mzstatic.com/image/thumb/Music1/unmapped/{w}x{h}bb.jpg"),
      ],
      next: "/v1/me/library/songs?offset=next_20&limit=20",
      meta: { total: 22 },
    }),
    Response.json({ results: { "library-songs": {
      data: [librarySong("i.search", "1440833098", "https://evil.test/image/{w}x{h}bb.jpg")],
      next: null,
    } } }),
  ];
  const adapter = new AppleMusicAdapter({
    developerToken: "developer",
    musicUserToken: "user",
    fetcher: async (input, init) => {
      requests.push(new Request(input, init));
      return responses.shift()!;
    },
  });
  const context = { requestId: "r", provider: "apple_music" as const, storefront: "US" as const };
  const page = await adapter.libraryTracks(context, { limit: 20 });
  assert.equal(requests[0].headers.get("Music-User-Token"), "user");
  assert.equal(page.items.length, 1, "library-only songs without a catalog ID are not queueable");
  assert.equal(page.items[0].providerRecordingId, "203709340");
  assert.equal(page.items[0].libraryItemId, "i.fixture");
  assert.deepEqual(page.items[0].artwork, {
    url: "https://is5-ssl.mzstatic.com/image/thumb/Music1/fixture/300x300bb.jpg",
    width: 300,
    height: 300,
  });
  assert.equal(page.items[0].providerUrl, "https://music.apple.com/us/song/203709340");
  assert.equal(page.nextCursor, "next_20");
  assert.equal(page.total, 22);
  const searched = await adapter.searchLibrary(context, { query: "Fixture", limit: 20 });
  assert.equal(new URL(requests[1].url).pathname, "/v1/me/library/search");
  assert.equal(searched.items[0].artwork, undefined, "untrusted artwork origins are omitted");
  await assert.rejects(adapter.searchLibrary(context, { query: "Fixture", limit: 20, cursor: "bad/cursor" }), /invalid Apple Music library cursor/);
});

test("connector library routes require an allowlisted encrypted connection and return no-store pages", async () => {
  const store = new MemoryStore();
  const base = env();
  await saveEncryptedConnection({
    env: base,
    store,
    accountId: "allowed-account",
    connectionId: "spotify:allowed-account",
    provider: "spotify",
    tokens: { accessToken: "saved-access", refreshToken: "saved-refresh", expiresAtMs: 999_999, scopes: ["user-library-read"] },
    nowMs: 1_000,
  });
  const headers = { Authorization: "Bearer internal-fixture-secret", "Content-Type": "application/json" };
  const response = await handleConnectorRequest(new Request("https://connector/v1/library/tracks", {
    method: "POST",
    headers,
    body: JSON.stringify({ accountId: "allowed-account", connectionId: "spotify:allowed-account", provider: "spotify", limit: 20 }),
  }), base, {
    store,
    now: () => 2_000,
    fetcher: async () => Response.json({ items: [], next: null, total: 0 }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual((await response.json() as { data: unknown }).data, { items: [], nextCursor: null, total: 0 });

  const denied = await handleConnectorRequest(new Request("https://connector/v1/library/search", {
    method: "POST",
    headers,
    body: JSON.stringify({ accountId: "not-allowed", connectionId: "spotify:not-allowed", provider: "spotify", query: "Fixture" }),
  }), base, { store });
  assert.equal(denied.status, 403);
});

test("router enforces internal auth, pilot allowlist, exact origin, encrypted storage, and disconnect", async () => {
  const store = new MemoryStore();
  const base = env();
  const unauthorized = await handleConnectorRequest(
    new Request("https://connector/v1/oauth/spotify/authorize", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }),
    base,
    { store },
  );
  assert.equal(unauthorized.status, 401);

  const headers = { Authorization: "Bearer internal-fixture-secret", "Content-Type": "application/json" };
  const denied = await handleConnectorRequest(
    new Request("https://connector/v1/oauth/spotify/authorize", { method: "POST", headers, body: JSON.stringify({ accountId: "not-allowed", connectionId: "c", origin: "https://unijam.ashlr.ai" }) }),
    base,
    { store },
  );
  assert.equal(denied.status, 403);

  const wrongOrigin = await handleConnectorRequest(
    new Request("https://connector/v1/oauth/spotify/authorize", { method: "POST", headers, body: JSON.stringify({ accountId: "allowed-account", connectionId: "c", origin: "https://evil.test" }) }),
    base,
    { store },
  );
  assert.equal(wrongOrigin.status, 400);

  const started = await handleConnectorRequest(
    new Request("https://connector/v1/oauth/spotify/authorize", { method: "POST", headers, body: JSON.stringify({ accountId: "allowed-account", connectionId: "c", origin: "https://unijam.ashlr.ai" }) }),
    base,
    { store, now: () => 1_000 },
  );
  const startedBody = await started.json() as { data: { authorizeUrl: string } };
  const state = new URL(startedBody.data.authorizeUrl).searchParams.get("state")!;
  const callback = await handleConnectorRequest(
    new Request("https://connector/v1/oauth/spotify/callback", { method: "POST", headers, body: JSON.stringify({ accountId: "allowed-account", code: "code", state, callbackUrl: spotifyCallbackUrl(base.PUBLIC_APP_ORIGIN) }) }),
    base,
    {
      store,
      now: () => 2_000,
      fetcher: async () => Response.json({ access_token: "secret-access", refresh_token: "secret-refresh", token_type: "Bearer", expires_in: 3600, scope: "playlist-modify-private playlist-read-private user-read-private user-library-read" }),
    },
  );
  assert.equal(callback.status, 201);
  const connection = await store.getConnection("allowed-account", "c", "spotify");
  assert.ok(connection);
  assert.doesNotMatch(JSON.stringify(connection), /secret-access|secret-refresh/);

  const secondStarted = await handleConnectorRequest(
    new Request("https://connector/v1/oauth/spotify/authorize", { method: "POST", headers, body: JSON.stringify({ accountId: "allowed-account", connectionId: "c-account-bound", origin: "https://unijam.ashlr.ai" }) }),
    base,
    { store, now: () => 2_100 },
  );
  const secondState = new URL((await secondStarted.json() as { data: { authorizeUrl: string } }).data.authorizeUrl).searchParams.get("state")!;
  const mismatchedCallback = await handleConnectorRequest(
    new Request("https://connector/v1/oauth/spotify/callback", { method: "POST", headers, body: JSON.stringify({ accountId: "different-account", code: "code", state: secondState, callbackUrl: spotifyCallbackUrl(base.PUBLIC_APP_ORIGIN) }) }),
    base,
    { store, now: () => 2_200 },
  );
  assert.equal(mismatchedCallback.status, 403);
  assert.equal(await store.getConnection("allowed-account", "c-account-bound", "spotify"), null);

  const queued: unknown[] = [];
  const publishEnv = env({
    PUBLISH_QUEUE: { send: async (message: unknown) => { queued.push(message); } } as unknown as Queue,
  });
  const status = await handleConnectorRequest(
    new Request("https://connector/v1/connections/status", { method: "POST", headers, body: JSON.stringify({ accountId: "allowed-account", connectionId: "c", provider: "spotify" }) }),
    publishEnv,
    { store },
  );
  assert.equal((await status.json() as { data: { connected: boolean } }).data.connected, true);

  const previewResponse = await handleConnectorRequest(
    new Request("https://connector/v1/publish/preview", {
      method: "POST",
      headers,
      body: JSON.stringify({
        accountId: "allowed-account",
        connectionId: "c",
        roomId: "room-1",
        roomRevision: 4,
        provider: "spotify",
        playlistName: "UniJam Fixture",
        items: [{ canonicalRecordingId: "canonical-1", providerRecordingId: "4uLU6hMCjMI75M1A2tKUQC" }],
      }),
    }),
    publishEnv,
    { store, now: () => 3_000 },
  );
  assert.equal(previewResponse.status, 201);
  const previewBody = await previewResponse.json() as { data: { previewId: string; payloadFingerprint: string } };
  const confirm = await handleConnectorRequest(
    new Request("https://connector/v1/publish/confirm", {
      method: "POST",
      headers,
      body: JSON.stringify({
        accountId: "allowed-account",
        previewId: previewBody.data.previewId,
        payloadFingerprint: previewBody.data.payloadFingerprint,
        confirmedAtMs: 4_000,
      }),
    }),
    publishEnv,
    { store, now: () => 4_000 },
  );
  assert.equal(confirm.status, 202);
  const operationId = (await confirm.json() as { data: { operationId: string } }).data.operationId;
  assert.deepEqual(queued, [{ version: 1, type: "publish_destination", operationId }]);
  const operation = await handleConnectorRequest(
    new Request("https://connector/v1/publish/operation", { method: "POST", headers, body: JSON.stringify({ accountId: "allowed-account", operationId }) }),
    publishEnv,
    { store },
  );
  assert.equal((await operation.json() as { data: { state: { phase: string } } }).data.state.phase, "confirmed");
  const cancelled = await handleConnectorRequest(
    new Request("https://connector/v1/publish/cancel", { method: "POST", headers, body: JSON.stringify({ accountId: "allowed-account", operationId }) }),
    publishEnv,
    { store, now: () => 5_000 },
  );
  assert.equal((await cancelled.json() as { data: { status: string } }).data.status, "cancelled");

  const disconnected = await handleConnectorRequest(
    new Request("https://connector/v1/connections/spotify", { method: "DELETE", headers, body: JSON.stringify({ accountId: "allowed-account", connectionId: "c" }) }),
    base,
    { store },
  );
  assert.equal(disconnected.status, 200);
  assert.equal(await store.getConnection("allowed-account", "c", "spotify"), null);
  assert.equal(await store.getConnectionGeneration("allowed-account", "c", "spotify"), null);
  await store.saveConnection(connection!);
  assert.equal(await store.getConnection("allowed-account", "c", "spotify"), null, "a stale token refresh must not reactivate a revoked connection");
  assert.equal(store.jobs.size, 0);
  assert.equal(store.previews.size, 0);

  const removedConnection = { ...connection!, accountId: "removed-from-provider-pilot", connectionId: "removed-provider", generation: 0 };
  await store.saveConnection(removedConnection);
  const removedStatus = await handleConnectorRequest(
    new Request("https://connector/v1/connections/status", {
      method: "POST",
      headers,
      body: JSON.stringify({ accountId: removedConnection.accountId, connectionId: removedConnection.connectionId, provider: "spotify" }),
    }),
    env({ SPOTIFY_PILOT_ACCOUNT_ALLOWLIST: "", SPOTIFY_ENABLED: "false" }),
    { store },
  );
  assert.deepEqual((await removedStatus.json() as { data: unknown }).data, {
    provider: "spotify",
    connectionId: removedConnection.connectionId,
    connected: true,
    enabled: false,
    publishingEnabled: false,
    storefront: "US",
  });
  const removedDisconnect = await handleConnectorRequest(
    new Request("https://connector/v1/connections/spotify", {
      method: "DELETE",
      headers,
      body: JSON.stringify({ accountId: removedConnection.accountId, connectionId: removedConnection.connectionId }),
    }),
    env({ SPOTIFY_PILOT_ACCOUNT_ALLOWLIST: "", SPOTIFY_ENABLED: "false" }),
    { store },
  );
  assert.equal(removedDisconnect.status, 200);
  assert.equal(await store.getConnection(removedConnection.accountId, removedConnection.connectionId, "spotify"), null);

  const removedFromPilot = "removed-from-pilot";
  await store.saveConnection({ ...connection!, accountId: removedFromPilot, connectionId: "account-purge", generation: 0 });
  const purged = await handleConnectorRequest(
    new Request("https://connector/v1/accounts/purge", { method: "POST", headers, body: JSON.stringify({ accountId: removedFromPilot }) }),
    env({ SPOTIFY_PILOT_ACCOUNT_ALLOWLIST: "", APPLE_MUSIC_PILOT_ACCOUNT_ALLOWLIST: "" }),
    { store, now: () => 6_000 },
  );
  assert.equal(purged.status, 200);
  assert.equal(await store.getConnection(removedFromPilot, "account-purge", "spotify"), null);
  assert.equal(await store.getConnectionGeneration(removedFromPilot, "account-purge", "spotify"), null);
});

test("router caps the actual JSON stream when Content-Length is missing", async () => {
  const request = new Request("https://connector/v1/connections/status", {
    method: "POST",
    headers: { Authorization: "Bearer internal-fixture-secret", "Content-Type": "application/json" },
    body: JSON.stringify({ padding: "x".repeat(33_000) }),
  });
  assert.equal(request.headers.has("Content-Length"), false);
  const response = await handleConnectorRequest(request, env(), { store: new MemoryStore() });
  assert.equal(response.status, 413);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "BODY_TOO_LARGE");
});

test("disabled providers expose a clean closed-pilot status without an allowlist entry", async () => {
  const closedEnv = env({
    SPOTIFY_ENABLED: "false",
    SPOTIFY_PUBLISHING_ENABLED: "false",
  });
  Reflect.deleteProperty(closedEnv, "SPOTIFY_PILOT_ACCOUNT_ALLOWLIST");
  const response = await handleConnectorRequest(
    new Request("https://connector/v1/connections/status", {
      method: "POST",
      headers: { Authorization: "Bearer internal-fixture-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: "not-allowlisted", connectionId: "spotify:not-allowlisted", provider: "spotify" }),
    }),
    closedEnv,
    { store: new MemoryStore() },
  );
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json() as { data: unknown }).data, {
    provider: "spotify",
    connectionId: "spotify:not-allowlisted",
    connected: false,
    enabled: false,
    publishingEnabled: false,
    storefront: null,
  });
});

test("provider pilot allowlists are independent while status remains available for cleanup", async () => {
  const store = new MemoryStore();
  const headers = { Authorization: "Bearer internal-fixture-secret", "Content-Type": "application/json" };
  const spotifyOnly = env({
    SPOTIFY_PILOT_ACCOUNT_ALLOWLIST: "spotify-host",
    APPLE_MUSIC_PILOT_ACCOUNT_ALLOWLIST: "apple-host",
  });
  const allowed = await handleConnectorRequest(
    new Request("https://connector/v1/connections/status", {
      method: "POST",
      headers,
      body: JSON.stringify({ accountId: "spotify-host", connectionId: "spotify:spotify-host", provider: "spotify" }),
    }),
    spotifyOnly,
    { store },
  );
  assert.equal(allowed.status, 200);

  const closed = await handleConnectorRequest(
    new Request("https://connector/v1/connections/status", {
      method: "POST",
      headers,
      body: JSON.stringify({ accountId: "spotify-host", connectionId: "apple-music:spotify-host", provider: "apple_music" }),
    }),
    spotifyOnly,
    { store },
  );
  assert.equal(closed.status, 200);
  assert.equal((await closed.json() as { data: { enabled: boolean } }).data.enabled, false);

  const denied = await handleConnectorRequest(
    new Request("https://connector/v1/oauth/spotify/authorize", {
      method: "POST",
      headers,
      body: JSON.stringify({ accountId: "apple-host", connectionId: "spotify:apple-host", origin: spotifyOnly.PUBLIC_APP_ORIGIN }),
    }),
    spotifyOnly,
    { store },
  );
  assert.equal(denied.status, 403);
  assert.equal((await denied.json() as { error: { code: string } }).error.code, "PILOT_NOT_ALLOWED");
});

test("malformed or over-limit provider allowlist secrets fail closed", async () => {
  const headers = { Authorization: "Bearer internal-fixture-secret", "Content-Type": "application/json" };
  for (const configured of [
    "target,target",
    "one,two,three,four,five,target",
  ]) {
    const response = await handleConnectorRequest(
      new Request("https://connector/v1/connections/status", {
        method: "POST",
        headers,
        body: JSON.stringify({ accountId: "target", connectionId: "spotify:target", provider: "spotify" }),
      }),
      env({ SPOTIFY_PILOT_ACCOUNT_ALLOWLIST: configured }),
      { store: new MemoryStore() },
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { data: { enabled: boolean } }).data.enabled, false);
  }
});

test("Apple public catalog and provider-link metadata need no listener token", async () => {
  const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const privateJwk = await crypto.subtle.exportKey("jwk", key.privateKey);
  const store = new MemoryStore();
  const headers = { Authorization: "Bearer internal-fixture-secret", "Content-Type": "application/json" };
  const mixed = env({
    APPLE_PRIVATE_KEY_JWK: JSON.stringify(privateJwk),
    SPOTIFY_PILOT_ACCOUNT_ALLOWLIST: "spotify-host",
    APPLE_MUSIC_PILOT_ACCOUNT_ALLOWLIST: "apple-host",
  });
  const appleSong = {
    data: [{
      id: "203709340",
      type: "songs",
      attributes: { name: "Fixture Song", artistName: "Fixture Artist", isrc: "USFIX2600001", durationInMillis: 180_000 },
    }],
  };
  const catalog = await handleConnectorRequest(new Request("https://connector/v1/catalog/query", {
    method: "POST",
    headers,
    body: JSON.stringify({ accountId: "apple-host", connectionId: "apple-music:apple-host", provider: "apple_music", mode: "recording_id", providerRecordingId: "203709340" }),
  }), mixed, { store, fetcher: async () => Response.json(appleSong), now: () => 2_000 });
  assert.equal(catalog.status, 200);
  assert.equal((await catalog.json() as { data: { title: string } }).data.title, "Fixture Song");
  assert.equal(await store.getConnection("apple-host", "apple-music:apple-host", "apple_music"), null);

  const publicCatalog = await handleConnectorRequest(new Request("https://connector/v1/catalog/public-query", {
    method: "POST",
    headers,
    body: JSON.stringify({ provider: "apple_music", mode: "recording_id", providerRecordingId: "203709340" }),
  }), mixed, { store, fetcher: async () => Response.json(appleSong), now: () => 2_000 });
  assert.equal(publicCatalog.status, 200);
  assert.equal((await publicCatalog.json() as { data: { title: string } }).data.title, "Fixture Song");

  const spotifyPublicCatalog = await handleConnectorRequest(new Request("https://connector/v1/catalog/public-query", {
    method: "POST",
    headers,
    body: JSON.stringify({ provider: "spotify", mode: "recording_id", providerRecordingId: "4uLU6hMCjMI75M1A2tKUQC" }),
  }), mixed, { store, now: () => 2_000 });
  assert.equal(spotifyPublicCatalog.status, 409);
  assert.equal((await spotifyPublicCatalog.json() as { error: { code: string } }).error.code, "LISTENER_CONNECTION_REQUIRED");

  const appleSourceForSpotifyHost = await handleConnectorRequest(new Request("https://connector/v1/catalog/source", {
    method: "POST",
    headers,
    body: JSON.stringify({ provider: "apple_music", providerRecordingId: "203709340" }),
  }), mixed, { store, fetcher: async () => Response.json(appleSong), now: () => 2_000 });
  assert.equal(appleSourceForSpotifyHost.status, 200);
  assert.equal((await appleSourceForSpotifyHost.json() as { data: { isrc: string } }).data.isrc, "USFIX2600001");

  const spotifySourceForAppleHost = await handleConnectorRequest(new Request("https://connector/v1/catalog/source", {
    method: "POST",
    headers,
    body: JSON.stringify({ provider: "spotify", providerRecordingId: "4uLU6hMCjMI75M1A2tKUQC" }),
  }), mixed, { store, fetcher: async () => Response.json({
    provider_name: "Spotify", provider_url: "https://spotify.com", type: "rich", title: "Fixture Song",
    iframe_url: "https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC",
  }), now: () => 2_000 });
  assert.equal(spotifySourceForAppleHost.status, 200);
  assert.equal((await spotifySourceForAppleHost.json() as { data: { metadataComplete: boolean } }).data.metadataComplete, false);

  const publicSpotifySource = await handleConnectorRequest(new Request("https://connector/v1/catalog/source", {
    method: "POST",
    headers,
    body: JSON.stringify({ provider: "spotify", providerRecordingId: "4uLU6hMCjMI75M1A2tKUQC" }),
  }), mixed, { store, fetcher: async () => Response.json({
    provider_name: "Spotify", provider_url: "https://spotify.com", type: "rich", title: "Fixture Song",
    iframe_url: "https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC",
  }), now: () => 2_000 });
  assert.equal(publicSpotifySource.status, 200);
});

test("disconnect fences an OAuth callback that already consumed its one-time state", async () => {
  const store = new MemoryStore();
  const base = env();
  const headers = { Authorization: "Bearer internal-fixture-secret", "Content-Type": "application/json" };
  const started = await handleConnectorRequest(new Request("https://connector/v1/oauth/spotify/authorize", {
    method: "POST",
    headers,
    body: JSON.stringify({ accountId: "allowed-account", connectionId: "oauth-race", origin: base.PUBLIC_APP_ORIGIN }),
  }), base, { store, now: () => 1_000 });
  const state = new URL((await started.json() as { data: { authorizeUrl: string } }).data.authorizeUrl).searchParams.get("state")!;
  const entered = deferred();
  const release = deferred();
  const callback = handleConnectorRequest(new Request("https://connector/v1/oauth/spotify/callback", {
    method: "POST",
    headers,
    body: JSON.stringify({ accountId: "allowed-account", code: "code", state, callbackUrl: spotifyCallbackUrl(base.PUBLIC_APP_ORIGIN) }),
  }), base, {
    store,
    now: () => 2_000,
    fetcher: async () => {
      entered.resolve();
      await release.promise;
      return Response.json({ access_token: "stale-access", refresh_token: "stale-refresh", token_type: "Bearer", expires_in: 3600, scope: "playlist-modify-private playlist-read-private user-read-private user-library-read" });
    },
  });
  await entered.promise;
  const disconnected = await handleConnectorRequest(new Request("https://connector/v1/connections/spotify", {
    method: "DELETE",
    headers,
    body: JSON.stringify({ accountId: "allowed-account", connectionId: "oauth-race" }),
  }), base, { store, now: () => 2_001 });
  assert.equal(disconnected.status, 200);
  release.resolve();
  assert.equal((await callback).status, 409);
  assert.equal(await store.getConnection("allowed-account", "oauth-race", "spotify"), null);
  assert.equal(store.attempts.size, 0);
});

function publishJob(): PublishJobRecord {
  const preview = createPublishPreview({
    roomId: "room",
    roomRevision: 1,
    ownerAccountId: "allowed-account",
    provider: "spotify",
    playlistName: "Fixture",
    items: [
      { canonicalRecordingId: "c1", providerRecordingId: "4uLU6hMCjMI75M1A2tKUQC" },
      { canonicalRecordingId: "c2", providerRecordingId: "6habFhsOp2NvshLv26DqMb" },
    ],
    createdAtMs: 1_000,
  });
  const operation = confirmPublishPreview(preview, {
    previewId: preview.previewId,
    payloadFingerprint: preview.payloadFingerprint,
    confirmedByAccountId: "allowed-account",
    confirmedAtMs: 2_000,
  });
  let state = startPublishAttempt(createDestinationPublishState(operation), 3_000);
  state = recordPublishAttemptOutcome(state, { kind: "ambiguous_timeout", safeError: "unknown" });
  return {
    operationId: operation.operationId,
    accountId: "allowed-account",
    connectionId: "spotify-connection",
    provider: "spotify",
    connectionGeneration: 1,
    revision: 0,
    destinationPlaylistId: "playlist",
    state,
    updatedAtMs: 3_000,
  };
}

function activate(store: MemoryStore, job: PublishJobRecord): void {
  store.fences.set(store.key(job.accountId, job.connectionId, job.provider), {
    generation: job.connectionGeneration,
    status: "active",
  });
}

test("queue reconciles timeout-after-commit before appending and kill switches fail closed", async () => {
  const store = new MemoryStore();
  const job = publishJob();
  store.jobs.set(job.operationId, job);
  activate(store, job);
  let readCount = 0;
  let appended: readonly string[] = [];
  const adapter = {
    provider: "spotify",
    async readPlaylist() {
      readCount += 1;
      return { provider: "spotify", playlistId: "playlist", items: [{ providerRecordingId: "4uLU6hMCjMI75M1A2tKUQC", position: 0 }], observedAtMs: 4_000 };
    },
    async appendItems(_context: unknown, request: { providerRecordingIds: readonly string[] }) {
      appended = request.providerRecordingIds;
      return { provider: "spotify", playlistId: "playlist", acceptedCount: request.providerRecordingIds.length, revisionToken: "snapshot" };
    },
  } as unknown as ProviderAdapter;
  const result = await processPublishJob(env(), job.operationId, { store, adapter, now: () => 5_000 });
  assert.deepEqual(result, { kind: "ack" });
  assert.equal(readCount, 1);
  assert.deepEqual(appended, ["6habFhsOp2NvshLv26DqMb"]);
  assert.equal(store.jobs.get(job.operationId)?.state.phase, "succeeded");

  const pausedStore = new MemoryStore();
  pausedStore.jobs.set(job.operationId, job);
  activate(pausedStore, job);
  const paused = await processPublishJob(env({ SPOTIFY_PUBLISHING_ENABLED: "false" }), job.operationId, { store: pausedStore, adapter, now: () => 5_000 });
  assert.deepEqual(paused, { kind: "retry", delaySeconds: 300 });
  assert.equal(pausedStore.jobs.get(job.operationId)?.state.phase, "reconcile_before_retry");
});

test("reconciliation persists reconnect and honors provider Retry-After", async () => {
  const authorizationStore = new MemoryStore();
  const authorizationJob = publishJob();
  authorizationStore.jobs.set(authorizationJob.operationId, authorizationJob);
  activate(authorizationStore, authorizationJob);
  const unauthorizedAdapter = {
    provider: "spotify",
    async readPlaylist() {
      throw failureForResponse("spotify", new Response(null, { status: 401 }), 5_000, false);
    },
  } as unknown as ProviderAdapter;
  const unauthorized = await processPublishJob(env(), authorizationJob.operationId, {
    store: authorizationStore,
    adapter: unauthorizedAdapter,
    now: () => 5_000,
  });
  assert.deepEqual(unauthorized, { kind: "ack" });
  assert.equal(authorizationStore.jobs.get(authorizationJob.operationId)?.state.phase, "reconnect");

  const limitedStore = new MemoryStore();
  const limitedJob = publishJob();
  limitedStore.jobs.set(limitedJob.operationId, limitedJob);
  activate(limitedStore, limitedJob);
  const limitedAdapter = {
    provider: "spotify",
    async readPlaylist() {
      throw failureForResponse("spotify", new Response(null, { status: 429, headers: { "Retry-After": "12" } }), 5_000, false);
    },
  } as unknown as ProviderAdapter;
  const limited = await processPublishJob(env(), limitedJob.operationId, {
    store: limitedStore,
    adapter: limitedAdapter,
    now: () => 5_000,
  });
  assert.deepEqual(limited, { kind: "retry", delaySeconds: 12 });
  assert.equal(limitedStore.jobs.get(limitedJob.operationId)?.reconciliationNotBeforeMs, 17_000);
});

test("Apple reconciliation waits for two stable observations before an append retry", async () => {
  const spotifyJob = publishJob();
  const applePreview = createPublishPreview({
    roomId: "apple-room",
    roomRevision: 1,
    ownerAccountId: "allowed-account",
    provider: "apple_music",
    playlistName: "Apple Fixture",
    items: [{ canonicalRecordingId: "apple-c1", providerRecordingId: "1440833098" }],
    createdAtMs: 1_000,
  });
  const operation = confirmPublishPreview(applePreview, {
    previewId: applePreview.previewId,
    payloadFingerprint: applePreview.payloadFingerprint,
    confirmedByAccountId: "allowed-account",
    confirmedAtMs: 2_000,
  });
  let state = startPublishAttempt(createDestinationPublishState(operation), 3_000);
  state = recordPublishAttemptOutcome(state, { kind: "ambiguous_timeout", safeError: "Apple propagation is pending" });
  const job: PublishJobRecord = {
    ...spotifyJob,
    operationId: operation.operationId,
    provider: "apple_music",
    connectionId: "apple-connection",
    state,
  };
  const store = new MemoryStore();
  store.jobs.set(job.operationId, job);
  activate(store, job);
  let reads = 0;
  let appends = 0;
  const adapter = {
    provider: "apple_music",
    async readPlaylist() {
      reads += 1;
      return { provider: "apple_music", playlistId: "playlist", items: [], observedAtMs: 5_000 };
    },
    async appendItems() {
      appends += 1;
      return { provider: "apple_music", playlistId: "playlist", acceptedCount: 1 };
    },
  } as unknown as ProviderAdapter;
  const first = await processPublishJob(env(), job.operationId, { store, adapter, now: () => 5_000 });
  assert.deepEqual(first, { kind: "retry", delaySeconds: 30 });
  assert.equal(reads, 1);
  assert.equal(appends, 0);

  const second = await processPublishJob(env(), job.operationId, { store, adapter, now: () => 35_000 });
  assert.deepEqual(second, { kind: "ack" });
  assert.equal(reads, 2);
  assert.equal(appends, 1);
  assert.equal(store.jobs.get(job.operationId)?.state.phase, "succeeded");
});

function confirmedJob(destinationPlaylistId?: string): PublishJobRecord {
  const preview = createPublishPreview({
    roomId: "fenced-room",
    roomRevision: 7,
    ownerAccountId: "allowed-account",
    provider: "spotify",
    playlistName: "Fenced fixture",
    items: [{ canonicalRecordingId: "canonical-fenced", providerRecordingId: "4uLU6hMCjMI75M1A2tKUQC" }],
    createdAtMs: 1_000,
  });
  const operation = confirmPublishPreview(preview, {
    previewId: preview.previewId,
    payloadFingerprint: preview.payloadFingerprint,
    confirmedByAccountId: "allowed-account",
    confirmedAtMs: 2_000,
  });
  return {
    operationId: operation.operationId,
    accountId: "allowed-account",
    connectionId: "fenced-connection",
    provider: "spotify",
    connectionGeneration: 1,
    revision: 0,
    ...(destinationPlaylistId ? { destinationPlaylistId } : {}),
    state: createDestinationPublishState(operation),
    updatedAtMs: 2_000,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("confirmation re-enqueues an existing nonterminal operation after a Queue delivery failure", async () => {
  const store = new MemoryStore();
  const job = confirmedJob();
  activate(store, job);
  const preview = job.state.operation.preview;
  store.previews.set(`${job.accountId}:${preview.previewId}`, {
    preview,
    connectionId: job.connectionId,
    expiresAtMs: 30_000,
  });
  let sends = 0;
  const connectorEnv = env({
    PUBLISH_QUEUE: { send: async () => { sends += 1; if (sends === 1) throw new Error("queue unavailable"); } } as unknown as Queue,
  });
  const request = () => new Request("https://connector/v1/publish/confirm", {
    method: "POST",
    headers: { Authorization: "Bearer internal-fixture-secret", "Content-Type": "application/json" },
    body: JSON.stringify({
      accountId: job.accountId,
      previewId: preview.previewId,
      payloadFingerprint: preview.payloadFingerprint,
      confirmedAtMs: 3_000,
    }),
  });
  assert.equal((await handleConnectorRequest(request(), connectorEnv, { store, now: () => 3_000 })).status, 500);
  assert.equal(store.jobs.get(job.operationId)?.state.phase, "confirmed");
  assert.equal((await handleConnectorRequest(request(), connectorEnv, { store, now: () => 3_001 })).status, 202);
  assert.equal(sends, 2);
});

test("retry and cancel report a conflict when a provider mutation lease wins the CAS", async () => {
  const store = new MemoryStore();
  const base = confirmedJob();
  activate(store, base);
  store.jobs.set(base.operationId, {
    ...base,
    mutationLease: {
      token: "active-lease",
      stage: "create_playlist",
      acquiredAtMs: 3_000,
      expiresAtMs: 33_000,
      marker: publishRecoveryMarker(base.operationId),
    },
  });
  const connectorEnv = env({ PUBLISH_QUEUE: { send: async () => undefined } as unknown as Queue });
  const request = (path: "retry" | "cancel") => new Request(`https://connector/v1/publish/${path}`, {
    method: "POST",
    headers: { Authorization: "Bearer internal-fixture-secret", "Content-Type": "application/json" },
    body: JSON.stringify({ accountId: base.accountId, operationId: base.operationId }),
  });
  const retried = await handleConnectorRequest(request("retry"), connectorEnv, { store, now: () => 4_000 });
  assert.equal(retried.status, 409);
  assert.equal((await retried.json() as { error: { code: string } }).error.code, "OPERATION_CHANGED");
  const cancelled = await handleConnectorRequest(request("cancel"), connectorEnv, { store, now: () => 4_001 });
  assert.equal(cancelled.status, 409);
  assert.equal((await cancelled.json() as { error: { code: string } }).error.code, "OPERATION_IN_FLIGHT");
  assert.equal(store.jobs.get(base.operationId)?.state.phase, "confirmed");
});

test("concurrent duplicate deliveries acquire one fence and perform one provider mutation", async () => {
  const store = new MemoryStore();
  const job = confirmedJob();
  store.jobs.set(job.operationId, job);
  activate(store, job);
  const entered = deferred();
  const release = deferred();
  let creates = 0;
  let appends = 0;
  const adapter = {
    provider: "spotify",
    async createPrivatePlaylist() {
      creates += 1;
      entered.resolve();
      await release.promise;
      return { provider: "spotify", playlistId: "playlist-fenced", isPrivate: true };
    },
    async appendItems() {
      appends += 1;
      return { provider: "spotify", playlistId: "playlist-fenced", acceptedCount: 1 };
    },
  } as unknown as ProviderAdapter;
  const first = processPublishJob(env(), job.operationId, { store, adapter, now: () => 3_000, randomToken: () => "lease-first" });
  await entered.promise;
  const duplicate = await processPublishJob(env(), job.operationId, { store, adapter, now: () => 3_001, randomToken: () => "lease-duplicate" });
  assert.deepEqual(duplicate, { kind: "retry", delaySeconds: 30 });
  assert.equal(creates, 1);
  release.resolve();
  assert.deepEqual(await first, { kind: "ack" });
  assert.equal(creates, 1);
  assert.equal(appends, 1);
  assert.equal(store.jobs.get(job.operationId)?.state.phase, "succeeded");
});

test("crash-after-create never replays playlist creation and requires operator recovery", async () => {
  const store = new MemoryStore();
  const job = confirmedJob();
  store.jobs.set(job.operationId, job);
  activate(store, job);
  let creates = 0;
  const adapter = {
    provider: "spotify",
    async createPrivatePlaylist() {
      creates += 1;
      return { provider: "spotify", playlistId: "committed-before-crash", isPrivate: true };
    },
  } as unknown as ProviderAdapter;
  await assert.rejects(
    processPublishJob(env(), job.operationId, {
      store,
      adapter,
      now: () => 3_000,
      randomToken: () => "lease-create-crash",
      afterProviderMutation: () => { throw new Error("simulated worker termination"); },
    }),
    /simulated worker termination/,
  );
  assert.equal(creates, 1);
  assert.equal(store.jobs.get(job.operationId)?.mutationLease?.stage, "create_playlist");
  const redelivery = await processPublishJob(env(), job.operationId, { store, adapter, now: () => 34_000 });
  assert.deepEqual(redelivery, { kind: "ack" });
  assert.equal(creates, 1);
  assert.equal(store.jobs.get(job.operationId)?.recoveryRequired?.code, "PLAYLIST_CREATION_OUTCOME_UNKNOWN");
  assert.match(store.jobs.get(job.operationId)?.recoveryRequired?.marker ?? "", /^unijam:v1:create_playlist:/);
});

test("operator recovery requires dual credentials, verifies an empty playlist, and resumes idempotently", async () => {
  const store = new MemoryStore();
  const base = confirmedJob();
  activate(store, base);
  const marker = publishRecoveryMarker(base.operationId);
  const state = recordPublishAttemptOutcome(startPublishAttempt(base.state, 3_000), {
    kind: "ambiguous_timeout",
    safeError: "Playlist creation outcome is unknown",
  });
  const job: PublishJobRecord = {
    ...base,
    state,
    recoveryRequired: { code: "PLAYLIST_CREATION_OUTCOME_UNKNOWN", marker, detectedAtMs: 3_001 },
  };
  store.jobs.set(job.operationId, job);
  const queued: unknown[] = [];
  let observedItems = [{ providerRecordingId: "unexpected-item", position: 0 }];
  let reads = 0;
  const adapter = {
    provider: "spotify",
    async readPlaylist() {
      reads += 1;
      return {
        provider: "spotify",
        playlistId: "playlist-recovered",
        destinationUrl: "https://open.spotify.com/playlist/playlist-recovered",
        name: job.state.operation.preview.destination.name,
        recoveryMarker: marker,
        rawItemCount: observedItems.length,
        isPrivate: true,
        ownershipVerified: true,
        items: observedItems,
        observedAtMs: 4_000,
      };
    },
  } as unknown as ProviderAdapter;
  const connectorEnv = env({
    PUBLISH_QUEUE: { send: async (message: unknown) => { queued.push(message); } } as unknown as Queue,
  });
  const request = (operatorSecret: string, expectedRecoveryMarker = marker) => new Request("https://connector/v1/operator/publish/recover-playlist", {
    method: "POST",
    headers: {
      Authorization: "Bearer internal-fixture-secret",
      "X-UniJam-Operator-Authorization": `Bearer ${operatorSecret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      operationId: job.operationId,
      expectedRecoveryMarker,
      destinationPlaylistId: "playlist-recovered",
    }),
  });

  const unauthorized = await handleConnectorRequest(request("wrong-secret"), connectorEnv, { store, recoveryAdapter: adapter, now: () => 4_000 });
  assert.equal(unauthorized.status, 403);
  assert.equal(reads, 0);
  const conflict = await handleConnectorRequest(request("operator-fixture-secret", "wrong-marker"), connectorEnv, { store, recoveryAdapter: adapter, now: () => 4_000 });
  assert.equal(conflict.status, 409);
  assert.equal(reads, 0);
  const nonempty = await handleConnectorRequest(request("operator-fixture-secret"), connectorEnv, { store, recoveryAdapter: adapter, now: () => 4_000 });
  assert.equal(nonempty.status, 409);
  assert.equal((await nonempty.json() as { error: { code: string } }).error.code, "RECOVERY_PLAYLIST_NOT_EMPTY");
  assert.equal(reads, 1);

  observedItems = [];
  const recovered = await handleConnectorRequest(request("operator-fixture-secret"), connectorEnv, { store, recoveryAdapter: adapter, now: () => 4_001 });
  assert.equal(recovered.status, 202);
  assert.equal((await recovered.json() as { data: { status: string } }).data.status, "recovered");
  assert.equal(store.jobs.get(job.operationId)?.destinationPlaylistId, "playlist-recovered");
  assert.equal(store.jobs.get(job.operationId)?.destinationUrl, "https://open.spotify.com/playlist/playlist-recovered");
  assert.equal(store.jobs.get(job.operationId)?.recoveryRequired, undefined);
  assert.match(store.jobs.get(job.operationId)?.recoveryResolution?.resolvedBy ?? "", /^operator-credential:[A-Za-z0-9_-]{20}$/);
  assert.notEqual(store.jobs.get(job.operationId)?.recoveryResolution?.destinationPlaylistHash, "playlist-recovered");
  assert.deepEqual(queued, [{ version: 1, type: "reconcile_destination", operationId: job.operationId }]);

  const status = await handleConnectorRequest(new Request("https://connector/v1/publish/operation", {
    method: "POST",
    headers: { Authorization: "Bearer internal-fixture-secret", "Content-Type": "application/json" },
    body: JSON.stringify({ accountId: job.accountId, operationId: job.operationId }),
  }), connectorEnv, { store, now: () => 4_001 });
  assert.equal(status.status, 200);
  assert.equal(
    (await status.json() as { data: { destinationUrl: string } }).data.destinationUrl,
    "https://open.spotify.com/playlist/playlist-recovered",
  );

  const repeated = await handleConnectorRequest(request("operator-fixture-secret"), connectorEnv, { store, recoveryAdapter: adapter, now: () => 4_002 });
  assert.equal(repeated.status, 202);
  assert.equal((await repeated.json() as { data: { status: string } }).data.status, "already_recovered");
  assert.equal(reads, 2);
  assert.equal(queued.length, 2);
});

test("crash-after-append reconciles committed items before any retry", async () => {
  const store = new MemoryStore();
  const job = confirmedJob("playlist-existing");
  store.jobs.set(job.operationId, job);
  activate(store, job);
  const providerItems: string[] = [];
  let appends = 0;
  let reads = 0;
  const adapter = {
    provider: "spotify",
    async appendItems(_context: unknown, request: { providerRecordingIds: string[] }) {
      appends += 1;
      providerItems.push(...request.providerRecordingIds);
      return { provider: "spotify", playlistId: "playlist-existing", acceptedCount: request.providerRecordingIds.length };
    },
    async readPlaylist() {
      reads += 1;
      return { provider: "spotify", playlistId: "playlist-existing", items: providerItems.map((providerRecordingId, position) => ({ providerRecordingId, position })), observedAtMs: 34_001 };
    },
  } as unknown as ProviderAdapter;
  await assert.rejects(processPublishJob(env(), job.operationId, {
    store,
    adapter,
    now: () => 3_000,
    randomToken: () => "lease-append-crash",
    afterProviderMutation: () => { throw new Error("simulated worker termination"); },
  }));
  assert.equal(appends, 1);
  assert.deepEqual(await processPublishJob(env(), job.operationId, { store, adapter, now: () => 34_000 }), { kind: "retry", delaySeconds: 1 });
  assert.deepEqual(await processPublishJob(env(), job.operationId, { store, adapter, now: () => 34_001 }), { kind: "ack" });
  assert.equal(reads, 1);
  assert.equal(appends, 1);
  assert.equal(store.jobs.get(job.operationId)?.state.phase, "succeeded");
});

test("disconnect fences an in-flight create and purges every provider-private record", async () => {
  const store = new MemoryStore();
  const job = confirmedJob();
  store.jobs.set(job.operationId, job);
  activate(store, job);
  store.previews.set("allowed-account:preview-private", {
    preview: job.state.operation.preview,
    connectionId: job.connectionId,
    expiresAtMs: 99_000,
  });
  store.attempts.set("oauth-private", {
    stateHash: "oauth-private",
    accountId: job.accountId,
    connectionId: job.connectionId,
    connectionGeneration: job.connectionGeneration,
    codeVerifier: "private-verifier",
    expiresAtMs: 99_000,
  });
  const entered = deferred();
  const release = deferred();
  let creates = 0;
  const adapter = {
    provider: "spotify",
    async createPrivatePlaylist() {
      creates += 1;
      entered.resolve();
      await release.promise;
      return { provider: "spotify", playlistId: "playlist-raced", isPrivate: true };
    },
  } as unknown as ProviderAdapter;
  const running = processPublishJob(env(), job.operationId, { store, adapter, now: () => 3_000, randomToken: () => "lease-disconnect-create" });
  await entered.promise;
  const disconnected = await handleConnectorRequest(new Request("https://connector/v1/connections/spotify", {
    method: "DELETE",
    headers: { Authorization: "Bearer internal-fixture-secret", "Content-Type": "application/json" },
    body: JSON.stringify({ accountId: job.accountId, connectionId: job.connectionId }),
  }), env(), { store, now: () => 3_001 });
  assert.equal(disconnected.status, 200);
  release.resolve();
  assert.deepEqual(await running, { kind: "ack" });
  assert.equal(store.jobs.size, 0);
  assert.equal(store.previews.size, 0);
  assert.equal(store.attempts.size, 0);
  assert.equal(await store.getConnectionGeneration(job.accountId, job.connectionId, job.provider), null);
  assert.deepEqual(await processPublishJob(env(), job.operationId, { store, adapter, now: () => 40_000 }), { kind: "ack" });
  assert.equal(creates, 1);
});

test("disconnect during append or reconciliation prevents every subsequent mutation", async () => {
  for (const phase of ["append", "reconcile"] as const) {
    const store = new MemoryStore();
    let job = confirmedJob("playlist-existing");
    if (phase === "reconcile") {
      let state = startPublishAttempt(job.state, 3_000);
      state = recordPublishAttemptOutcome(state, { kind: "ambiguous_timeout", safeError: "unknown" });
      job = { ...job, state };
    }
    store.jobs.set(job.operationId, job);
    activate(store, job);
    const entered = deferred();
    const release = deferred();
    let appends = 0;
    const adapter = {
      provider: "spotify",
      async readPlaylist() {
        entered.resolve();
        await release.promise;
        return { provider: "spotify", playlistId: "playlist-existing", items: [], observedAtMs: 3_000 };
      },
      async appendItems() {
        appends += 1;
        entered.resolve();
        await release.promise;
        return { provider: "spotify", playlistId: "playlist-existing", acceptedCount: 1 };
      },
    } as unknown as ProviderAdapter;
    const running = processPublishJob(env(), job.operationId, { store, adapter, now: () => 3_000, randomToken: () => `lease-disconnect-${phase}` });
    await entered.promise;
    await store.purgeProviderData(job.accountId, job.connectionId, job.provider, 3_001);
    release.resolve();
    assert.deepEqual(await running, { kind: "ack" });
    assert.equal(store.jobs.size, 0);
    assert.deepEqual(await processPublishJob(env(), job.operationId, { store, adapter, now: () => 40_000 }), { kind: "ack" });
    assert.equal(appends, phase === "append" ? 1 : 0);
  }
});
