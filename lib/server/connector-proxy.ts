import { apiError, apiResponse } from "./api-response.ts";
import { authenticateHost, isRecentPasskey, type HostSession } from "./host-session.ts";

export type ConnectorProxyEnv = Cloudflare.Env & {
  DB: D1Database;
  CONNECTORS: Fetcher;
  CONNECTOR_SERVICE_TOKEN?: string;
};

export function normalizeProvider(value: string): "spotify" | "apple-music" {
  if (value !== "spotify" && value !== "apple-music") throw new Error("Provider is unsupported");
  return value;
}

export function publicAppOrigin(env: Pick<Cloudflare.Env, "APP_ENV">): string {
  return env.APP_ENV === "staging" ? "https://staging.unijam.ashlr.ai" : "https://unijam.ashlr.ai";
}

export async function requireConnectorHost(
  env: ConnectorProxyEnv,
  request: Request,
  recent = false,
): Promise<HostSession | Response> {
  const host = await authenticateHost(env.DB, request);
  if (!host) return apiError("UNAUTHENTICATED", "Sign in with a passkey", 401);
  if (recent && !isRecentPasskey(host)) {
    return apiError("RECENT_PASSKEY_REQUIRED", "Confirm a passkey again before changing a provider", 403);
  }
  return host;
}

export async function proxyConnector(
  env: ConnectorProxyEnv,
  request: Request,
  internalPath: string,
  accountId?: string,
  options: { raw?: boolean; roomId?: string } = {},
): Promise<Response> {
  const source = new URL(request.url);
  const target = new URL(internalPath, "https://unijam-connectors.internal");
  target.search = source.search;
  const headers = new Headers();
  const contentType = request.headers.get("Content-Type");
  if (contentType) headers.set("Content-Type", contentType);
  if (accountId) headers.set("X-UniJam-Account-Id", accountId);
  if (options.roomId) headers.set("X-UniJam-Room-Id", options.roomId);
  if (env.CONNECTOR_SERVICE_TOKEN) headers.set("Authorization", `Bearer ${env.CONNECTOR_SERVICE_TOKEN}`);
  const response = await env.CONNECTORS.fetch(new Request(target, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "manual",
  }));
  if (options.raw || response.status >= 300 && response.status < 400) return response;
  let body: unknown;
  try { body = await response.json(); }
  catch { return apiError("CONNECTOR_UNAVAILABLE", "Provider service returned an invalid response", 502, true); }
  if (body && typeof body === "object" && "data" in body && "error" in body && "requestId" in body) {
    return Response.json(body, { status: response.status, headers: { "Cache-Control": "no-store" } });
  }
  if (!response.ok) return apiError("CONNECTOR_REQUEST_FAILED", "Provider request could not be completed", response.status, response.status >= 500);
  return apiResponse(body);
}

export async function connectorJsonRequest(
  env: ConnectorProxyEnv,
  path: string,
  body: Record<string, unknown>,
  method = "POST",
): Promise<Response> {
  if (!env.CONNECTOR_SERVICE_TOKEN) return apiError("CONNECTOR_UNAVAILABLE", "Provider service is unavailable", 503, true);
  try {
    const response = await env.CONNECTORS.fetch(new Request(new URL(path, "https://unijam-connectors.internal"), {
      method,
      headers: { "Authorization": `Bearer ${env.CONNECTOR_SERVICE_TOKEN}`, "Content-Type": "application/json", "X-Request-Id": crypto.randomUUID() },
      body: JSON.stringify(body),
    }));
    const payload = await response.json() as unknown;
    if (!payload || typeof payload !== "object" || !("data" in payload) || !("error" in payload) || !("requestId" in payload)) {
      return apiError("CONNECTOR_UNAVAILABLE", "Provider service returned an invalid response", 502, true);
    }
    // Re-wrap service-binding responses at the public Worker boundary. This
    // prevents a provider-internal Response stream or headers object from
    // leaking across runtimes while preserving the connector's safe envelope.
    return Response.json(payload, { status: response.status, headers: { "Cache-Control": "no-store" } });
  } catch {
    return apiError("CONNECTOR_UNAVAILABLE", "Provider service is unavailable", 503, true);
  }
}
