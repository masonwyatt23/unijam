export type RateLimitDecision = {
  allowed: boolean;
  limit: number;
  retryAfterSeconds: number;
};

export function rateLimitWindow(now: number, windowMs: number): {
  bucketStartMs: number;
  expiresAtMs: number;
  retryAfterSeconds: number;
} {
  const bucketStartMs = Math.floor(now / windowMs) * windowMs;
  return {
    bucketStartMs,
    expiresAtMs: bucketStartMs + windowMs * 2,
    retryAfterSeconds: Math.max(1, Math.ceil((bucketStartMs + windowMs - now) / 1_000)),
  };
}

export async function consumeRateLimit(
  db: D1Database,
  input: { scope: string; limit: number; windowMs: number; now: number },
): Promise<RateLimitDecision> {
  const window = rateLimitWindow(input.now, input.windowMs);
  const result = await db.prepare(
    `INSERT INTO room_rate_buckets (scope, bucket_start_ms, request_count, expires_at_ms)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(scope, bucket_start_ms) DO UPDATE SET
       request_count = room_rate_buckets.request_count + 1,
       expires_at_ms = excluded.expires_at_ms
     WHERE room_rate_buckets.request_count < ?`,
  ).bind(input.scope, window.bucketStartMs, window.expiresAtMs, input.limit).run();
  return {
    allowed: (result.meta.changes ?? 0) === 1,
    limit: input.limit,
    retryAfterSeconds: window.retryAfterSeconds,
  };
}
