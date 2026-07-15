import { env } from "cloudflare:workers";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";

import { apiError, apiResponse } from "@/lib/server/api-response";
import { consumeAuthRateLimit, requestIp } from "@/lib/server/auth-rate-limit";
import { createHostSession } from "@/lib/server/host-session";
import { finishAuthentication } from "@/lib/server/passkeys";

export async function POST(request: Request): Promise<Response> {
  try {
    if (!env.DB) return apiError("PERSISTENCE_UNAVAILABLE", "Account persistence is unavailable", 503, true);
    const body = await request.json() as { response?: AuthenticationResponseJSON };
    if (!body.response) return apiError("INVALID_AUTHENTICATION", "Authentication response is missing", 400);
    if (!await consumeAuthRateLimit(env.DB, `authentication-verify:ip:${requestIp(request)}`, 60) ||
        !await consumeAuthRateLimit(env.DB, `authentication-verify:credential:${body.response.id}`, 20)) {
      return apiError("RATE_LIMITED", "Sign-in cannot be completed right now", 429, true);
    }
    const result = await finishAuthentication(env.DB, env, body.response);
    const session = await createHostSession(env.DB, result.accountId);
    return apiResponse(result, { headers: { "Set-Cookie": session.cookie } });
  } catch {
    return apiError("AUTHENTICATION_FAILED", "Passkey authentication failed", 401);
  }
}
