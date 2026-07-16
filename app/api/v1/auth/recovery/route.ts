import { env } from "cloudflare:workers";

import { apiError, apiResponse } from "@/lib/server/api-response";
import { consumeAuthRateLimit, requestIp } from "@/lib/server/auth-rate-limit";
import { BoundedBodyError, readBoundedJson } from "@/lib/server/bounded-body";
import { redeemRecoveryCode } from "@/lib/server/recovery-codes";

const RECOVERY_BODY_LIMIT = 1_024;

export async function POST(request: Request): Promise<Response> {
  if (!env.DB) return apiError("PERSISTENCE_UNAVAILABLE", "Account persistence is unavailable", 503, true);
  try {
    const body = await readBoundedJson(request, RECOVERY_BODY_LIMIT) as { code?: unknown };
    if (typeof body?.code !== "string") return apiError("INVALID_RECOVERY_CODE", "Recovery code is missing", 400);
    if (!await consumeAuthRateLimit(env.DB, `recovery:ip:${requestIp(request)}`, 10)) return apiError("RATE_LIMITED", "Recovery cannot be attempted right now", 429, true);
    const redemption = await redeemRecoveryCode(env.DB, body.code);
    if (!redemption) return apiError("INVALID_RECOVERY_CODE", "Recovery code is invalid or already used", 401);
    return apiResponse({ recovered: true }, { headers: { "Set-Cookie": redemption.sessionCookie } });
  } catch (error) {
    if (error instanceof BoundedBodyError) return apiError(error.code, error.message, error.status);
    return apiError("RECOVERY_FAILED", "Account recovery is temporarily unavailable", 503, true);
  }
}
