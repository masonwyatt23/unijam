import { verifyAccessJwt, type AccessVerificationDependencies } from "./access";

const RECOVERY_PATH = "/v1/operator/publish/recover-playlist";
const MAX_BODY_BYTES = 16 * 1024;

type RecoveryBody = {
  operationId: string;
  expectedRecoveryMarker: string;
  destinationPlaylistId: string;
};

export type OperatorIngressDependencies = AccessVerificationDependencies;

function errorResponse(requestId: string, status: number, code: string, message: string): Response {
  return Response.json(
    { data: null, error: { code, message }, requestId },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readRecoveryBody(request: Request): Promise<RecoveryBody> {
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw new Error("Recovery request must be JSON");
  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error("Recovery request is too large");
  if (!request.body) throw new Error("Recovery request body is required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error("Recovery request is too large");
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error("Recovery request body is malformed"); }
  if (!isObject(value) || Object.keys(value).some((key) => !["operationId", "expectedRecoveryMarker", "destinationPlaylistId"].includes(key))) {
    throw new Error("Recovery request body is malformed");
  }
  if (typeof value.operationId !== "string" || !/^[A-Za-z0-9._:%-]{8,255}$/.test(value.operationId)) throw new Error("Recovery operation is invalid");
  if (typeof value.expectedRecoveryMarker !== "string" || !/^unijam:v1:create_playlist:[a-f0-9]{16}$/.test(value.expectedRecoveryMarker)) throw new Error("Recovery marker is invalid");
  if (typeof value.destinationPlaylistId !== "string" || !/^[A-Za-z0-9._:-]{2,255}$/.test(value.destinationPlaylistId)) throw new Error("Recovery destination is invalid");
  return {
    operationId: value.operationId,
    expectedRecoveryMarker: value.expectedRecoveryMarker,
    destinationPlaylistId: value.destinationPlaylistId,
  };
}

export async function handleOperatorRequest(
  request: Request,
  env: Cloudflare.Env,
  dependencies: OperatorIngressDependencies = {},
): Promise<Response> {
  const requestId = crypto.randomUUID();
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== RECOVERY_PATH || url.search || url.hash) {
    return errorResponse(requestId, 404, "NOT_FOUND", "Operator route was not found");
  }
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || !env.ACCESS_SERVICE_TOKEN_CLIENT_ID) {
    return errorResponse(requestId, 503, "ACCESS_NOT_CONFIGURED", "Operator Access is not configured");
  }
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion") ?? "";
  try {
    await verifyAccessJwt(assertion, {
      teamDomain: env.ACCESS_TEAM_DOMAIN,
      audience: env.ACCESS_AUD,
      serviceTokenClientId: env.ACCESS_SERVICE_TOKEN_CLIENT_ID,
    }, dependencies);
  } catch {
    return errorResponse(requestId, 401, "ACCESS_UNAUTHORIZED", "Cloudflare Access authorization failed");
  }
  if (!env.CONNECTORS || !env.CONNECTOR_SERVICE_TOKEN || !env.CONNECTOR_OPERATOR_SECRET) {
    return errorResponse(requestId, 503, "CONNECTOR_AUTH_NOT_CONFIGURED", "Connector authorization is not configured");
  }
  let body: RecoveryBody;
  try { body = await readRecoveryBody(request); }
  catch (error) {
    return errorResponse(requestId, 400, "INVALID_BODY", error instanceof Error ? error.message : "Recovery request is invalid");
  }
  let response: Response;
  try {
    response = await env.CONNECTORS.fetch(new Request(`https://connectors.internal${RECOVERY_PATH}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CONNECTOR_SERVICE_TOKEN}`,
        "X-UniJam-Operator-Authorization": `Bearer ${env.CONNECTOR_OPERATOR_SECRET}`,
        "X-Request-Id": requestId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }));
  } catch {
    return errorResponse(requestId, 502, "CONNECTOR_UNAVAILABLE", "Connector recovery service is unavailable");
  }
  return new Response(response.body, {
    status: response.status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": response.headers.get("Content-Type") ?? "application/json",
      "X-Request-Id": requestId,
    },
  });
}

export default {
  fetch(request, env) {
    return handleOperatorRequest(request, env);
  },
} satisfies ExportedHandler<Cloudflare.Env>;
