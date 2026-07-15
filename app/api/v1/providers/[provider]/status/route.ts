import { env } from "cloudflare:workers";
import { apiError } from "@/lib/server/api-response";
import { connectorJsonRequest, normalizeProvider, requireConnectorHost, type ConnectorProxyEnv } from "@/lib/server/connector-proxy";

type Context = { params: Promise<{ provider: string }> };
export async function GET(request: Request, context: Context): Promise<Response> {
  if (!env.DB || !env.CONNECTORS) return apiError("CONNECTOR_UNAVAILABLE", "Provider service is unavailable", 503, true);
  try {
    const provider = normalizeProvider((await context.params).provider);
    const runtime = env as ConnectorProxyEnv;
    const host = await requireConnectorHost(runtime, request);
    if (host instanceof Response) return host;
    return connectorJsonRequest(runtime, "/v1/connections/status", {
      accountId: host.account_id, connectionId: `${provider}:${host.account_id}`, provider: provider === "apple-music" ? "apple_music" : provider,
    });
  } catch { return apiError("UNSUPPORTED_PROVIDER", "Provider is unsupported", 404); }
}
