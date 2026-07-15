import { env } from "cloudflare:workers";

import { apiError, apiResponse } from "@/lib/server/api-response";
import { consumeAuthRateLimit } from "@/lib/server/auth-rate-limit";
import { authenticateHost, canEnrollRecoveryPasskey, isRecentPasskey } from "@/lib/server/host-session";
import { additionalRegistrationOptions } from "@/lib/server/passkeys";

export async function POST(request: Request): Promise<Response> {
  if (!env.DB) return apiError("PERSISTENCE_UNAVAILABLE", "Account persistence is unavailable", 503, true);
  const host = await authenticateHost(env.DB, request);
  if (!host || (!isRecentPasskey(host) && !canEnrollRecoveryPasskey(host))) return apiError("RECENT_PASSKEY_REQUIRED", "Confirm a passkey or use an active recovery enrollment grant", 403);
  if (!await consumeAuthRateLimit(env.DB, `additional-passkey:${host.account_id}`, 10)) return apiError("RATE_LIMITED", "A passkey cannot be added right now", 429, true);
  const body = await request.json() as { userName?: unknown };
  const userName = typeof body.userName === "string" ? body.userName.trim() : host.display_name;
  return apiResponse(await additionalRegistrationOptions(env.DB, env, host.account_id, userName, host.display_name));
}
