import { env } from "cloudflare:workers";
import { apiError } from "@/lib/server/api-response";
import { connectorJsonRequest, normalizeProvider, requireConnectorHost, type ConnectorProxyEnv } from "@/lib/server/connector-proxy";

type Context = { params: Promise<{ provider: string }> };
export async function POST(request: Request, context: Context): Promise<Response> {
  if (!env.DB || !env.CONNECTORS) return apiError("CONNECTOR_UNAVAILABLE", "Provider service is unavailable", 503, true);
  try {
    const provider = normalizeProvider((await context.params).provider);
    const runtime = env as ConnectorProxyEnv;
    const host = await requireConnectorHost(runtime, request, true);
    if (host instanceof Response) return host;
    return connectorJsonRequest(runtime, `/v1/connections/${provider}`, {
      accountId: host.account_id, connectionId: `${provider}:${host.account_id}`,
    }, "DELETE");
  } catch { return apiError("UNSUPPORTED_PROVIDER", "Provider is unsupported", 404); }
}
