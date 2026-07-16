export type BoundedBodyErrorCode =
  | "BODY_TOO_LARGE"
  | "BODY_LENGTH_INVALID"
  | "BODY_LENGTH_MISMATCH"
  | "JSON_REQUIRED"
  | "INVALID_JSON";

export class BoundedBodyError extends Error {
  readonly code: BoundedBodyErrorCode;
  readonly status: number;

  constructor(code: BoundedBodyErrorCode, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function declaredLength(request: Request, maximumBytes: number): number | null {
  const value = request.headers.get("Content-Length");
  if (value === null) return null;
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new BoundedBodyError("BODY_LENGTH_INVALID", "Content-Length is invalid", 400);
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length)) {
    throw new BoundedBodyError("BODY_LENGTH_INVALID", "Content-Length is invalid", 400);
  }
  if (length > maximumBytes) {
    throw new BoundedBodyError("BODY_TOO_LARGE", "Request payload exceeds the allowed size", 413);
  }
  return length;
}

function assertMaximum(maximumBytes: number): void {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new Error("maximumBytes must be a non-negative safe integer");
  }
}

/** Reads the actual stream and stops before an undeclared/chunked body can exceed the cap. */
export async function readBoundedBody(request: Request, maximumBytes: number): Promise<Uint8Array> {
  assertMaximum(maximumBytes);
  const declared = declaredLength(request, maximumBytes);
  if (!request.body) {
    if (declared !== null && declared !== 0) {
      throw new BoundedBodyError("BODY_LENGTH_MISMATCH", "Request body length does not match Content-Length", 400);
    }
    return new Uint8Array();
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      received += chunk.byteLength;
      if (received > maximumBytes) {
        await reader.cancel("request body exceeds limit").catch(() => undefined);
        throw new BoundedBodyError("BODY_TOO_LARGE", "Request payload exceeds the allowed size", 413);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  if (declared !== null && declared !== received) {
    throw new BoundedBodyError("BODY_LENGTH_MISMATCH", "Request body length does not match Content-Length", 400);
  }
  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** Rebuilds a consumed request so downstream framework routes see the capped body. */
export async function requestWithBoundedBody(request: Request, maximumBytes: number): Promise<Request> {
  const body = await readBoundedBody(request, maximumBytes);
  const headers = new Headers(request.headers);
  // Do not forward a client-asserted length after consuming the stream. The
  // reconstructed request is bounded and downstream reads the exact body.
  headers.delete("Content-Length");
  const buffer = new ArrayBuffer(body.byteLength);
  new Uint8Array(buffer).set(body);
  return new Request(request, { headers, body: buffer });
}

export async function readBoundedJson(request: Request, maximumBytes: number): Promise<unknown> {
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
    throw new BoundedBodyError("JSON_REQUIRED", "Request must use application/json", 415);
  }
  const bytes = await readBoundedBody(request, maximumBytes);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new BoundedBodyError("INVALID_JSON", "Request body is not valid JSON", 400);
  }
}
