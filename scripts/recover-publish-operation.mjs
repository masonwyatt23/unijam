#!/usr/bin/env node

const argv = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
};
const environment = valueAfter("--env");
const endpointValue = valueAfter("--endpoint");
const workersSubdomain = valueAfter("--workers-subdomain");
const operationId = valueAfter("--operation-id");
const expectedRecoveryMarker = valueAfter("--marker");
const destinationPlaylistId = valueAfter("--playlist-id");
const dryRun = argv.includes("--dry-run");

function fail(message) {
  console.error(message);
  process.exit(2);
}

if (!environment || !["staging", "production"].includes(environment)) fail("--env must be staging or production");
if (environment === "production" && valueAfter("--production-confirmation") !== "I_UNDERSTAND_THIS_RESUMES_A_PROVIDER_MUTATION") {
  fail("Production recovery requires --production-confirmation I_UNDERSTAND_THIS_RESUMES_A_PROVIDER_MUTATION");
}
if (!endpointValue) fail("--endpoint is required");
if (!workersSubdomain || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(workersSubdomain)) fail("--workers-subdomain is invalid");
let endpoint;
try { endpoint = new URL(endpointValue); } catch { fail("--endpoint must be an HTTPS URL"); }
const expectedWorker = `unijam-connectors-${environment}`;
if (
  endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.port || endpoint.search || endpoint.hash ||
  endpoint.pathname !== "/v1/operator/publish/recover-playlist" ||
  endpoint.hostname !== `${expectedWorker}.${workersSubdomain}.workers.dev`
) fail(`--endpoint must be the exact ${expectedWorker} workers.dev operator recovery URL`);
if (!operationId || !/^[A-Za-z0-9._:%-]{8,255}$/.test(operationId)) fail("--operation-id is invalid");
if (!expectedRecoveryMarker || !/^unijam:v1:create_playlist:[a-f0-9]{16}$/.test(expectedRecoveryMarker)) fail("--marker is invalid");
if (!destinationPlaylistId || !/^[A-Za-z0-9._:-]{2,255}$/.test(destinationPlaylistId)) fail("--playlist-id is invalid");

if (dryRun) {
  console.log(JSON.stringify({ ok: true, environment, endpointValidated: true, credentialsRead: false, mutationSent: false }));
  process.exit(0);
}

const serviceToken = process.env.UNIJAM_CONNECTOR_SERVICE_TOKEN;
const operatorToken = process.env.UNIJAM_CONNECTOR_OPERATOR_SECRET;
if (!serviceToken || !operatorToken) fail("Set UNIJAM_CONNECTOR_SERVICE_TOKEN and UNIJAM_CONNECTOR_OPERATOR_SECRET in the operator shell");

let response;
try {
  response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${serviceToken}`,
      "X-UniJam-Operator-Authorization": `Bearer ${operatorToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ operationId, expectedRecoveryMarker, destinationPlaylistId }),
    signal: AbortSignal.timeout(30_000),
  });
} catch {
  console.error("Operator recovery endpoint could not be reached; the mutation outcome is unchanged.");
  process.exit(1);
}
const body = await response.json().catch(() => null);
if (!response.ok || body?.error) {
  console.error(`Recovery rejected (${body?.error?.code ?? `HTTP_${response.status}`}): ${body?.error?.message ?? "Connector returned an invalid response"}`);
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, environment, status: body?.data?.status ?? "accepted", requestId: body?.requestId ?? null }));
