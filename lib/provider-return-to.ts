import { clearSessionCookie, readCookie, sessionCookie } from "./server/session-cookie.ts";

export type ProviderConnection = "spotify" | "apple-music";
export type ProviderConnectionResult = "connected" | "cancelled" | "failed";

const ROOM_DESTINATION = /^\/room\/[A-Za-z0-9]{6,16}$/;
const SPOTIFY_STATE = /^[A-Za-z0-9_-]{32,256}$/;
const SPOTIFY_RETURN_COOKIE_PREFIX = "__Host-unijam_spotify_return_";
const PROVIDER_RETURN_TTL_SECONDS = 5 * 60;

/** Provider authorization may only return to the live room that initiated it. */
export function safeProviderReturnTo(value: string | null | undefined): string | null {
  if (!value) return null;
  const candidate = value.trim();
  return ROOM_DESTINATION.test(candidate) ? candidate : null;
}

/**
 * Binding the cookie name to Spotify's high-entropy OAuth state keeps parallel
 * authorization tabs independent. The callback still validates the state in
 * the connector before persisting any provider credentials.
 */
export function spotifyReturnCookieName(state: string | null | undefined): string | null {
  if (!state || !SPOTIFY_STATE.test(state)) return null;
  return `${SPOTIFY_RETURN_COOKIE_PREFIX}${state}`;
}

export function spotifyReturnCookie(state: string, returnTo: string): string | null {
  const name = spotifyReturnCookieName(state);
  const destination = safeProviderReturnTo(returnTo);
  if (!name || !destination) return null;
  return sessionCookie(name, destination, PROVIDER_RETURN_TTL_SECONDS);
}

export function readSpotifyReturnTo(request: Request, state: string | null | undefined): string | null {
  const name = spotifyReturnCookieName(state);
  return name ? safeProviderReturnTo(readCookie(request, name)) : null;
}

export function clearSpotifyReturnCookie(state: string | null | undefined): string | null {
  const name = spotifyReturnCookieName(state);
  return name ? clearSessionCookie(name) : null;
}

export function providerResultPath(
  returnTo: string | null | undefined,
  provider: ProviderConnection,
  result: ProviderConnectionResult,
): string {
  const destination = safeProviderReturnTo(returnTo) ?? `/connections/${provider}`;
  const query = new URLSearchParams({ provider, providerResult: result });
  return `${destination}?${query}`;
}

export function providerResultMessage(
  provider: ProviderConnection,
  result: string | null | undefined,
): { tone: "success" | "warning"; title: string; message: string } | null {
  const name = provider === "spotify" ? "Spotify" : "Apple Music";
  if (result === "connected") {
    return { tone: "success", title: `${name} connected`, message: `${name} is ready for your own catalog and playlist actions.` };
  }
  if (result === "cancelled") {
    return { tone: "warning", title: `${name} connection cancelled`, message: `Nothing was connected or shared. You can continue using the room.` };
  }
  if (result === "failed") {
    return { tone: "warning", title: `${name} could not connect`, message: `No provider credentials were saved. Try connecting again.` };
  }
  return null;
}
