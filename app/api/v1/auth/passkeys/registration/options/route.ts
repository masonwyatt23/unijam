import { env } from "cloudflare:workers";

import { apiError, apiResponse } from "@/lib/server/api-response";
import { consumeAuthRateLimit, requestIp } from "@/lib/server/auth-rate-limit";
import { registrationOptions } from "@/lib/server/passkeys";

export async function POST(request: Request): Promise<Response> {
  try {
    if (!env.DB) return apiError("PERSISTENCE_UNAVAILABLE", "Account persistence is unavailable", 503, true);
    if (!await consumeAuthRateLimit(env.DB, `registration-options:ip:${requestIp(request)}`, 10)) {
      return apiError("RATE_LIMITED", "Enrollment cannot be started right now", 429, true);
    }
    const body = await request.json() as { userName?: unknown; displayName?: unknown; enrollmentCode?: unknown };
    const userName = typeof body.userName === "string" ? body.userName.trim() : "";
    const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
    if (!userName || userName.length > 254 || !displayName || displayName.length > 80) {
      return apiError("INVALID_ACCOUNT", "A valid name and account label are required", 400);
    }
    if (typeof body.enrollmentCode !== "string") return apiError("ENROLLMENT_UNAVAILABLE", "Pilot enrollment is unavailable", 403);
    return apiResponse(await registrationOptions(env.DB, env, { userName, displayName, enrollmentCode: body.enrollmentCode }));
  } catch (error) {
    void error;
    return apiError("ENROLLMENT_UNAVAILABLE", "Pilot enrollment is unavailable", 403);
  }
}
