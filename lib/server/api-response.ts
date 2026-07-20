export type ApiError = {
  code: string;
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
};

export function apiResponse(
  data: unknown,
  options: { status?: number; error?: ApiError | null; requestId?: string; headers?: HeadersInit } = {},
): Response {
  const requestId = options.requestId ?? crypto.randomUUID();
  return Response.json(
    { data, error: options.error ?? null, requestId },
    {
      status: options.status ?? (options.error ? 400 : 200),
      headers: { "Cache-Control": "no-store", "X-Request-Id": requestId, ...options.headers },
    },
  );
}

export function apiError(code: string, message: string, status: number, retryable = false): Response {
  return apiResponse(null, { status, error: { code, message, retryable } });
}

export function redactedInternalError(
  _error: unknown,
  code: string,
  message: string,
  status = 500,
  retryable = status >= 500,
): Response {
  return apiError(code, message, status, retryable);
}
