import { hashOpaqueToken } from "./secure-token.ts";

export async function consumeAuthRateLimit(
  db: D1Database,
  scope: string,
  limit: number,
  windowMs = 60 * 60_000,
  now = Date.now(),
): Promise<boolean> {
  const scopeHash = await hashOpaqueToken(scope);
  const bucketStart = Math.floor(now / windowMs) * windowMs;
  const result = await db.prepare(
    `INSERT INTO auth_rate_buckets (scope_hash, bucket_start_ms, request_count, expires_at_ms)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(scope_hash, bucket_start_ms) DO UPDATE SET request_count = request_count + 1
     RETURNING request_count`,
  ).bind(scopeHash, bucketStart, bucketStart + windowMs * 2).first<{ request_count: number }>();
  await db.prepare("DELETE FROM auth_rate_buckets WHERE expires_at_ms <= ?").bind(now).run();
  return (result?.request_count ?? limit + 1) <= limit;
}

export function requestIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}
