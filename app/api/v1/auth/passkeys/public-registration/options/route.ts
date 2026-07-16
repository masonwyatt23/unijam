import { env } from "cloudflare:workers";

import { apiError, apiResponse } from "@/lib/server/api-response";
import { BoundedBodyError, readBoundedJson } from "@/lib/server/bounded-body";
import { consumeAuthRateLimit, requestIp } from "@/lib/server/auth-rate-limit";
import { publicRegistrationOptions } from "@/lib/server/passkeys";

const OPTIONS_BODY_LIMIT = 2_048;

export async function POST(request: Request): Promise<Response> {
  if (!env.DB) return apiError("PERSISTENCE_UNAVAILABLE", "Account persistence is unavailable", 503, true);
  try {
    if (!await consumeAuthRateLimit(env.DB, `public-registration-options:ip:${requestIp(request)}`, 10)) {
      return apiError("RATE_LIMITED", "Account creation cannot be started right now", 429, true);
    }
    const body = await readBoundedJson(request, OPTIONS_BODY_LIMIT) as { userName?: unknown; displayName?: unknown };
    const userName = typeof body?.userName === "string" ? body.userName.trim() : "";
    const displayName = typeof body?.displayName === "string" ? body.displayName.trim() : "";
    if (!userName || userName.length > 254 || /[\u0000-\u001f\u007f]/.test(userName) ||
        !displayName || displayName.length > 80 || /[\u0000-\u001f\u007f]/.test(displayName)) {
      return apiError("INVALID_ACCOUNT", "A valid name and account label are required", 400);
    }
    return apiResponse(await publicRegistrationOptions(env.DB, env, { userName, displayName }));
  } catch (error) {
    if (error instanceof BoundedBodyError) return apiError(error.code, error.message, error.status);
    return apiError("REGISTRATION_OPTIONS_FAILED", "Account creation could not be started", 500, true);
  }
}
