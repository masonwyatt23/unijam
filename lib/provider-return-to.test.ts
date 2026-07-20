import assert from "node:assert/strict";
import test from "node:test";

import {
  clearSpotifyReturnCookie,
  providerResultMessage,
  providerResultPath,
  readSpotifyReturnTo,
  safeProviderReturnTo,
  spotifyReturnCookie,
  spotifyReturnCookieName,
} from "./provider-return-to.ts";

const state = "oauth_state_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

test("provider return destinations are exact live-room paths", () => {
  assert.equal(safeProviderReturnTo("/room/ROOM1234"), "/room/ROOM1234");
  for (const unsafe of [
    null,
    "https://evil.example/room/ROOM1234",
    "//evil.example/room/ROOM1234",
    "/room/ROOM1234/publish",
    "/room/ROOM1234?next=https://evil.example",
    "/connections/spotify",
    "/room/a",
  ]) assert.equal(safeProviderReturnTo(unsafe), null);
});

test("Spotify room context is state-bound, HttpOnly, short-lived, and single-use", () => {
  const name = spotifyReturnCookieName(state);
  assert.equal(name, `__Host-unijam_spotify_return_${state}`);
  assert.equal(spotifyReturnCookieName("short"), null);

  const cookie = spotifyReturnCookie(state, "/room/ROOM1234");
  assert.ok(cookie?.startsWith(`${name}=%2Froom%2FROOM1234;`));
  assert.match(cookie ?? "", /Max-Age=300/);
  assert.match(cookie ?? "", /HttpOnly/);
  assert.match(cookie ?? "", /Secure/);
  assert.match(cookie ?? "", /SameSite=Lax/);

  const request = new Request("https://unijam.ashlr.ai/api/v1/providers/spotify/callback", {
    headers: { Cookie: `${name}=%2Froom%2FROOM1234` },
  });
  assert.equal(readSpotifyReturnTo(request, state), "/room/ROOM1234");
  assert.equal(readSpotifyReturnTo(request, `${state}x`), null);
  assert.match(clearSpotifyReturnCookie(state) ?? "", /Max-Age=0/);
});

test("provider results stay on validated internal destinations with actionable copy", () => {
  assert.equal(
    providerResultPath("/room/ROOM1234", "spotify", "connected"),
    "/room/ROOM1234?provider=spotify&providerResult=connected",
  );
  assert.equal(
    providerResultPath("https://evil.example", "spotify", "cancelled"),
    "/connections/spotify?provider=spotify&providerResult=cancelled",
  );
  assert.match(providerResultMessage("apple-music", "failed")?.message ?? "", /No provider credentials were saved/);
  assert.equal(providerResultMessage("spotify", "unknown"), null);
});
