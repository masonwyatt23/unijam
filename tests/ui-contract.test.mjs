import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("provider artwork is centralized and official", async () => {
  const product = await read("app/components/product.tsx");
  const allUi = await Promise.all([
    "app/page.tsx", "app/host/page.tsx", "app/join/page.tsx",
    "app/room/[roomId]/page.tsx", "app/room/[roomId]/review/page.tsx",
    "app/connections/page.tsx", "app/connections/spotify/page.tsx", "app/connections/apple-music/page.tsx",
    "app/room/[roomId]/handoff/apple-music/page.tsx", "app/room/[roomId]/publish/page.tsx",
    "app/room/[roomId]/recap/page.tsx",
  ].map(read));
  assert.match(product, /Full_Logo_Black_RGB\.svg/);
  assert.match(product, /marketing\.services\.apple\/api\/storage\/images/);
  assert.match(product, /url\.hostname === "open\.spotify\.com"/);
  assert.match(product, /url\.hostname === "music\.apple\.com"/);
  assert.match(product, /if \(href && !isApprovedProviderLink\(props\.provider, href\)\) return null/);
  assert.doesNotMatch(allUi.join("\n"), /≋|PlatformMark|\bApple\b(?! Music)/);
});

test("provider artwork preserves official digital size and clear-space rules", async () => {
  const css = await read("app/globals.css");
  const assets = await read("THIRD_PARTY_ASSETS.md");
  assert.match(css, /\.provider-brand \{[^}]*padding: 14px/);
  assert.match(css, /\.provider-brand img \{ width: 96px/);
  assert.match(css, /\.provider-compact img \{ width: 70px/);
  assert.match(css, /\.provider-isolation \.provider-brand \{ padding: 18px/);
  assert.doesNotMatch(css, /\.resolution-attribution \.provider-brand \{[^}]*padding-inline: 0/);
  assert.match(assets, /Spotify logo exclusion zone/);
  assert.match(assets, /one-tenth of the rendered badge height/);
});

test("vendored Spotify artwork matches the recorded official package", async () => {
  const assets = await read("THIRD_PARTY_ASSETS.md");
  for (const [path, expected] of [
    ["public/brand/spotify/Full_Logo_Black_RGB.svg", "895e187fe85d90228f4972ece378e9e9a8e6fb995ca59f8037ba1f37727bb611"],
    ["public/brand/spotify/Full_Logo_White_RGB.svg", "20ee3e587eb0891cccc595e617620a1943f1554e7291218e9158d3522457a3a9"],
  ]) {
    const digest = createHash("sha256").update(await readFile(new URL(path, root))).digest("hex");
    assert.equal(digest, expected, path);
    assert.match(assets, new RegExp(`${path.replaceAll(".", "\\.")}[^\\n]+${expected}`));
  }
});

test("guest room shell cannot render host navigation", async () => {
  const product = await read("app/components/product.tsx");
  const room = await read("app/room/[roomId]/page.tsx");
  assert.match(product, /guest \? <div className="guest-rail-copy"/);
  assert.match(product, /Your session only opens this room/);
  assert.match(room, /actor\.role === "guest" \|\| actor\.role === "viewer"/);
  assert.match(room, /room\.status === "loading"[^\n]+<ProductShell guest/);
  assert.match(room, /room\.status === "error"[^\n]+<ProductShell guest/);
});

test("guest invite capability is cleared from the URL and retained only for retry", async () => {
  const join = await read("app/join/[roomId]/page.tsx");
  assert.match(join, /capabilityRef = useRef/);
  assert.match(join, /history\.replaceState/);
  assert.match(join, /const capability = capabilityRef\.current/);
  assert.match(join, /capabilityRef\.current = null/);
  assert.doesNotMatch(join, /(?:localStorage|sessionStorage)\.setItem\([^\n]*cap/i);
});

test("pilot enrollment uses a real passkey ceremony and shows recovery codes once", async () => {
  const signIn = await read("app/host/sign-in/page.tsx");
  assert.match(signIn, /startRegistration/);
  assert.match(signIn, /enrollmentCode/);
  assert.match(signIn, /registration\/options/);
  assert.match(signIn, /registration\/verify/);
  assert.match(signIn, /recoveryCodes\.join\("\\n"\)/);
  assert.match(signIn, /These ten single-use codes will not be shown again/);
  assert.doesNotMatch(signIn, /(?:localStorage|sessionStorage).*recovery/i);
});

test("public membership is passkey-first, provider-optional, and isolated from pilot invites", async () => {
  const [signIn, passkeys, publicOptions, publicVerify, pilotVerify, returnTo] = await Promise.all([
    read("app/host/sign-in/page.tsx"),
    read("lib/server/passkeys.ts"),
    read("app/api/v1/auth/passkeys/public-registration/options/route.ts"),
    read("app/api/v1/auth/passkeys/public-registration/verify/route.ts"),
    read("app/api/v1/auth/passkeys/registration/verify/route.ts"),
    read("lib/host-return-to.ts"),
  ]);
  assert.match(signIn, /Create free account/);
  assert.match(signIn, /public-registration\/options/);
  assert.match(signIn, /public-registration\/verify/);
  assert.match(signIn, /without connecting a music service/);
  assert.match(signIn, /I have a pilot invite/);
  assert.match(passkeys, /"public_registration"/);
  assert.match(passkeys, /mode === "pilot" \? "registration" : "public_registration"/);
  assert.match(passkeys, /\[\.\.\.recovery\.statements, session\.statement\]/);
  assert.match(publicOptions, /public-registration-options:ip/);
  assert.match(publicOptions, /readBoundedJson/);
  assert.match(publicVerify, /public-registration-verify:account/);
  assert.match(publicVerify, /finishBootstrapRegistration/);
  assert.match(publicVerify, /"public"/);
  assert.match(pilotVerify, /"pilot"/);
  assert.match(returnTo, /HOST_DESTINATION\.test/);
  assert.doesNotMatch(`${publicOptions}\n${publicVerify}`, /enrollmentCode|provider_connections|SPOTIFY|APPLE_MUSIC/);
});

test("a recovery session can enroll an additional passkey without bypassing gates", async () => {
  const host = await read("app/host/page.tsx");
  assert.match(host, /host\.data\.recoveryEnrollmentAvailable/);
  assert.match(host, /startRegistration/);
  assert.match(host, /passkeys\/additional\/options/);
  assert.match(host, /passkeys\/additional\/verify/);
  assert.match(host, /single-use recovery enrollment grant expires after 15 minutes/);
  assert.match(host, /Sensitive provider and destructive actions remain unavailable/);
  assert.match(host, /Add another passkey/);
  assert.match(host, /Cofounders should use separate pilot invites and accounts/);
});

test("MusicKit authorization is isolated to the provider connection route", async () => {
  const connections = await read("app/connections/apple-music/page.tsx");
  const otherUi = await Promise.all([
    "app/page.tsx", "app/host/page.tsx", "app/room/[roomId]/page.tsx",
    "app/connections/page.tsx", "app/connections/spotify/page.tsx",
    "app/room/[roomId]/publish/page.tsx", "app/room/[roomId]/recap/page.tsx",
  ].map(read));
  assert.match(connections, /js-cdn\.music\.apple\.com\/musickit\/v3\/musickit\.js/);
  assert.match(connections, /apple-music\/developer-token/);
  assert.match(connections, /musicUserToken/);
  assert.doesNotMatch(otherUi.join("\n"), /window\.MusicKit|loadMusicKit|musicUserToken|musickit\.js/);
});

test("provider connection routes isolate official marks and authorization code", async () => {
  const [hub, spotify, apple] = await Promise.all([
    read("app/connections/page.tsx"),
    read("app/connections/spotify/page.tsx"),
    read("app/connections/apple-music/page.tsx"),
  ]);
  assert.doesNotMatch(hub, /ProviderBrand|Full_Logo|marketing\.services\.apple/);
  assert.match(spotify, /ProviderBrand provider="spotify"/);
  assert.doesNotMatch(spotify, /Apple Music|MusicKit|musicUserToken/);
  assert.match(apple, /Official Apple Music badges remain reserved for links to licensed content/);
  assert.doesNotMatch(apple, /ProviderBrand|Full_Logo/);
});

test("Spotify connect consumes the connector PKCE authorization URL contract", async () => {
  const [connectRoute, callbackRoute, connectorOAuth, providerReturn] = await Promise.all([
    read("app/api/v1/providers/[provider]/connect/route.ts"),
    read("app/api/v1/providers/[provider]/callback/route.ts"),
    read("connectors/oauth.ts"),
    read("lib/provider-return-to.ts"),
  ]);
  assert.match(connectorOAuth, /return \{ authorizeUrl:/);
  assert.match(connectRoute, /data\?: \{ authorizeUrl\?: string \}/);
  assert.match(connectRoute, /spotifyReturnCookie/);
  assert.match(connectRoute, /new Response\(null, \{ status: 303, headers \}\)/);
  assert.match(callbackRoute, /providerError === "access_denied" \? "cancelled" : "failed"/);
  assert.match(callbackRoute, /clearSpotifyReturnCookie/);
  assert.match(providerReturn, /ROOM_DESTINATION/);
  assert.match(providerReturn, /HttpOnly|sessionCookie/);
  assert.doesNotMatch(connectRoute, /authorizationUrl/);
});

test("live contributions resolve before staging a canonical suggestion", async () => {
  const [room, resolver] = await Promise.all([
    read("app/room/[roomId]/page.tsx"),
    read("app/api/v1/rooms/[roomId]/resolve/route.ts"),
  ]);
  assert.match(room, /\/resolve/);
  assert.match(room, /status === "hold"/);
  assert.match(room, /status === "no_match"/);
  assert.match(room, /commandId: `cmd_\$\{crypto\.randomUUID\(\)\}`/);
  assert.match(room, /suggestionId: `sug_\$\{crypto\.randomUUID\(\)\}`/);
  assert.match(room, /action: "suggestion\.stage"/);
  assert.match(room, /resolutionId: match\.resolutionId/);
  assert.match(room, /Choose this version/);
  assert.match(room, /source_metadata_incomplete/);
  assert.match(room, /listening-preference/);
  assert.match(room, /localStorage\.setItem\("unijam\.listening-preference"/);
  assert.match(room, /Sign in or create an account/);
  assert.match(room, /LISTENER_CONNECTION_REQUIRED/);
  assert.match(room, /PROVIDER_NOT_CONNECTED/);
  assert.match(room, /Switch to Apple Music/);
  assert.match(room, /account\.error\?\.code === "UNAUTHENTICATED"/);
  assert.doesNotMatch(room, /offerMembership=\{guest && account\.status === "error"\}/);
  assert.match(resolver, /catalogPrincipalForRoom/);
  assert.doesNotMatch(resolver, /const accountId = access\.registry\.owner_account_id/);
  assert.doesNotMatch(room, /metadata score/);
  assert.match(resolver, /mandatorySelection = true/);
  assert.match(resolver, /spotify_oembed_title/);
  assert.match(resolver, /explicit_user_selection_required/);
  assert.match(resolver, /selectedProviderRecordingId/);
  assert.match(resolver, /INVALID_MATCH_SELECTION/);
  assert.match(resolver, /participant_selected/);
  assert.match(room, /selection: candidate\.candidate\.providerRecordingId/);
  assert.doesNotMatch(resolver, /embedding|analytics|machine learning|\bML\b/);
  assert.doesNotMatch(room, /payload: \{ suggestionId:[^\n]+recordingId:/);
  assert.doesNotMatch(room, /synthetic recording IDs|Catalog resolution unavailable/);
});

test("mixed-provider handoff and publishing safely backfill every missing destination edge", async () => {
  const [handoff, preview, publishPage, backfill] = await Promise.all([
    read("app/api/v1/rooms/[roomId]/handoff/[provider]/route.ts"),
    read("app/api/v1/rooms/[roomId]/publish-preview/route.ts"),
    read("app/room/[roomId]/publish/page.tsx"),
    read("lib/server/provider-match.ts"),
  ]);
  assert.match(handoff, /catalogPrincipalForRoom/);
  assert.match(handoff, /backfillProviderMatch/);
  assert.match(handoff, /LISTENER_CONNECTION_REQUIRED/);
  assert.match(preview, /loadProviderMatches/);
  assert.match(preview, /backfillPreviewProviderMatches/);
  assert.match(preview, /MATCH_BACKFILL_IN_PROGRESS/);
  assert.match(publishPage, /MAX_PREVIEW_BACKFILL_REQUESTS = 4/);
  assert.match(publishPage, /failure\.code !== "MATCH_BACKFILL_IN_PROGRESS"/);
  assert.match(preview, /PUBLISH_ITEM_LIMIT_EXCEEDED/);
  assert.ok(preview.indexOf("const limitMessage = publishPreviewLimitMessage") < preview.indexOf("const existing = await loadProviderMatches"));
  assert.match(publishPage, /Setlist is too large to publish/);
  assert.match(publishPage, /publishable\.length > MAX_PUBLISH_PREVIEW_ITEMS/);
  assert.match(preview, /backfillProviderMatch/);
  assert.match(preview, /providerValue === "apple_music" \? \{ kind: "public" \}/);
  assert.match(preview, /\{ kind: "account", accountId: host\.account_id \}/);
  assert.match(backfill, /!canonical\.isrc/);
  assert.match(backfill, /resolution\.match\.evidence\.includes\("isrc"\)/);
  assert.match(backfill, /reason: "ambiguous_match"/);
});

test("guest entry is name-only and account continuity stays optional", async () => {
  const join = await read("app/join/[roomId]/page.tsx");
  assert.match(join, /fetch\("\/api\/v1\/auth\/me"/);
  assert.match(join, /body\.data\?\.displayName/);
  assert.match(join, /You do not need an account or a music-service login/);
  assert.doesNotMatch(join, /Music service preference|What do you listen with/);
});

test("host setlist controls require confirmation before advance and target occurrence IDs", async () => {
  const product = await read("app/components/product.tsx");
  assert.match(product, /"queue\.advance", \{ occurrenceId: now\.occurrenceId \}/);
  assert.match(product, /"queue\.skip", \{ occurrenceId: now\.occurrenceId \}/);
  assert.match(product, /disabled=\{!now\.playbackConfirmedAtMs \|\| pendingId === now\.occurrenceId\}/);
  assert.match(product, /moved to Played/);
  assert.match(product, /was skipped/);
});

test("live product surfaces contain no demo identity or queue fixtures", async () => {
  const liveUi = await Promise.all([
    "app/components/product.tsx",
    "app/host/page.tsx",
    "app/room/[roomId]/page.tsx",
    "app/room/[roomId]/review/page.tsx",
    "app/room/[roomId]/publish/page.tsx",
    "app/room/[roomId]/recap/page.tsx",
  ].map(read));
  assert.doesNotMatch(
    liveUi.join("\n"),
    /demoRoomId|initialQueue|Friday Night|\bMason\b|\bMW\b|friday-night/,
  );
});

test("accessibility and constrained viewport policies are present", async () => {
  const css = await read("app/globals.css");
  assert.match(css, /min-width: 320px/);
  assert.match(css, /min-height: 44px/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /forced-colors: active/);
  assert.match(css, /outline: 3px solid var\(--cue\)/);
});

test("all planned product routes exist", async () => {
  const routes = [
    "app/host/page.tsx", "app/host/sign-in/page.tsx", "app/rooms/new/page.tsx", "app/join/page.tsx",
    "app/join/[roomId]/page.tsx",
    "app/room/[roomId]/page.tsx", "app/room/[roomId]/review/page.tsx",
    "app/connections/page.tsx", "app/room/[roomId]/publish/page.tsx",
    "app/room/[roomId]/recap/page.tsx",
  ];
  for (const route of routes) assert.ok((await read(route)).length > 100, route);
});

test("pilot UI exposes real room, invite, handoff, and publishing operations", async () => {
  const [host, room, publish, handoff] = await Promise.all([
    read("app/host/page.tsx"),
    read("app/room/[roomId]/page.tsx"),
    read("app/room/[roomId]/publish/page.tsx"),
    read("app/room/[roomId]/handoff/provider-handoff-page.tsx"),
  ]);
  assert.match(host, /fetch\("\/api\/v1\/rooms"/);
  assert.match(host, /fetch\("\/api\/v1\/rooms\/joined"/);
  assert.match(host, /use the current invite to rejoin/);
  assert.doesNotMatch(host, /No room list yet|does not expose a host room index/);
  assert.match(room, /invite\/rotate/);
  assert.doesNotMatch(room, /Invite unavailable/);
  assert.match(handoff, /handoff\.request/);
  assert.match(handoff, /handoff\.open/);
  assert.match(handoff, /handoff\.confirm/);
  assert.match(publish, /publish-preview/);
  assert.match(publish, /publish-confirmation/);
  assert.match(publish, /action: "retry" \| "cancel"/);
  assert.match(publish, /operations\/\$\{encodeURIComponent\(operationId\)\}\/\$\{action\}/);
  assert.doesNotMatch(publish, /Publishing API not deployed|Publishing unavailable/);
});

test("account logout also clears linked room authority", async () => {
  const [shell, logout, helper] = await Promise.all([
    read("app/components/product.tsx"),
    read("app/api/v1/auth/logout/route.ts"),
    read("lib/server/logout-sessions.ts"),
  ]);
  assert.match(shell, /Sign out/);
  assert.match(shell, /\/api\/v1\/auth\/logout/);
  assert.match(logout, /GUEST_SESSION_COOKIE/);
  assert.match(logout, /revokeLinkedGuestSession/);
  assert.match(helper, /account_id = \?/);
});

test("room controls are retryable across the DO-to-D1 projection boundary", async () => {
  const [end, rotate, state, authority] = await Promise.all([
    read("app/api/v1/rooms/[roomId]/end/route.ts"),
    read("app/api/v1/rooms/[roomId]/invite/rotate/route.ts"),
    read("app/api/v1/rooms/[roomId]/state/route.ts"),
    read("lib/server/room-authority.ts"),
  ]);
  assert.match(end, /commandId: `end_\$\{roomId\}_v1`/);
  assert.match(end, /event\.type === "room\.ended"/);
  assert.match(end, /ended_at_ms = COALESCE\(ended_at_ms, \?\)/);
  assert.match(rotate, /commandId: `rotate_\$\{roomId\}_\$\{nextEpoch\}`/);
  assert.match(authority, /allowEndedOwner\?: boolean/);
  assert.match(state, /allowEndedOwner: true/);
  assert.doesNotMatch(await read("app/api/v1/rooms/[roomId]/handoff/[provider]/route.ts"), /allowEndedOwner/);
  assert.doesNotMatch(await read("app/api/v1/rooms/[roomId]/resolve/route.ts"), /allowEndedOwner/);
});

test("room state preserves event cursors and finalized snapshots do not open sockets", async () => {
  const [state, product] = await Promise.all([
    read("app/api/v1/rooms/[roomId]/state/route.ts"),
    read("app/components/product.tsx"),
  ]);
  assert.match(state, /authorityUrl\.search = new URL\(request\.url\)\.search/);
  assert.match(product, /const isLive = snapshot\?\.lifecycle === "active"/);
  assert.match(product, /if \(!isLive \|\| typeof window === "undefined"\) return/);
  assert.match(product, /event\.code === 1008\) refresh\(\)/);
  assert.match(product, /setTransport\("connected"\)/);
  assert.match(product, /setTransport\("offline"\)/);
});

test("guest join exposes only stable, honest recovery distinctions", async () => {
  const [joinPage, joinRoute, authority] = await Promise.all([
    read("app/join/[roomId]/page.tsx"),
    read("app/api/v1/rooms/[roomId]/join/route.ts"),
    read("lib/server/room-authority.ts"),
  ]);
  assert.match(joinPage, /INVITE_INVALID_OR_ROTATED: "invalid-or-rotated"/);
  assert.match(joinPage, /ROOM_ENDED: "ended"/);
  assert.match(joinPage, /ROOM_LOCKED: "locked"/);
  assert.match(joinPage, /JOIN_RATE_LIMITED: "rate-limited"/);
  assert.match(joinRoute, /cause instanceof GuestCapabilityError/);
  assert.match(authority, /INVITE_INVALID_OR_ROTATED/);
  assert.doesNotMatch(authority, /INVITE_EXPIRED/);
});
