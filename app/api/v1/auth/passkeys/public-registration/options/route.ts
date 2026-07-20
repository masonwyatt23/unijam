import { env } from "cloudflare:workers";

import { apiError, apiResponse } from "@/lib/server/api-response";
import { BoundedBodyError, readBoundedJson } from "@/lib/server/bounded-body";
import { consumeAuthRateLimit, requestIp } from "@/lib/server/auth-rate-limit";
import { normalizeBootstrapDisplayName, publicRegistrationOptions } from "@/lib/server/passkeys";

const OPTIONS_BODY_LIMIT = 2_048;

export async function POST(request: Request): Promise<Response> {
  if (!env.DB) return apiError("PERSISTENCE_UNAVAILABLE", "Account persistence is unavailable", 503, true);
  try {
    if (!await consumeAuthRateLimit(env.DB, `public-registration-options:ip:${requestIp(request)}`, 10)) {
      return apiError("RATE_LIMITED", "Account creation cannot be started right now", 429, true);
    }
    const body = await readBoundedJson(request, OPTIONS_BODY_LIMIT) as { displayName?: unknown };
    const displayName = normalizeBootstrapDisplayName(body?.displayName);
    if (!displayName) {
      return apiError("INVALID_ACCOUNT", "A valid name is required", 400);
    }
    return apiResponse(await publicRegistrationOptions(env.DB, env, { displayName }));
  } catch (error) {
    if (error instanceof BoundedBodyError) return apiError(error.code, error.message, error.status);
    return apiError("REGISTRATION_OPTIONS_FAILED", "Account creation could not be started", 500, true);
  }
}
