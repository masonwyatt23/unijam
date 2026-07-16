import assert from "node:assert/strict";
import test from "node:test";
import {
  createScriptNonce,
  isExactSameOriginRequest,
  isExactSameOriginWebSocket,
  securityHeaders,
  withSecurityHeaders,
  withSecurityRequestHeaders,
} from "./security-headers.ts";

test("script nonces contain 128 bits of server randomness", () => {
  const first = createScriptNonce();
  const second = createScriptNonce();
  assert.match(first, /^[a-f0-9]{32}$/);
  assert.notEqual(first, second);
});

test("production responses deny embedding and constrain executable scripts with a nonce", () => {
  const headers = securityHeaders("production", "test-nonce");
  assert.match(headers["Content-Security-Policy"], /frame-ancestors 'none'/);
  assert.match(headers["Content-Security-Policy"], /form-action 'self'/);
  assert.match(headers["Content-Security-Policy"], /upgrade-insecure-requests/);
  assert.match(headers["Content-Security-Policy"], /js-cdn\.music\.apple\.com/);
  assert.match(headers["Content-Security-Policy"], /static\.cloudflareinsights\.com/);
  assert.match(headers["Content-Security-Policy"], /'nonce-test-nonce'/);
  assert.match(headers["Content-Security-Policy"], /script-src-attr 'none'/);
  assert.doesNotMatch(headers["Content-Security-Policy"], /'unsafe-inline'.*https:\/\/js-cdn\.music\.apple\.com/);
  assert.match(headers["Content-Security-Policy"], /marketing\.services\.apple/);
  assert.match(headers["Content-Security-Policy"], /wss:\/\/unijam\.ashlr\.ai/);
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.match(headers["Strict-Transport-Security"], /max-age=31536000/);
});

test("the same server-selected nonce reaches Vinext's request and the browser response", () => {
  const inbound = new Request("https://unijam.ashlr.ai/", {
    headers: {
      "Content-Security-Policy": "script-src 'nonce-attacker'",
      "Content-Security-Policy-Report-Only": "script-src 'nonce-other-attacker'",
      "X-UniJam-App-Environment": "staging",
      "X-UniJam-App-Origin": "https://evil.example",
    },
  });
  const routed = withSecurityRequestHeaders(
    inbound,
    "production",
    "server-nonce",
    "https://unijam.ashlr.ai",
  );
  const response = withSecurityHeaders(new Response("ok"), "production", "server-nonce");
  assert.match(routed.headers.get("Content-Security-Policy") ?? "", /'nonce-server-nonce'/);
  assert.doesNotMatch(routed.headers.get("Content-Security-Policy") ?? "", /nonce-attacker/);
  assert.equal(routed.headers.has("Content-Security-Policy-Report-Only"), false);
  assert.equal(routed.headers.get("X-UniJam-App-Environment"), "production");
  assert.equal(routed.headers.get("X-UniJam-App-Origin"), "https://unijam.ashlr.ai");
  assert.equal(routed.headers.get("Content-Security-Policy"), response.headers.get("Content-Security-Policy"));
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
