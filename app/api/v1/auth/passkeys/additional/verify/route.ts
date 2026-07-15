import { env } from "cloudflare:workers";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";

import { apiError, apiResponse } from "@/lib/server/api-response";
import { consumeAuthRateLimit } from "@/lib/server/auth-rate-limit";
import { authenticateHost, canEnrollRecoveryPasskey, isRecentPasskey } from "@/lib/server/host-session";
import { finishRegistration } from "@/lib/server/passkeys";

export async function POST(request: Request): Promise<Response> {
  if (!env.DB) return apiError("PERSISTENCE_UNAVAILABLE", "Account persistence is unavailable", 503, true);
  const host = await authenticateHost(env.DB, request);
  if (!host || (!isRecentPasskey(host) && !canEnrollRecoveryPasskey(host))) return apiError("RECENT_PASSKEY_REQUIRED", "Confirm a passkey or use an active recovery enrollment grant", 403);
  if (!await consumeAuthRateLimit(env.DB, `additional-passkey-verify:${host.account_id}`, 10)) return apiError("RATE_LIMITED", "A passkey cannot be added right now", 429, true);
  const body = await request.json() as { response?: RegistrationResponseJSON };
  if (!body.response) return apiError("INVALID_REGISTRATION", "Registration response is missing", 400);
  try {
    return apiResponse(await finishRegistration(env.DB, env, {
      accountId: host.account_id, displayName: host.display_name, response: body.response,
    }, "additional_registration", canEnrollRecoveryPasskey(host) ? host.session_id : undefined), { status: 201 });
  } catch {
    return apiError("REGISTRATION_VERIFICATION_FAILED", "Passkey registration failed", 400);
  }
}
