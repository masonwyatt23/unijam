import { env } from "cloudflare:workers";

import { apiError, apiResponse } from "@/lib/server/api-response";
import { authenticateHost, canEnrollRecoveryPasskey, isRecentPasskey } from "@/lib/server/host-session";

export async function GET(request: Request): Promise<Response> {
  if (!env.DB) return apiError("PERSISTENCE_UNAVAILABLE", "Account persistence is unavailable", 503, true);
  const host = await authenticateHost(env.DB, request);
  if (!host) return apiError("UNAUTHENTICATED", "Host session is missing or expired", 401);
  return apiResponse({
    accountId: host.account_id,
    displayName: host.display_name,
    recentPasskey: isRecentPasskey(host),
    recoveryEnrollmentAvailable: canEnrollRecoveryPasskey(host),
  });
}
