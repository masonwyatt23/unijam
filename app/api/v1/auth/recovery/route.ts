import { env } from "cloudflare:workers";

import { apiError, apiResponse } from "@/lib/server/api-response";
import { consumeAuthRateLimit, requestIp } from "@/lib/server/auth-rate-limit";
import { createHostSession } from "@/lib/server/host-session";
import { consumeRecoveryCode } from "@/lib/server/recovery-codes";

export async function POST(request: Request): Promise<Response> {
  if (!env.DB) return apiError("PERSISTENCE_UNAVAILABLE", "Account persistence is unavailable", 503, true);
  const body = await request.json() as { code?: unknown };
  if (typeof body.code !== "string") return apiError("INVALID_RECOVERY_CODE", "Recovery code is missing", 400);
  if (!await consumeAuthRateLimit(env.DB, `recovery:ip:${requestIp(request)}`, 10)) return apiError("RATE_LIMITED", "Recovery cannot be attempted right now", 429, true);
  const accountId = await consumeRecoveryCode(env.DB, body.code);
  if (!accountId) return apiError("INVALID_RECOVERY_CODE", "Recovery code is invalid or already used", 401);
  const session = await createHostSession(env.DB, accountId, "recovery");
  return apiResponse({ recovered: true }, { headers: { "Set-Cookie": session.cookie } });
}
