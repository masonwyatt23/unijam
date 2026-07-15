import assert from "node:assert/strict";
import test from "node:test";

import { createPublishPreview, confirmPublishPreview, createDestinationPublishState, recordPublishAttemptOutcome, startPublishAttempt } from "../lib/publishing/model.ts";
import type { ProviderAdapter } from "../lib/providers/contracts.ts";
import type { MusicProvider } from "../lib/provider-state-engine.ts";
import { AppleMusicAdapter, createAppleDeveloperToken } from "./apple-music.ts";
import { ConnectorProviderError, failureForResponse } from "./errors.ts";
import { exchangeSpotifyAuthorizationCode, spotifyCallbackUrl, startSpotifyAuthorization } from "./oauth.ts";
import { processPublishJob } from "./queue.ts";
import { handleConnectorRequest } from "./router.ts";
import { encodeBase64Url } from "./storage.ts";
import { SpotifyAdapter } from "./spotify.ts";
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
  async purgeAccountData(accountId: string) {
    for (const connection of [...this.connections.values()]) {
      if (connection.accountId === accountId) await this.purgeProviderData(accountId, connection.connectionId, connection.provider, 0);
    }
    for (const [previewKey, preview] of this.previews) if (preview.preview.ownerAccountId === accountId) this.previews.delete(previewKey);
    for (const [operationId, job] of this.jobs) if (job.accountId === accountId) this.jobs.delete(operationId);
    for (const [stateHash, attempt] of this.attempts) if (attempt.accountId === accountId) this.attempts.delete(stateHash);
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
    if (!current && generation === job.connectionGeneration) this.jobs.set(job.operationId, job);
    else if (current && current.revision === job.revision && !current.mutationLease) this.jobs.set(job.operationId, { ...job, revision: job.revision + 1 });
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
}

function env(changes: Partial<ConnectorEnv> = {}): ConnectorEnv {
  return {
    CONNECTOR_DB: {} as D1Database,
    CONNECTOR_SHARED_SECRET: ["internal", "fixture", "secret"].join("-"),
    TOKEN_ENCRYPTION_KEY_B64URL: encodeBase64Url(new Uint8Array(32).fill(7)),
    TOKEN_KEY_VERSION: ["fixture", "key", "v1"].join("-"),
    PILOT_ACCOUNT_ALLOWLIST: "allowed-account",
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
        scope: "playlist-modify-private playlist-read-private",
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
    Response.json({ id: "playlist-fixture", snapshot_id: "snapshot-1" }),
    Response.json({ snapshot_id: "snapshot-2" }),
    Response.json({ items: [{ item: { id: "4uLU6hMCjMI75M1A2tKUQC", type: "track" } }], next: null }),
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
  const read = await adapter.readPlaylist(context, "playlist-fixture");
  assert.match(requests[2].url, /limit=50/);
  assert.deepEqual(read.items, [{ providerRecordingId: "4uLU6hMCjMI75M1A2tKUQC", position: 0 }]);
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
      return Response.json({ data: [{ id: "library-playlist", type: "library-playlists" }] });
    },
  });
  await createAdapter.createPrivatePlaylist(
    { requestId: "r", provider: "apple_music", storefront: "US" },
    { name: "Fixture", description: "Synthetic" },
  );
  assert.deepEqual(await createRequest?.json(), {
    attributes: { name: "Fixture", description: "Synthetic", isPublic: false },
  });

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
  assert.equal(JSON.stringify(developerBody).includes(jwk.d!), false);
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
    new Request("https://connector/v1/oauth/spotify/callback", { method: "POST", headers, body: JSON.stringify({ code: "code", state, callbackUrl: spotifyCallbackUrl(base.PUBLIC_APP_ORIGIN) }) }),
    base,
    {
      store,
      now: () => 2_000,
      fetcher: async () => Response.json({ access_token: "secret-access", refresh_token: "secret-refresh", token_type: "Bearer", expires_in: 3600, scope: "playlist-modify-private playlist-read-private" }),
    },
  );
  assert.equal(callback.status, 201);
  const connection = await store.getConnection("allowed-account", "c", "spotify");
  assert.ok(connection);
  assert.doesNotMatch(JSON.stringify(connection), /secret-access|secret-refresh/);

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

  await store.saveConnection({ ...connection!, connectionId: "account-purge", generation: 0 });
  const purged = await handleConnectorRequest(
    new Request("https://connector/v1/accounts/purge", { method: "POST", headers, body: JSON.stringify({ accountId: "allowed-account" }) }),
    base,
    { store, now: () => 6_000 },
  );
  assert.equal(purged.status, 200);
  assert.equal(await store.getConnection("allowed-account", "account-purge", "spotify"), null);
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
    body: JSON.stringify({ code: "code", state, callbackUrl: spotifyCallbackUrl(base.PUBLIC_APP_ORIGIN) }),
  }), base, {
    store,
    now: () => 2_000,
    fetcher: async () => {
      entered.resolve();
      await release.promise;
      return Response.json({ access_token: "stale-access", refresh_token: "stale-refresh", token_type: "Bearer", expires_in: 3600, scope: "playlist-modify-private playlist-read-private" });
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
