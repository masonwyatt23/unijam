import { env } from "cloudflare:workers";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";

import { apiError, apiResponse } from "@/lib/server/api-response";
import { consumeAuthRateLimit, requestIp } from "@/lib/server/auth-rate-limit";
import { createHostSession } from "@/lib/server/host-session";
import { finishRegistration } from "@/lib/server/passkeys";
import { createRecoveryCodes } from "@/lib/server/recovery-codes";

export async function POST(request: Request): Promise<Response> {
  try {
    if (!env.DB) return apiError("PERSISTENCE_UNAVAILABLE", "Account persistence is unavailable", 503, true);
    const body = await request.json() as { accountId?: unknown; displayName?: unknown; response?: RegistrationResponseJSON };
    if (typeof body.accountId !== "string" || typeof body.displayName !== "string" || !body.response) {
      return apiError("INVALID_REGISTRATION", "Registration response is incomplete", 400);
    }
    const displayName = body.displayName.trim();
    if (!displayName || displayName.length > 80) return apiError("INVALID_REGISTRATION", "Registration response is incomplete", 400);
    if (!await consumeAuthRateLimit(env.DB, `registration-verify:ip:${requestIp(request)}`, 20) ||
        !await consumeAuthRateLimit(env.DB, `registration-verify:account:${body.accountId}`, 10)) {
      return apiError("RATE_LIMITED", "Enrollment cannot be completed right now", 429, true);
    }
    const result = await finishRegistration(env.DB, env, { accountId: body.accountId, displayName, response: body.response });
    const recoveryCodes = await createRecoveryCodes(env.DB, result.accountId);
    const session = await createHostSession(env.DB, result.accountId);
    return apiResponse({ ...result, recoveryCodes }, { status: 201, headers: { "Set-Cookie": session.cookie } });
  } catch (error) {
    void error;
    return apiError("REGISTRATION_VERIFICATION_FAILED", "Passkey registration could not be completed", 400);
  }
}
