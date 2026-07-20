import { env } from "cloudflare:workers";

import { apiError, apiResponse } from "@/lib/server/api-response";
import { consumeAuthRateLimit } from "@/lib/server/auth-rate-limit";
import { authenticationOptions } from "@/lib/server/passkeys";

export async function POST(request: Request): Promise<Response> {
  if (!env.DB) return apiError("PERSISTENCE_UNAVAILABLE", "Account persistence is unavailable", 503, true);
  try {
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    if (!await consumeAuthRateLimit(env.DB, `authentication-options:ip:${ip}`, 30)) return apiError("RATE_LIMITED", "Sign-in cannot be started right now", 429, true);
    return apiResponse(await authenticationOptions(env.DB, env));
  }
  catch { return apiError("AUTHENTICATION_OPTIONS_FAILED", "Unable to begin passkey authentication", 500, true); }
}
