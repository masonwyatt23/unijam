import { env } from "cloudflare:workers";

import { apiResponse } from "@/lib/server/api-response";
import { revokeHostSession } from "@/lib/server/host-session";
import { clearSessionCookie, HOST_SESSION_COOKIE } from "@/lib/server/session-cookie";

export async function POST(request: Request): Promise<Response> {
  if (env.DB) await revokeHostSession(env.DB, request);
  return apiResponse({ loggedOut: true }, { headers: { "Set-Cookie": clearSessionCookie(HOST_SESSION_COOKIE) } });
}
