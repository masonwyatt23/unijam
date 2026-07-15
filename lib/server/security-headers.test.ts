import assert from "node:assert/strict";
import test from "node:test";
import { isExactSameOriginRequest, isExactSameOriginWebSocket, securityHeaders, withSecurityHeaders } from "./security-headers.ts";

test("production responses deny embedding and constrain MusicKit", () => {
  const headers = securityHeaders("production");
  assert.match(headers["Content-Security-Policy"], /frame-ancestors 'none'/);
  assert.match(headers["Content-Security-Policy"], /form-action 'self'/);
  assert.match(headers["Content-Security-Policy"], /upgrade-insecure-requests/);
  assert.match(headers["Content-Security-Policy"], /js-cdn\.music\.apple\.com/);
  assert.match(headers["Content-Security-Policy"], /wss:\/\/unijam\.ashlr\.ai/);
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.match(headers["Strict-Transport-Security"], /max-age=31536000/);
});

test("unsafe methods and WebSockets require the exact environment origin", () => {
  const origin = "https://unijam.ashlr.ai";
  const allowed = new Request(`${origin}/api/v1/rooms/ROOM1234/commands`, {
    method: "POST", headers: { Origin: origin, "Sec-Fetch-Site": "same-origin" },
  });
  const stagingSibling = new Request(`${origin}/api/v1/rooms/ROOM1234/commands`, {
    method: "POST", headers: { Origin: "https://staging.unijam.ashlr.ai", "Sec-Fetch-Site": "same-site" },
  });
  const socket = new Request(`${origin}/api/v1/rooms/ROOM1234/websocket`, {
    headers: { Upgrade: "websocket", Origin: origin, "Sec-Fetch-Site": "same-origin" },
  });
  assert.equal(isExactSameOriginRequest(allowed, origin), true);
  assert.equal(isExactSameOriginRequest(stagingSibling, origin), false);
  assert.equal(isExactSameOriginWebSocket(socket, origin), true);
  assert.equal(isExactSameOriginWebSocket(new Request(socket.url, { headers: { Upgrade: "websocket", Origin: "https://evil.ashlr.ai", "Sec-Fetch-Site": "same-site" } }), origin), false);
  assert.equal(isExactSameOriginRequest(new Request(`${origin}/api/v1/migration/import`, { method: "POST" }), origin), true);
});

test("security headers preserve an API response body", async () => {
  const response = withSecurityHeaders(Response.json({ ok: true }), "staging");
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.headers.get("X-Frame-Options"), "DENY");
  assert.equal(response.headers.has("Strict-Transport-Security"), false);
});
