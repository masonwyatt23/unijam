import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("provider artwork is centralized and official", async () => {
  const product = await read("app/components/product.tsx");
  const allUi = await Promise.all([
    "app/page.tsx", "app/host/page.tsx", "app/join/page.tsx",
    "app/room/[roomId]/page.tsx", "app/room/[roomId]/review/page.tsx",
    "app/connections/page.tsx", "app/room/[roomId]/handoff/apple-music/page.tsx", "app/room/[roomId]/publish/page.tsx",
    "app/room/[roomId]/recap/page.tsx",
  ].map(read));
  assert.match(product, /Full_Logo_Black_RGB\.svg/);
  assert.match(product, /marketing\.services\.apple\/api\/storage\/images/);
  assert.doesNotMatch(allUi.join("\n"), /≋|PlatformMark|\bApple\b(?! Music)/);
});

test("guest room shell cannot render host navigation", async () => {
  const product = await read("app/components/product.tsx");
  const room = await read("app/room/[roomId]/page.tsx");
  assert.match(product, /guest \? <div className="guest-rail-copy"/);
  assert.match(product, /Your session only opens this room/);
  assert.match(room, /actor\.role === "guest" \|\| actor\.role === "viewer"/);
  assert.doesNotMatch(room, /useCurrentHost/);
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

test("a recovery session can enroll an additional passkey without bypassing gates", async () => {
  const host = await read("app/host/page.tsx");
  assert.match(host, /host\.data\.recoveryEnrollmentAvailable/);
  assert.match(host, /startRegistration/);
  assert.match(host, /passkeys\/additional\/options/);
  assert.match(host, /passkeys\/additional\/verify/);
  assert.match(host, /single-use recovery enrollment grant expires after 15 minutes/);
  assert.match(host, /Sensitive provider and destructive actions remain unavailable/);
});

test("MusicKit authorization is isolated to the provider connection route", async () => {
  const connections = await read("app/connections/page.tsx");
  const otherUi = await Promise.all([
    "app/page.tsx", "app/host/page.tsx", "app/room/[roomId]/page.tsx",
    "app/room/[roomId]/publish/page.tsx", "app/room/[roomId]/recap/page.tsx",
  ].map(read));
  assert.match(connections, /js-cdn\.music\.apple\.com\/musickit\/v3\/musickit\.js/);
  assert.match(connections, /apple-music\/developer-token/);
  assert.match(connections, /musicUserToken/);
  assert.doesNotMatch(otherUi.join("\n"), /MusicKit|musicUserToken|musickit\.js/);
});

test("live contributions resolve before staging a canonical suggestion", async () => {
  const room = await read("app/room/[roomId]/page.tsx");
  assert.match(room, /\/resolve/);
  assert.match(room, /status === "hold"/);
  assert.match(room, /status === "no_match"/);
  assert.match(room, /commandId: `cmd_\$\{crypto\.randomUUID\(\)\}`/);
  assert.match(room, /suggestionId: `sug_\$\{crypto\.randomUUID\(\)\}`/);
  assert.match(room, /action: "suggestion\.stage"/);
  assert.match(room, /recordingId: match\.recordingId/);
  assert.doesNotMatch(room, /synthetic recording IDs|Catalog resolution unavailable/);
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
