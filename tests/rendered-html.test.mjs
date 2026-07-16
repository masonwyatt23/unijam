import assert from "node:assert/strict";
import test from "node:test";

const developmentPreviewMeta =
  /<meta(?=[^>]*\bname=["']codex-preview["'])(?=[^>]*\bcontent=["']development["'])[^>]*>/i;

test("renders development preview metadata", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  const response = await worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/html\b/i,
  );
  assert.match(await response.text(), developmentPreviewMeta);
});

test("renders the room-first landing experience", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("ui", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(new Request("http://localhost/", { headers: { accept: "text/html" } }), {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  }, { waitUntil() {}, passThroughOnException() {} });
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /One room/);
  assert.match(html, /Every listener/);
  assert.match(html, /Guests join without accounts/);
  assert.doesNotMatch(html, /Song inbox|Enhance|Account plan|≋/);
});

test("staging metadata stays on staging and prevents indexing", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("staging-metadata", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(new Request("https://staging.unijam.ashlr.ai/", {
    headers: { accept: "text/html" },
  }), {
    APP_ENV: "staging",
    APP_ORIGIN: "https://staging.unijam.ashlr.ai",
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  }, { waitUntil() {}, passThroughOnException() {} });
  const html = await response.text();
  assert.match(html, /https:\/\/staging\.unijam\.ashlr\.ai\/favicon\.svg/);
  assert.match(html, /https:\/\/staging\.unijam\.ashlr\.ai\/unijam-social-preview\.png/);
  assert.match(html, /<meta name="robots" content="noindex, nofollow"/);
  assert.doesNotMatch(html, /https:\/\/unijam\.ashlr\.ai\/(?:favicon|unijam-social-preview)/);
  assert.doesNotMatch(html, /codex-preview/);
});

test("production HTML hydrates with a fresh server-selected CSP nonce", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("nonce", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const env = {
    APP_ENV: "production",
    APP_ORIGIN: "https://unijam.ashlr.ai",
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  };
  const context = { waitUntil() {}, passThroughOnException() {} };
  const render = () => worker.fetch(new Request("https://unijam.ashlr.ai/host/sign-in", {
    headers: {
      accept: "text/html",
      "Content-Security-Policy": "script-src 'nonce-attacker'",
      "Content-Security-Policy-Report-Only": "script-src 'nonce-other-attacker'",
      "X-UniJam-App-Environment": "staging",
      "X-UniJam-App-Origin": "https://evil.example",
    },
  }), env, context);

  const first = await render();
  const firstCsp = first.headers.get("content-security-policy") ?? "";
  const firstNonce = firstCsp.match(/'nonce-([a-f0-9]{32})'/)?.[1];
  const firstHtml = await first.text();
  assert.ok(firstNonce);
  assert.doesNotMatch(firstCsp, /nonce-attacker/);
  assert.equal(first.headers.get("cache-control"), "private, no-store");
  assert.match(firstHtml, /https:\/\/unijam\.ashlr\.ai\/favicon\.svg/);
  assert.doesNotMatch(firstHtml, /evil\.example/);
  assert.doesNotMatch(firstHtml, /codex-preview/);
  const scripts = [...firstHtml.matchAll(/<script\b[^>]*>/gi)].map((match) => match[0]);
  assert.ok(scripts.length > 0);
  assert.ok(scripts.every((tag) => tag.includes(`nonce="${firstNonce}"`)));

  const second = await render();
  const secondNonce = (second.headers.get("content-security-policy") ?? "").match(/'nonce-([a-f0-9]{32})'/)?.[1];
  assert.ok(secondNonce);
  assert.notEqual(firstNonce, secondNonce);
  await second.body?.cancel();
});

test("headerless page navigation still receives a hydration nonce", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("headerless-nonce", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(new Request("https://staging.unijam.ashlr.ai/host/sign-in"), {
    APP_ENV: "staging",
    APP_ORIGIN: "https://staging.unijam.ashlr.ai",
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  }, { waitUntil() {}, passThroughOnException() {} });
  const csp = response.headers.get("content-security-policy") ?? "";
  const nonce = csp.match(/'nonce-([a-f0-9]{32})'/)?.[1];
  const html = await response.text();
  const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map((match) => match[0]);
  assert.ok(nonce);
  assert.ok(scripts.length > 0);
  assert.ok(scripts.every((tag) => tag.includes(`nonce="${nonce}"`)));
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});
