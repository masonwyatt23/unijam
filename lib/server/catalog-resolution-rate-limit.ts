import { consumeRateLimit } from "./rate-limit.ts";
import { apiResponse } from "./api-response.ts";

export const CATALOG_RESOLUTION_WINDOW_MS = 60_000;
export const CATALOG_RESOLUTION_PARTICIPANT_LIMIT = 12;
export const CATALOG_RESOLUTION_ROOM_LIMIT = 120;

export type CatalogResolutionBudgetInput = {
  readonly roomId: string;
  readonly participantId: string;
  readonly sessionId: string;
  readonly now: number;
};

export type CatalogResolutionBudgetDenied = {
  readonly allowed: false;
  readonly scope: "room" | "participant";
  readonly limit: number;
  readonly retryAfterSeconds: number;
};

export type CatalogResolutionBudgetResult<T> = CatalogResolutionBudgetDenied | {
  readonly allowed: true;
  readonly value: T;
};

export function catalogResolutionRateLimitResponse(decision: CatalogResolutionBudgetDenied): Response {
  return apiResponse(null, {
    status: 429,
    error: {
      code: "RESOLUTION_RATE_LIMITED",
      message: "This room is resolving tracks too quickly. Wait a moment, then try again.",
      retryable: true,
      details: { retryAfterSeconds: decision.retryAfterSeconds },
    },
    headers: { "Retry-After": String(decision.retryAfterSeconds) },
  });
}

/**
 * Applies both the aggregate room budget and the exact authenticated room
 * session budget before catalog/provider work begins. Every identifier comes
 * from server-authenticated room state; request payloads cannot select a scope.
 */
export async function withCatalogResolutionBudget<T>(
  db: D1Database,
  input: CatalogResolutionBudgetInput,
  operation: () => Promise<T>,
): Promise<CatalogResolutionBudgetResult<T>> {
  const policies = [
    {
      scope: "participant" as const,
      key: `catalog:room:${input.roomId}:participant:${input.participantId}:session:${input.sessionId}`,
      limit: CATALOG_RESOLUTION_PARTICIPANT_LIMIT,
    },
    {
      scope: "room" as const,
      key: `catalog:room:${input.roomId}`,
      limit: CATALOG_RESOLUTION_ROOM_LIMIT,
    },
  ];

  for (const policy of policies) {
    const decision = await consumeRateLimit(db, {
      scope: policy.key,
      limit: policy.limit,
      windowMs: CATALOG_RESOLUTION_WINDOW_MS,
      now: input.now,
    });
    if (!decision.allowed) {
      return {
        allowed: false,
        scope: policy.scope,
        limit: decision.limit,
        retryAfterSeconds: decision.retryAfterSeconds,
      };
    }
  }

  return { allowed: true, value: await operation() };
}
