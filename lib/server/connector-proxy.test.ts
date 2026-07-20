import assert from "node:assert/strict";
import test from "node:test";
import { connectorJsonRequest, type ConnectorProxyEnv } from "./connector-proxy.ts";

test("web to connector binding uses bearer service auth and JSON contract", async () => {
  let captured: Request | null = null;
  const env = {
    CONNECTOR_SERVICE_TOKEN: "shared-service-secret",
    CONNECTORS: { fetch(request: Request) { captured = request; return Promise.resolve(Response.json({ data: { ok: true }, error: null, requestId: "request" })); } },
  } as unknown as ConnectorProxyEnv;
  const response = await connectorJsonRequest(env, "/v1/connections/status", { accountId: "server-derived", provider: "spotify" });
  assert.equal(response.ok, true);
  assert.ok(captured);
  const sent = captured as Request;
  assert.equal(new URL(sent.url).pathname, "/v1/connections/status");
  assert.equal(sent.headers.get("Authorization"), "Bearer shared-service-secret");
  assert.equal(sent.headers.get("Content-Type"), "application/json");
  assert.deepEqual(await sent.json(), { accountId: "server-derived", provider: "spotify" });
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("web normalizes connector errors and service failures into safe public envelopes", async () => {
  const rejected = {
    CONNECTOR_SERVICE_TOKEN: "shared-service-secret",
    CONNECTORS: { fetch() { return Promise.reject(new Error("private binding detail")); } },
  } as unknown as ConnectorProxyEnv;
  const unavailable = await connectorJsonRequest(rejected, "/v1/connections/status", { accountId: "server-derived" });
  assert.equal(unavailable.status, 503);
  assert.deepEqual((await unavailable.json() as { error: { code: string; message: string } }).error, {
    code: "CONNECTOR_UNAVAILABLE", message: "Provider service is unavailable", retryable: true,
  });

  const invalid = {
    CONNECTOR_SERVICE_TOKEN: "shared-service-secret",
    CONNECTORS: { fetch() { return Promise.resolve(Response.json({ ok: true })); } },
  } as unknown as ConnectorProxyEnv;
  const malformed = await connectorJsonRequest(invalid, "/v1/connections/status", { accountId: "server-derived" });
  assert.equal(malformed.status, 502);
  assert.equal((await malformed.json() as { error: { code: string } }).error.code, "CONNECTOR_UNAVAILABLE");
});
