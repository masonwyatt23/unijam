import { env } from "cloudflare:workers";

import { apiError } from "@/lib/server/api-response";
import { connectorJsonRequest, publicAppOrigin, requireConnectorHost, type ConnectorProxyEnv } from "@/lib/server/connector-proxy";

export async function POST(request: Request): Promise<Response> {
  if (!env.DB || !env.CONNECTORS) return apiError("CONNECTOR_UNAVAILABLE", "Apple Music authorization is unavailable", 503, true);
  const runtime = env as ConnectorProxyEnv;
  const host = await requireConnectorHost(runtime, request, true);
  if (host instanceof Response) return host;
  return connectorJsonRequest(runtime, "/v1/apple-music/developer-token", {
    accountId: host.account_id,
    origin: publicAppOrigin(env),
  });
}
