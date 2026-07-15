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
});
