import { env } from "cloudflare:workers";
import { apiError } from "@/lib/server/api-response";
import { connectorJsonRequest, normalizeProvider, publicAppOrigin, requireConnectorHost, type ConnectorProxyEnv } from "@/lib/server/connector-proxy";

type Context = { params: Promise<{ provider: string }> };
async function connect(request: Request, context: Context): Promise<Response> {
  if (!env.DB || !env.CONNECTORS) return apiError("CONNECTOR_UNAVAILABLE", "Provider service is unavailable", 503, true);
  try {
    const provider = normalizeProvider((await context.params).provider);
    const runtime = env as ConnectorProxyEnv;
    const host = await requireConnectorHost(runtime, request, true);
    if (host instanceof Response) return host;
    const connectionId = `${provider}:${host.account_id}`;
    const origin = publicAppOrigin(env);
    if (provider === "spotify") {
      const response = await connectorJsonRequest(runtime, "/v1/oauth/spotify/authorize", {
        accountId: host.account_id, connectionId, origin,
      });
      if (request.method === "GET" && response.ok) {
        const result = await response.clone().json() as { data?: { authorizeUrl?: string } };
        if (result.data?.authorizeUrl?.startsWith("https://accounts.spotify.com/")) return Response.redirect(result.data.authorizeUrl, 303);
      }
      return response;
    }
    if (request.method !== "POST") return apiError("MUSICKIT_REQUIRED", "Authorize Apple Music from the connection screen", 405);
    const body = await request.json() as { musicUserToken?: unknown };
    if (typeof body.musicUserToken !== "string") return apiError("MUSICKIT_REQUIRED", "Apple Music authorization is required", 400);
    return connectorJsonRequest(runtime, "/v1/connections/apple-music", {
      accountId: host.account_id, connectionId, origin, musicUserToken: body.musicUserToken,
    });
  } catch { return apiError("UNSUPPORTED_PROVIDER", "Provider is unsupported", 404); }
}
export const GET = connect;
export const POST = connect;
