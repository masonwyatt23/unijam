import { providerJson } from "./http.ts";
import { isRecord, numberValue, stringValue } from "./catalog-shape.ts";
import { randomBase64Url, sha256Base64Url } from "./storage.ts";
import type { ConnectorStore, OAuthAttempt, StoredProviderTokens } from "./types.ts";

export const SPOTIFY_CALLBACK_PATH = "/api/v1/providers/spotify/callback";
const SPOTIFY_SCOPES = ["playlist-modify-private", "playlist-read-private"] as const;

export function exactAppOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.toString() !== `${url.origin}/` ||
    url.protocol !== "https:" ||
    (url.hostname !== "unijam.ashlr.ai" && url.hostname !== "staging.unijam.ashlr.ai")
  ) {
    throw new Error("PUBLIC_APP_ORIGIN must be an exact UniJam HTTPS origin");
  }
  return url.origin;
}

export function spotifyCallbackUrl(origin: string): string {
  return `${exactAppOrigin(origin)}${SPOTIFY_CALLBACK_PATH}`;
}

export async function startSpotifyAuthorization(input: {
  readonly store: ConnectorStore;
  readonly clientId: string;
  readonly appOrigin: string;
  readonly accountId: string;
  readonly connectionId: string;
  readonly nowMs: number;
  readonly random?: (byteLength: number) => string;
}): Promise<{ readonly authorizeUrl: string; readonly expiresAtMs: number }> {
  const random = input.random ?? randomBase64Url;
  const state = random(32);
  const codeVerifier = random(64);
  if (state.length < 32 || codeVerifier.length < 43) throw new Error("OAuth randomness source returned insufficient entropy");
  const codeChallenge = await sha256Base64Url(codeVerifier);
  const expiresAtMs = input.nowMs + 5 * 60_000;
  const connectionGeneration = await input.store.reserveConnection(
    input.accountId,
    input.connectionId,
    "spotify",
    input.nowMs,
  );
  const attempt: OAuthAttempt = {
    stateHash: await sha256Base64Url(state),
    accountId: input.accountId,
    connectionId: input.connectionId,
    connectionGeneration,
    codeVerifier,
    expiresAtMs,
  };
  await input.store.saveOAuthAttempt(attempt);
  const query = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: spotifyCallbackUrl(input.appOrigin),
    scope: SPOTIFY_SCOPES.join(" "),
    code_challenge_method: "S256",
    code_challenge: codeChallenge,
    state,
  });
  return { authorizeUrl: `https://accounts.spotify.com/authorize?${query}`, expiresAtMs };
}

interface SpotifyTokenResponse {
  readonly access_token: string;
  readonly token_type: string;
  readonly expires_in: number;
  readonly refresh_token?: string;
  readonly scope?: string;
}

function tokenResponse(value: unknown): value is SpotifyTokenResponse {
  return isRecord(value) &&
    Boolean(stringValue(value.access_token)) &&
    stringValue(value.token_type)?.toLowerCase() === "bearer" &&
    Boolean(numberValue(value.expires_in) && Number(value.expires_in) > 0) &&
    (value.refresh_token === undefined || typeof value.refresh_token === "string") &&
    (value.scope === undefined || typeof value.scope === "string");
}

async function requestSpotifyTokens(input: {
  readonly clientId: string;
  readonly body: URLSearchParams;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
}): Promise<SpotifyTokenResponse> {
  return providerJson(
    "https://accounts.spotify.com/api/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ ...Object.fromEntries(input.body), client_id: input.clientId }),
    },
    { provider: "spotify", fetcher: input.fetcher, now: input.now },
    tokenResponse,
  );
}

function normalizedTokens(
  response: SpotifyTokenResponse,
  nowMs: number,
  priorRefreshToken?: string,
): StoredProviderTokens {
  return {
    accessToken: response.access_token,
    ...(response.refresh_token || priorRefreshToken ? { refreshToken: response.refresh_token ?? priorRefreshToken } : {}),
    expiresAtMs: nowMs + response.expires_in * 1_000,
    scopes: Object.freeze((response.scope ?? "").split(/\s+/).filter(Boolean)),
  };
}

export async function exchangeSpotifyAuthorizationCode(input: {
  readonly clientId: string;
  readonly appOrigin: string;
  readonly code: string;
  readonly codeVerifier: string;
  readonly nowMs: number;
  readonly fetcher?: typeof fetch;
}): Promise<StoredProviderTokens> {
  const response = await requestSpotifyTokens({
    clientId: input.clientId,
    fetcher: input.fetcher,
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: spotifyCallbackUrl(input.appOrigin),
      code_verifier: input.codeVerifier,
    }),
  });
  const tokens = normalizedTokens(response, input.nowMs);
  for (const scope of SPOTIFY_SCOPES) {
    if (!tokens.scopes.includes(scope)) throw new Error(`Spotify grant is missing required scope: ${scope}`);
  }
  return tokens;
}

export async function refreshSpotifyTokens(input: {
  readonly clientId: string;
  readonly refreshToken: string;
  readonly nowMs: number;
  readonly fetcher?: typeof fetch;
}): Promise<StoredProviderTokens> {
  const response = await requestSpotifyTokens({
    clientId: input.clientId,
    fetcher: input.fetcher,
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: input.refreshToken }),
  });
  return normalizedTokens(response, input.nowMs, input.refreshToken);
}
