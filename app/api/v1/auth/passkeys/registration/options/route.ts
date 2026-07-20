import { env } from "cloudflare:workers";

import { apiError, apiResponse } from "@/lib/server/api-response";
import { consumeAuthRateLimit, requestIp } from "@/lib/server/auth-rate-limit";
import { BoundedBodyError, readBoundedJson } from "@/lib/server/bounded-body";
import { normalizeBootstrapDisplayName, registrationOptions } from "@/lib/server/passkeys";

const OPTIONS_BODY_LIMIT = 2_048;

export async function POST(request: Request): Promise<Response> {
  try {
    if (!env.DB) return apiError("PERSISTENCE_UNAVAILABLE", "Account persistence is unavailable", 503, true);
    if (!await consumeAuthRateLimit(env.DB, `registration-options:ip:${requestIp(request)}`, 10)) {
      return apiError("RATE_LIMITED", "Enrollment cannot be started right now", 429, true);
    }
    const body = await readBoundedJson(request, OPTIONS_BODY_LIMIT) as { displayName?: unknown; enrollmentCode?: unknown };
    const displayName = normalizeBootstrapDisplayName(body.displayName);
    if (!displayName) {
      return apiError("INVALID_ACCOUNT", "A valid name is required", 400);
    }
    if (typeof body.enrollmentCode !== "string") return apiError("ENROLLMENT_UNAVAILABLE", "Pilot enrollment is unavailable", 403);
    return apiResponse(await registrationOptions(env.DB, env, { displayName, enrollmentCode: body.enrollmentCode }));
  } catch (error) {
    if (error instanceof BoundedBodyError) return apiError(error.code, error.message, error.status);
    return apiError("ENROLLMENT_UNAVAILABLE", "Pilot enrollment is unavailable", 403);
  }
}
