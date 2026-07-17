import { env } from "cloudflare:workers";

import { apiError } from "@/lib/server/api-response";
import {
  connectorJsonRequest,
  normalizeProvider,
  requireConnectorHost,
  type ConnectorProxyEnv,
} from "@/lib/server/connector-proxy";

type Context = { params: Promise<{ provider: string }> };

function boundedLimit(value: string | null): number {
  if (value === null || value === "") return 20;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error("Invalid limit");
  return limit;
}

export async function GET(request: Request, context: Context): Promise<Response> {
  if (!env.DB || !env.CONNECTORS) return apiError("CONNECTOR_UNAVAILABLE", "Provider service is unavailable", 503, true);
  try {
    const provider = normalizeProvider((await context.params).provider);
    const runtime = env as ConnectorProxyEnv;
    const host = await requireConnectorHost(runtime, request);
    if (host instanceof Response) return host;
    const url = new URL(request.url);
    const query = url.searchParams.get("q")?.normalize("NFKC").trim() ?? "";
    if (query.length > 200) return apiError("INVALID_LIBRARY_QUERY", "Search is limited to 200 characters", 400);
    const cursor = url.searchParams.get("cursor")?.trim() || undefined;
    if (cursor && cursor.length > 256) return apiError("INVALID_LIBRARY_CURSOR", "Library cursor is invalid", 400);
    return connectorJsonRequest(runtime, query ? "/v1/library/search" : "/v1/library/tracks", {
      accountId: host.account_id,
      connectionId: `${provider}:${host.account_id}`,
      provider: provider === "apple-music" ? "apple_music" : provider,
      limit: boundedLimit(url.searchParams.get("limit")),
      ...(cursor ? { cursor } : {}),
      ...(query ? { query } : {}),
    });
  } catch {
    return apiError("INVALID_LIBRARY_REQUEST", "The music library request is invalid", 400);
  }
}
