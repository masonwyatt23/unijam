import { env } from "cloudflare:workers";

import { apiResponse } from "@/lib/server/api-response";
import { authenticateHost, revokeHostSession } from "@/lib/server/host-session";
import { revokeLinkedGuestSession } from "@/lib/server/logout-sessions";
import { clearSessionCookie, GUEST_SESSION_COOKIE, HOST_SESSION_COOKIE } from "@/lib/server/session-cookie";

export async function POST(request: Request): Promise<Response> {
  if (env.DB) {
    const account = await authenticateHost(env.DB, request, { allowDeletionPending: true });
    if (account) await revokeLinkedGuestSession(env.DB, request, account.account_id);
    await revokeHostSession(env.DB, request);
  }
  const headers = new Headers();
  headers.append("Set-Cookie", clearSessionCookie(HOST_SESSION_COOKIE));
  headers.append("Set-Cookie", clearSessionCookie(GUEST_SESSION_COOKIE));
  return apiResponse({ loggedOut: true }, { headers });
}
