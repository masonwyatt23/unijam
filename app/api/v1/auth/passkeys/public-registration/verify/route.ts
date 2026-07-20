import { env } from "cloudflare:workers";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";

import { apiError, apiResponse } from "@/lib/server/api-response";
import { BoundedBodyError, readBoundedJson } from "@/lib/server/bounded-body";
import { consumeAuthRateLimit, requestIp } from "@/lib/server/auth-rate-limit";
import { finishBootstrapRegistration, normalizeBootstrapDisplayName } from "@/lib/server/passkeys";

const VERIFY_BODY_LIMIT = 32_768;

export async function POST(request: Request): Promise<Response> {
  if (!env.DB) return apiError("PERSISTENCE_UNAVAILABLE", "Account persistence is unavailable", 503, true);
  try {
    const body = await readBoundedJson(request, VERIFY_BODY_LIMIT) as {
      accountId?: unknown;
      displayName?: unknown;
      response?: RegistrationResponseJSON;
    };
    if (typeof body?.accountId !== "string" || typeof body.displayName !== "string" || !body.response) {
      return apiError("INVALID_REGISTRATION", "Registration response is incomplete", 400);
    }
    const displayName = normalizeBootstrapDisplayName(body.displayName);
    if (!/^[0-9a-f-]{36}$/.test(body.accountId) || !displayName) {
      return apiError("INVALID_REGISTRATION", "Registration response is incomplete", 400);
    }
    if (!await consumeAuthRateLimit(env.DB, `public-registration-verify:ip:${requestIp(request)}`, 20) ||
        !await consumeAuthRateLimit(env.DB, `public-registration-verify:account:${body.accountId}`, 10)) {
      return apiError("RATE_LIMITED", "Account creation cannot be completed right now", 429, true);
    }
    const result = await finishBootstrapRegistration(
      env.DB,
      env,
      { accountId: body.accountId, displayName, response: body.response },
      "public",
    );
    const { sessionCookie, ...data } = result;
    return apiResponse(data, { status: 201, headers: { "Set-Cookie": sessionCookie } });
  } catch (error) {
    if (error instanceof BoundedBodyError) return apiError(error.code, error.message, error.status);
    return apiError("REGISTRATION_VERIFICATION_FAILED", "Passkey account creation could not be completed", 400);
  }
}
