import type { ProviderAdapter, ProviderCatalogQuery } from "../lib/providers/contracts.ts";
import type { MusicProvider } from "../lib/provider-state-engine.ts";
import {
  cancelPublishOperation,
  confirmPublishPreview,
  createDestinationPublishState,
  createPublishPreview,
  requestPublishRetry,
} from "../lib/publishing/model.ts";
import { createAppleDeveloperToken, AppleMusicAdapter } from "./apple-music.ts";
import { isRecord, stringValue } from "./catalog-shape.ts";
import { loadEncryptedConnection, saveEncryptedConnection } from "./connections.ts";
import { ConnectorProviderError } from "./errors.ts";
import {
  exactAppOrigin,
  exchangeSpotifyAuthorizationCode,
  refreshSpotifyTokens,
  spotifyCallbackUrl,
  startSpotifyAuthorization,
} from "./oauth.ts";
import { D1ConnectorStore, sha256Base64Url } from "./storage.ts";
import { SpotifyAdapter, spotifyOEmbedMetadata } from "./spotify.ts";
import type { ConnectorEnv, ConnectorStore } from "./types.ts";
import { BoundedBodyError, readBoundedJson } from "../lib/server/bounded-body.ts";

const MAX_BODY_BYTES = 32_768;

class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface ConnectorRouterDependencies {
  readonly store?: ConnectorStore;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
  readonly recoveryAdapter?: ProviderAdapter;
}

function response(requestId: string, data: unknown, status = 200): Response {
  return Response.json({ data, error: null, requestId }, { status, headers: { "Cache-Control": "no-store" } });
}

function errorResponse(requestId: string, status: number, code: string, message: string, retryAtMs?: number): Response {
  return Response.json(
    { data: null, error: { code, message, ...(retryAtMs === undefined ? {} : { retryAtMs }) }, requestId },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

async function authenticated(request: Request, secret: string): Promise<boolean> {
  return authenticatedHeader(request, "Authorization", secret);
}

function bearerValue(request: Request, header: string): string {
  return request.headers.get(header)?.match(/^Bearer (.+)$/)?.[1] ?? "";
}

async function authenticatedHeader(request: Request, header: string, secret: string): Promise<boolean> {
  const supplied = bearerValue(request, header);
  if (!supplied || !secret) return false;
  const [actual, expected] = await Promise.all([sha256Base64Url(supplied), sha256Base64Url(secret)]);
  let difference = actual.length ^ expected.length;
  for (let index = 0; index < Math.max(actual.length, expected.length); index += 1) {
    difference |= (actual.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
  }
  return difference === 0;
}

async function readObject(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await readBoundedJson(request, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof BoundedBodyError) throw new HttpError(error.status, error.code, error.message);
    throw error;
  }
  if (!isRecord(value)) {
    throw new HttpError(400, "INVALID_BODY", "Request body must be a JSON object");
  }
  return value;
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = stringValue(body[field])?.trim();
  if (!value || value.length > 500) throw new HttpError(400, "INVALID_BODY", `${field} is required`);
  return value;
}

function requiredInteger(body: Record<string, unknown>, field: string): number {
  const value = body[field];
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new HttpError(400, "INVALID_BODY", `${field} must be a non-negative integer`);
  }
  return Number(value);
}

function providerValue(value: unknown): MusicProvider {
  if (value === "spotify" || value === "apple_music") return value;
  throw new HttpError(400, "INVALID_PROVIDER", "Provider must be Spotify or Apple Music");
}

function isAllowlisted(env: ConnectorEnv, accountId: string, provider: MusicProvider): boolean {
  const configured = provider === "spotify"
    ? env.SPOTIFY_PILOT_ACCOUNT_ALLOWLIST
    : env.APPLE_MUSIC_PILOT_ACCOUNT_ALLOWLIST;
  const accounts = new Set(configured.split(",").map((value) => value.trim()).filter(Boolean));
  return accounts.has(accountId);
}

function allowlisted(env: ConnectorEnv, accountId: string, provider: MusicProvider): void {
  if (!isAllowlisted(env, accountId, provider)) {
    throw new HttpError(403, "PILOT_NOT_ALLOWED", `This host is not in the ${provider === "spotify" ? "Spotify" : "Apple Music"} pilot`);
  }
}

function allowlistedForAnyProvider(env: ConnectorEnv, accountId: string): void {
  if (!isAllowlisted(env, accountId, "spotify") && !isAllowlisted(env, accountId, "apple_music")) {
    throw new HttpError(403, "PILOT_NOT_ALLOWED", "This host is not in a provider pilot");
  }
}

export function providerEnabled(env: ConnectorEnv, provider: MusicProvider, publishing = false): boolean {
  const enabled = provider === "spotify" ? env.SPOTIFY_ENABLED === "true" : env.APPLE_MUSIC_ENABLED === "true";
  if (!publishing) return enabled;
  return enabled && (provider === "spotify"
    ? env.SPOTIFY_PUBLISHING_ENABLED === "true"
    : env.APPLE_MUSIC_PUBLISHING_ENABLED === "true");
}

function requireProviderEnabled(env: ConnectorEnv, provider: MusicProvider, publishing = false): void {
  if (!providerEnabled(env, provider, publishing)) {
    throw new HttpError(503, "PROVIDER_DISABLED", `${provider === "spotify" ? "Spotify" : "Apple Music"} is temporarily disabled`);
  }
}

function applePrivateJwk(env: ConnectorEnv): JsonWebKey {
  let value: unknown;
  try {
    value = JSON.parse(env.APPLE_PRIVATE_KEY_JWK);
  } catch {
    throw new Error("APPLE_PRIVATE_KEY_JWK is invalid JSON");
  }
  if (!isRecord(value) || value.kty !== "EC" || value.crv !== "P-256" || !stringValue(value.d)) {
    throw new Error("APPLE_PRIVATE_KEY_JWK must be a private P-256 JWK");
  }
  return value as JsonWebKey;
}

async function adapterFor(input: {
  readonly env: ConnectorEnv;
  readonly store: ConnectorStore;
  readonly provider: MusicProvider;
  readonly accountId: string;
  readonly connectionId: string;
  readonly fetcher?: typeof fetch;
  readonly now: () => number;
}): Promise<ProviderAdapter> {
  let tokens = await loadEncryptedConnection(input);
  if (!tokens) throw new HttpError(409, "PROVIDER_NOT_CONNECTED", "Connect this provider first");
  if (
    input.provider === "spotify" &&
    tokens.expiresAtMs !== undefined &&
    tokens.expiresAtMs <= input.now() + 60_000
  ) {
    if (!tokens.refreshToken) throw new HttpError(409, "PROVIDER_RECONNECT_REQUIRED", "Reconnect Spotify");
    const refreshed = await refreshSpotifyTokens({
      clientId: input.env.SPOTIFY_CLIENT_ID,
      refreshToken: tokens.refreshToken,
      nowMs: input.now(),
      fetcher: input.fetcher,
    });
    tokens = { ...refreshed, scopes: refreshed.scopes.length ? refreshed.scopes : tokens.scopes };
    if (!(await saveEncryptedConnection({ ...input, tokens, nowMs: input.now() }))) {
      throw new HttpError(409, "PROVIDER_RECONNECT_REQUIRED", "The provider connection was revoked");
    }
  }
  if (input.provider === "spotify") {
    return new SpotifyAdapter({ accessToken: tokens.accessToken, fetcher: input.fetcher, now: input.now });
  }
  const developerToken = await createAppleDeveloperToken({
    teamId: input.env.APPLE_TEAM_ID,
    keyId: input.env.APPLE_KEY_ID,
    privateKeyJwk: applePrivateJwk(input.env),
    nowMs: input.now(),
  });
  return new AppleMusicAdapter({ developerToken, musicUserToken: tokens.accessToken, fetcher: input.fetcher, now: input.now });
}

async function catalogAdapterFor(input: {
  readonly env: ConnectorEnv;
  readonly store: ConnectorStore;
  readonly provider: MusicProvider;
  readonly accountId: string;
  readonly connectionId: string;
  readonly fetcher?: typeof fetch;
  readonly now: () => number;
}): Promise<ProviderAdapter> {
  if (input.provider === "spotify") return adapterFor(input);
  const developerToken = await createAppleDeveloperToken({
    teamId: input.env.APPLE_TEAM_ID,
    keyId: input.env.APPLE_KEY_ID,
    privateKeyJwk: applePrivateJwk(input.env),
    nowMs: input.now(),
  });
  return new AppleMusicAdapter({ developerToken, fetcher: input.fetcher, now: input.now });
}

function assertCallback(body: Record<string, unknown>, origin: string): void {
  if (requiredString(body, "callbackUrl") !== spotifyCallbackUrl(origin)) {
    throw new HttpError(400, "CALLBACK_MISMATCH", "Spotify callback URL does not match the configured callback");
  }
}

export async function handleConnectorRequest(
  request: Request,
  env: ConnectorEnv,
  dependencies: ConnectorRouterDependencies = {},
): Promise<Response> {
  const requestId = request.headers.get("X-Request-Id")?.slice(0, 128) || crypto.randomUUID();
  const url = new URL(request.url);
  const now = dependencies.now ?? Date.now;
  const store = dependencies.store ?? new D1ConnectorStore(env.CONNECTOR_DB);

  if (request.method === "GET" && url.pathname === "/health") {
    return response(requestId, { status: "ok" });
  }
  if (!(await authenticated(request, env.CONNECTOR_SHARED_SECRET))) {
    return errorResponse(requestId, 401, "UNAUTHORIZED", "Connector authentication failed");
  }

  try {
    const origin = exactAppOrigin(env.PUBLIC_APP_ORIGIN);

    if (request.method === "POST" && url.pathname === "/v1/oauth/spotify/authorize") {
      requireProviderEnabled(env, "spotify");
      const body = await readObject(request);
      const accountId = requiredString(body, "accountId");
      const connectionId = requiredString(body, "connectionId");
      allowlisted(env, accountId, "spotify");
      if (requiredString(body, "origin") !== origin) throw new HttpError(400, "ORIGIN_MISMATCH", "Origin does not match UniJam");
      const started = await startSpotifyAuthorization({
        store,
        clientId: env.SPOTIFY_CLIENT_ID,
        appOrigin: origin,
        accountId,
        connectionId,
        nowMs: now(),
      });
      return response(requestId, started, 201);
    }

    if (request.method === "POST" && url.pathname === "/v1/oauth/spotify/callback") {
      requireProviderEnabled(env, "spotify");
      const body = await readObject(request);
      assertCallback(body, origin);
      const accountId = requiredString(body, "accountId");
      const code = requiredString(body, "code");
      const state = requiredString(body, "state");
      const attempt = await store.consumeOAuthAttempt(await sha256Base64Url(state), now());
      if (!attempt) throw new HttpError(400, "OAUTH_STATE_INVALID", "Spotify authorization expired or was already used");
      if (attempt.accountId !== accountId) throw new HttpError(403, "OAUTH_ACCOUNT_MISMATCH", "Spotify authorization does not belong to this host session");
      allowlisted(env, attempt.accountId, "spotify");
      const tokens = await exchangeSpotifyAuthorizationCode({
        clientId: env.SPOTIFY_CLIENT_ID,
        appOrigin: origin,
        code,
        codeVerifier: attempt.codeVerifier,
        nowMs: now(),
        fetcher: dependencies.fetcher,
      });
      const saved = await saveEncryptedConnection({
        env,
        store,
        accountId: attempt.accountId,
        connectionId: attempt.connectionId,
        provider: "spotify",
        tokens,
        nowMs: now(),
        connectionGeneration: attempt.connectionGeneration,
      });
      if (!saved) throw new HttpError(409, "CONNECTION_REVOKED", "This provider connection was disconnected");
      return response(requestId, { provider: "spotify", connectionId: attempt.connectionId, storefront: "US" }, 201);
    }

    if (request.method === "POST" && url.pathname === "/v1/connections/apple-music") {
      requireProviderEnabled(env, "apple_music");
      const body = await readObject(request);
      const accountId = requiredString(body, "accountId");
      const connectionId = requiredString(body, "connectionId");
      const musicUserToken = requiredString(body, "musicUserToken");
      allowlisted(env, accountId, "apple_music");
      if (requiredString(body, "origin") !== origin) throw new HttpError(400, "ORIGIN_MISMATCH", "Origin does not match UniJam");
      const developerToken = await createAppleDeveloperToken({
        teamId: env.APPLE_TEAM_ID,
        keyId: env.APPLE_KEY_ID,
        privateKeyJwk: applePrivateJwk(env),
        nowMs: now(),
      });
      const adapter = new AppleMusicAdapter({ developerToken, musicUserToken, fetcher: dependencies.fetcher, now });
      const connectionGeneration = await store.reserveConnection(accountId, connectionId, "apple_music", now());
      await adapter.validateMusicUserToken();
      const saved = await saveEncryptedConnection({
        env,
        store,
        accountId,
        connectionId,
        provider: "apple_music",
        tokens: { accessToken: musicUserToken, scopes: [] },
        nowMs: now(),
        connectionGeneration,
      });
      if (!saved) throw new HttpError(409, "CONNECTION_REVOKED", "This provider connection was disconnected");
      return response(requestId, { provider: "apple_music", connectionId, storefront: "US" }, 201);
    }

    if (request.method === "POST" && url.pathname === "/v1/apple-music/developer-token") {
      requireProviderEnabled(env, "apple_music");
      const body = await readObject(request);
      const accountId = requiredString(body, "accountId");
      allowlisted(env, accountId, "apple_music");
      if (requiredString(body, "origin") !== origin) throw new HttpError(400, "ORIGIN_MISMATCH", "Origin does not match UniJam");
      const issuedAtMs = now();
      const developerToken = await createAppleDeveloperToken({
        teamId: env.APPLE_TEAM_ID,
        keyId: env.APPLE_KEY_ID,
        privateKeyJwk: applePrivateJwk(env),
        nowMs: issuedAtMs,
        lifetimeSeconds: 900,
        origin,
      });
      return response(requestId, { developerToken, expiresAtMs: issuedAtMs + 900_000 });
    }

    if (request.method === "DELETE" && url.pathname.startsWith("/v1/connections/")) {
      const providerPath = url.pathname.slice("/v1/connections/".length);
      const provider = providerPath === "apple-music" ? "apple_music" : providerValue(providerPath);
      const body = await readObject(request);
      const accountId = requiredString(body, "accountId");
      const connectionId = requiredString(body, "connectionId");
      // Privacy cleanup must remain available after a provider kill switch or
      // pilot removal. Authority still comes from the service-bound web Worker.
      await store.purgeProviderData(accountId, connectionId, provider, now());
      return response(requestId, { provider, disconnected: true });
    }

    if (request.method === "POST" && url.pathname === "/v1/accounts/purge") {
      const body = await readObject(request);
      const accountId = requiredString(body, "accountId");
      // Account deletion must purge provider-private data even for a host who
      // was removed from (or never entered) the pilot allowlist. This route is
      // service-bound and receives only the web Worker's server-derived ID.
      await store.purgeAccountData(accountId, now());
      return response(requestId, { accountId, purged: true });
    }

    if (request.method === "POST" && url.pathname === "/v1/connections/status") {
      const body = await readObject(request);
      const provider = providerValue(body.provider);
      const accountId = requiredString(body, "accountId");
      const connectionId = requiredString(body, "connectionId");
      // Status and privacy cleanup remain available after pilot removal or a
      // kill switch so a host can still see and delete their own connection.
      const pilotAllowed = isAllowlisted(env, accountId, provider);
      const connection = await store.getConnection(accountId, connectionId, provider);
      return response(requestId, {
        provider,
        connectionId,
        connected: Boolean(connection),
        enabled: pilotAllowed && providerEnabled(env, provider),
        publishingEnabled: pilotAllowed && providerEnabled(env, provider, true),
        storefront: connection?.storefront ?? null,
      });
    }

    if (request.method === "POST" && url.pathname === "/v1/catalog/query") {
      const body = await readObject(request);
      const provider = providerValue(body.provider);
      requireProviderEnabled(env, provider);
      const accountId = requiredString(body, "accountId");
      const connectionId = requiredString(body, "connectionId");
      allowlisted(env, accountId, provider);
      const adapter = await catalogAdapterFor({ env, store, provider, accountId, connectionId, fetcher: dependencies.fetcher, now });
      const context = { requestId, provider, credentialRef: connectionId, storefront: "US" as const };
      const mode = requiredString(body, "mode");
      if (mode === "recording_id") {
        return response(requestId, await adapter.getRecording(context, requiredString(body, "providerRecordingId")));
      }
      if (mode === "isrc") return response(requestId, await adapter.lookupIsrc(context, requiredString(body, "isrc")));
      if (mode === "search") {
        const query = body.query;
        if (!isRecord(query) || !stringValue(query.title) || !Array.isArray(query.artists)) {
          throw new HttpError(400, "INVALID_BODY", "A structured catalog query is required");
        }
        const catalogQuery: ProviderCatalogQuery = {
          title: String(query.title),
          artists: query.artists.filter((artist): artist is string => typeof artist === "string"),
          ...(stringValue(query.album) ? { album: String(query.album) } : {}),
          limit: typeof query.limit === "number" ? query.limit : 10,
        };
        return response(requestId, await adapter.search(context, catalogQuery));
      }
      throw new HttpError(400, "INVALID_MODE", "Unknown catalog query mode");
    }

    if (request.method === "POST" && url.pathname === "/v1/catalog/source") {
      const body = await readObject(request);
      const provider = providerValue(body.provider);
      const accountId = requiredString(body, "accountId");
      const providerRecordingId = requiredString(body, "providerRecordingId");
      allowlistedForAnyProvider(env, accountId);
      if (provider === "spotify") {
        return response(requestId, await spotifyOEmbedMetadata(providerRecordingId, { fetcher: dependencies.fetcher, now }));
      }
      requireProviderEnabled(env, "apple_music");
      const developerToken = await createAppleDeveloperToken({
        teamId: env.APPLE_TEAM_ID,
        keyId: env.APPLE_KEY_ID,
        privateKeyJwk: applePrivateJwk(env),
        nowMs: now(),
      });
      const adapter = new AppleMusicAdapter({ developerToken, fetcher: dependencies.fetcher, now });
      return response(requestId, await adapter.getRecording(
        { requestId, provider: "apple_music", credentialRef: "catalog-only", storefront: "US" },
        providerRecordingId,
      ));
    }

    if (request.method === "POST" && url.pathname === "/v1/publish/preview") {
      const body = await readObject(request);
      const provider = providerValue(body.provider);
      requireProviderEnabled(env, provider, true);
      const accountId = requiredString(body, "accountId");
      const connectionId = requiredString(body, "connectionId");
      allowlisted(env, accountId, provider);
      const connection = await store.getConnection(accountId, connectionId, provider);
      if (!connection) {
        throw new HttpError(409, "PROVIDER_NOT_CONNECTED", "Connect this provider first");
      }
      if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 500) {
        throw new HttpError(400, "INVALID_BODY", "Publish preview requires 1-500 items");
      }
      const items = body.items.map((item, index) => {
        if (!isRecord(item)) throw new HttpError(400, "INVALID_BODY", `items[${index}] is invalid`);
        return {
          canonicalRecordingId: requiredString(item, "canonicalRecordingId"),
          providerRecordingId: requiredString(item, "providerRecordingId"),
        };
      });
      const preview = createPublishPreview({
        roomId: requiredString(body, "roomId"),
        roomRevision: requiredInteger(body, "roomRevision"),
        ownerAccountId: accountId,
        provider,
        playlistName: requiredString(body, "playlistName"),
        ...(stringValue(body.playlistDescription) ? { playlistDescription: String(body.playlistDescription) } : {}),
        items,
        createdAtMs: now(),
      });
      const prior = await store.getPublishPreview(accountId, preview.previewId, now());
      if (prior && prior.preview.payloadFingerprint !== preview.payloadFingerprint) {
        throw new HttpError(409, "PREVIEW_ID_CONFLICT", "A different preview already exists for this room revision");
      }
      await store.savePublishPreview({ preview, connectionId, expiresAtMs: now() + 15 * 60_000 });
      return response(requestId, preview, 201);
    }

    if (request.method === "POST" && url.pathname === "/v1/publish/confirm") {
      const body = await readObject(request);
      const accountId = requiredString(body, "accountId");
      const previewId = requiredString(body, "previewId");
      const stored = await store.getPublishPreview(accountId, previewId, now());
      if (!stored) throw new HttpError(404, "PREVIEW_NOT_FOUND", "Publish preview expired or was already confirmed");
      allowlisted(env, accountId, stored.preview.provider);
      requireProviderEnabled(env, stored.preview.provider, true);
      const operation = confirmPublishPreview(stored.preview, {
        previewId,
        payloadFingerprint: requiredString(body, "payloadFingerprint"),
        confirmedByAccountId: accountId,
        confirmedAtMs: requiredInteger(body, "confirmedAtMs"),
      });
      const existing = await store.getPublishJob(operation.operationId);
      if (existing && existing.state.operation.preview.payloadFingerprint !== stored.preview.payloadFingerprint) {
        throw new HttpError(409, "OPERATION_ID_CONFLICT", "A different publish operation already exists");
      }
      if (!existing) {
        const connectionGeneration = await store.getConnectionGeneration(
          accountId,
          stored.connectionId,
          stored.preview.provider,
        );
        if (connectionGeneration === null) {
          throw new HttpError(409, "PROVIDER_NOT_CONNECTED", "Connect this provider first");
        }
        const inserted = await store.savePublishJob({
          operationId: operation.operationId,
          accountId,
          connectionId: stored.connectionId,
          provider: stored.preview.provider,
          connectionGeneration,
          revision: 0,
          state: createDestinationPublishState(operation),
          updatedAtMs: now(),
        });
        if (!inserted) throw new HttpError(409, "OPERATION_CHANGED", "Publish operation changed before it could be confirmed");
      }
      if (!env.PUBLISH_QUEUE) throw new HttpError(503, "QUEUE_UNAVAILABLE", "Publishing queue is unavailable");
      if (!existing || !["succeeded", "cancelled"].includes(existing.state.phase)) {
        await env.PUBLISH_QUEUE.send({ version: 1, type: "publish_destination", operationId: operation.operationId });
      }
      await store.deletePublishPreview(accountId, previewId);
      return response(requestId, { operationId: operation.operationId, provider: stored.preview.provider, status: existing?.state.phase ?? "confirmed" }, 202);
    }

    if (request.method === "POST" && url.pathname === "/v1/publish/operation") {
      const body = await readObject(request);
      const accountId = requiredString(body, "accountId");
      const job = await store.getPublishJob(requiredString(body, "operationId"));
      if (!job || job.accountId !== accountId) throw new HttpError(404, "OPERATION_NOT_FOUND", "Publish operation was not found");
      allowlisted(env, accountId, job.provider);
      return response(requestId, {
        operationId: job.operationId,
        provider: job.provider,
        destinationPlaylistId: job.destinationPlaylistId ?? null,
        destinationUrl: job.destinationUrl ?? null,
        state: job.state,
        recoveryRequired: job.recoveryRequired ?? null,
        updatedAtMs: job.updatedAtMs,
      });
    }

    if (request.method === "POST" && url.pathname === "/v1/operator/publish/recover-playlist") {
      if (!(await authenticatedHeader(request, "X-UniJam-Operator-Authorization", env.CONNECTOR_OPERATOR_SECRET))) {
        throw new HttpError(403, "OPERATOR_UNAUTHORIZED", "Operator authorization failed");
      }
      if (!env.PUBLISH_QUEUE) throw new HttpError(503, "QUEUE_UNAVAILABLE", "Publishing queue is unavailable");
      const body = await readObject(request);
      const operationId = requiredString(body, "operationId");
      const expectedMarker = requiredString(body, "expectedRecoveryMarker");
      const destinationPlaylistId = requiredString(body, "destinationPlaylistId");
      const operatorCredential = bearerValue(request, "X-UniJam-Operator-Authorization");
      const resolvedBy = `operator-credential:${(await sha256Base64Url(operatorCredential)).slice(0, 20)}`;
      const job = await store.getPublishJob(operationId);
      if (!job) throw new HttpError(404, "OPERATION_NOT_FOUND", "Publish operation was not found");
      requireProviderEnabled(env, job.provider, true);

      if (!job.recoveryRequired) {
        if (
          job.destinationPlaylistId === destinationPlaylistId &&
          job.recoveryResolution?.marker === expectedMarker
        ) {
          await env.PUBLISH_QUEUE.send({ version: 1, type: "reconcile_destination", operationId });
          return response(requestId, { operationId, status: "already_recovered" }, 202);
        }
        throw new HttpError(409, "RECOVERY_NOT_REQUIRED", "This operation is not awaiting playlist recovery");
      }
      if (job.recoveryRequired.marker !== expectedMarker) {
        throw new HttpError(409, "RECOVERY_MARKER_CONFLICT", "The recovery marker does not match the current operation");
      }

      const adapter = dependencies.recoveryAdapter ?? await adapterFor({
        env,
        store,
        provider: job.provider,
        accountId: job.accountId,
        connectionId: job.connectionId,
        fetcher: dependencies.fetcher,
        now,
      });
      const snapshot = await adapter.readPlaylist(
        { requestId, provider: job.provider, credentialRef: job.connectionId, storefront: "US" },
        destinationPlaylistId,
      );
      if (snapshot.rawItemCount !== 0) {
        throw new HttpError(409, "RECOVERY_PLAYLIST_NOT_EMPTY", "Recovered playlist must be verifiably empty before UniJam resumes publishing");
      }
      if (
        snapshot.recoveryMarker !== expectedMarker ||
        snapshot.name !== job.state.operation.preview.destination.name ||
        snapshot.isPrivate !== true ||
        snapshot.ownershipVerified !== true
      ) {
        throw new HttpError(409, "RECOVERY_PLAYLIST_MISMATCH", "Recovered playlist metadata does not match this private UniJam destination");
      }

      const result = await store.recoverPublishPlaylist({
        operationId,
        expectedMarker,
        destinationPlaylistId,
        ...(snapshot.destinationUrl ? { destinationUrl: snapshot.destinationUrl } : {}),
        destinationPlaylistHash: await sha256Base64Url(destinationPlaylistId),
        resolvedBy,
        resolvedAtMs: now(),
      });
      if (result.kind === "missing") throw new HttpError(404, "OPERATION_NOT_FOUND", "Publish operation was not found");
      if (result.kind === "revoked") throw new HttpError(409, "CONNECTION_REVOKED", "The provider connection was disconnected");
      if (result.kind === "conflict") throw new HttpError(409, "RECOVERY_CONFLICT", "The operation changed while recovery was verified");
      await env.PUBLISH_QUEUE.send({ version: 1, type: "reconcile_destination", operationId });
      return response(requestId, { operationId, status: result.kind }, 202);
    }

    if (request.method === "POST" && url.pathname === "/v1/publish/retry") {
      const body = await readObject(request);
      const accountId = requiredString(body, "accountId");
      const job = await store.getPublishJob(requiredString(body, "operationId"));
      if (!job || job.accountId !== accountId) throw new HttpError(404, "OPERATION_NOT_FOUND", "Publish operation was not found");
      allowlisted(env, accountId, job.provider);
      requireProviderEnabled(env, job.provider, true);
      if (job.recoveryRequired) {
        throw new HttpError(409, "OPERATOR_RECOVERY_REQUIRED", "Playlist creation outcome requires operator recovery");
      }
      const state = requestPublishRetry(job.state, now());
      if (!(await store.savePublishJob({ ...job, state, updatedAtMs: now() }))) {
        throw new HttpError(409, "OPERATION_CHANGED", "Publish operation changed before the retry was accepted");
      }
      if (!env.PUBLISH_QUEUE) throw new HttpError(503, "QUEUE_UNAVAILABLE", "Publishing queue is unavailable");
      await env.PUBLISH_QUEUE.send({ version: 1, type: state.phase === "reconcile_before_retry" ? "reconcile_destination" : "publish_destination", operationId: job.operationId });
      return response(requestId, { operationId: job.operationId, status: state.phase }, 202);
    }

    if (request.method === "POST" && url.pathname === "/v1/publish/cancel") {
      const body = await readObject(request);
      const accountId = requiredString(body, "accountId");
      const job = await store.getPublishJob(requiredString(body, "operationId"));
      if (!job || job.accountId !== accountId) throw new HttpError(404, "OPERATION_NOT_FOUND", "Publish operation was not found");
      allowlisted(env, accountId, job.provider);
      const state = cancelPublishOperation(job.state);
      if (!(await store.savePublishJob({ ...job, state, updatedAtMs: now() }))) {
        throw new HttpError(409, "OPERATION_IN_FLIGHT", "This destination changed or has an active provider mutation; refresh before cancelling");
      }
      return response(requestId, { operationId: job.operationId, status: state.phase });
    }

    return errorResponse(requestId, 404, "NOT_FOUND", "Connector route not found");
  } catch (error) {
    if (error instanceof HttpError) return errorResponse(requestId, error.status, error.code, error.message);
    if (error instanceof ConnectorProviderError) {
      const { failure } = error;
      const status = failure.kind === "authorization" ? 409 : failure.kind === "rate_limit" ? 429 : failure.kind === "permanent" ? 422 : 503;
      return errorResponse(requestId, status, `PROVIDER_${failure.kind.toUpperCase()}`, failure.safeMessage, failure.retryAtMs);
    }
    return errorResponse(requestId, 500, "CONNECTOR_ERROR", "The connector could not complete the request");
  }
}

export { adapterFor };
