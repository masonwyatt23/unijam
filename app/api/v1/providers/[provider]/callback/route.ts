import { env } from "cloudflare:workers";
import { apiError } from "@/lib/server/api-response";
import { connectorJsonRequest, normalizeProvider, publicAppOrigin, requireConnectorHost, type ConnectorProxyEnv } from "@/lib/server/connector-proxy";

type Context = { params: Promise<{ provider: string }> };
async function callback(request: Request, context: Context): Promise<Response> {
  if (!env.DB || !env.CONNECTORS) return apiError("CONNECTOR_UNAVAILABLE", "Provider service is unavailable", 503, true);
  try {
    const provider = normalizeProvider((await context.params).provider);
    if (provider !== "spotify") return apiError("UNSUPPORTED_CALLBACK", "Provider callback is unsupported", 404);
    const runtime = env as ConnectorProxyEnv;
    const host = await requireConnectorHost(runtime, request, true);
    if (host instanceof Response) return host;
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) return apiError("OAUTH_CALLBACK_INVALID", "Provider callback is incomplete", 400);
    const origin = publicAppOrigin(env);
    const response = await connectorJsonRequest(runtime, "/v1/oauth/spotify/callback", {
      accountId: host.account_id, code, state, callbackUrl: `${origin}/api/v1/providers/spotify/callback`,
    });
    if (!response.ok) return response;
    return Response.redirect(`${origin}/connections?connected=spotify`, 303);
  } catch { return apiError("UNSUPPORTED_PROVIDER", "Provider is unsupported", 404); }
}
export const GET = callback;
