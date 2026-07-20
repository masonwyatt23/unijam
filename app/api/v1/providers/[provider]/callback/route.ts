import { env } from "cloudflare:workers";
import { apiError } from "@/lib/server/api-response";
import { clearSpotifyReturnCookie, providerResultPath, readSpotifyReturnTo, type ProviderConnectionResult } from "@/lib/provider-return-to";
import { connectorJsonRequest, normalizeProvider, publicAppOrigin, requireConnectorHost, type ConnectorProxyEnv } from "@/lib/server/connector-proxy";

type Context = { params: Promise<{ provider: string }> };

function spotifyResultRedirect(
  origin: string,
  request: Request,
  state: string | null,
  result: ProviderConnectionResult,
): Response {
  const destination = providerResultPath(readSpotifyReturnTo(request, state), "spotify", result);
  const headers = new Headers({ Location: `${origin}${destination}`, "Cache-Control": "no-store" });
  const clearCookie = clearSpotifyReturnCookie(state);
  if (clearCookie) headers.append("Set-Cookie", clearCookie);
  return new Response(null, { status: 303, headers });
}

async function callback(request: Request, context: Context): Promise<Response> {
  let provider: "spotify" | "apple-music";
  try {
    provider = normalizeProvider((await context.params).provider);
  } catch {
    return apiError("UNSUPPORTED_PROVIDER", "Provider is unsupported", 404);
  }
  if (provider !== "spotify") return apiError("UNSUPPORTED_CALLBACK", "Provider callback is unsupported", 404);
  const origin = publicAppOrigin(env);
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  if (!env.DB || !env.CONNECTORS) return spotifyResultRedirect(origin, request, state, "failed");
  try {
    const runtime = env as ConnectorProxyEnv;
    const providerError = url.searchParams.get("error");
    if (providerError) {
      return spotifyResultRedirect(origin, request, state, providerError === "access_denied" ? "cancelled" : "failed");
    }
    const host = await requireConnectorHost(runtime, request);
    if (host instanceof Response) return spotifyResultRedirect(origin, request, state, "failed");
    const code = url.searchParams.get("code");
    if (!code || !state) return spotifyResultRedirect(origin, request, state, "failed");
    const response = await connectorJsonRequest(runtime, "/v1/oauth/spotify/callback", {
      accountId: host.account_id, code, state, callbackUrl: `${origin}/api/v1/providers/spotify/callback`,
    });
    if (!response.ok) return spotifyResultRedirect(origin, request, state, "failed");
    return spotifyResultRedirect(origin, request, state, "connected");
  } catch {
    return spotifyResultRedirect(origin, request, state, "failed");
  }
}
export const GET = callback;
