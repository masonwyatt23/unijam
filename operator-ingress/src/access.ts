const MAX_JWKS_BYTES = 64 * 1024;
const MAX_TOKEN_BYTES = 16 * 1024;
const CLOCK_SKEW_SECONDS = 60;

type AccessHeader = { alg: string; kid: string; typ?: string };
export type AccessClaims = {
  aud: string | readonly string[];
  common_name: string;
  exp: number;
  iat: number;
  iss: string;
  nbf?: number;
  sub: string;
  type: string;
};

export type AccessJwk = JsonWebKey & {
  readonly kid: string;
  readonly kty: "RSA";
  readonly n: string;
  readonly e: string;
};

export type AccessConfiguration = {
  readonly teamDomain: string;
  readonly audience: string;
  readonly serviceTokenClientId: string;
};

export type AccessVerificationDependencies = {
  readonly now?: () => number;
  readonly loadJwks?: (teamOrigin: string, kid: string) => Promise<readonly AccessJwk[]>;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("JWT segment is malformed");
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  let decoded: string;
  try { decoded = atob(base64); }
  catch { throw new Error("JWT segment is malformed"); }
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function parseJsonSegment(value: string): unknown {
  try { return JSON.parse(new TextDecoder().decode(decodeBase64Url(value))); }
  catch { throw new Error("JWT segment is not valid JSON"); }
}

function parseHeader(value: unknown): AccessHeader {
  if (!isObject(value) || value.alg !== "RS256" || typeof value.kid !== "string" || value.kid.length < 8 || value.kid.length > 128) {
    throw new Error("JWT header is not an allowed Access RS256 header");
  }
  if (value.typ !== undefined && value.typ !== "JWT") throw new Error("JWT type is not allowed");
  return { alg: value.alg, kid: value.kid, ...(value.typ === "JWT" ? { typ: value.typ } : {}) };
}

function parseClaims(value: unknown): AccessClaims {
  if (!isObject(value)) throw new Error("JWT claims are malformed");
  const audience = value.aud;
  if (!(typeof audience === "string" || (Array.isArray(audience) && audience.every((item) => typeof item === "string")))) {
    throw new Error("JWT audience is malformed");
  }
  const { common_name: commonName, exp, iat, iss, nbf, sub, type } = value;
  if (typeof commonName !== "string") throw new Error("JWT common_name claim is malformed");
  if (typeof iss !== "string") throw new Error("JWT iss claim is malformed");
  if (typeof sub !== "string") throw new Error("JWT sub claim is malformed");
  if (typeof type !== "string") throw new Error("JWT type claim is malformed");
  if (typeof exp !== "number" || !Number.isSafeInteger(exp)) throw new Error("JWT exp claim is malformed");
  if (typeof iat !== "number" || !Number.isSafeInteger(iat)) throw new Error("JWT iat claim is malformed");
  if (nbf !== undefined && (typeof nbf !== "number" || !Number.isSafeInteger(nbf))) throw new Error("JWT nbf claim is malformed");
  return {
    aud: audience,
    common_name: commonName,
    exp,
    iat,
    iss,
    ...(nbf === undefined ? {} : { nbf }),
    sub,
    type,
  };
}

export function accessTeamOrigin(teamDomain: string): string {
  let url: URL;
  try { url = new URL(teamDomain); }
  catch { throw new Error("ACCESS_TEAM_DOMAIN is not configured as an HTTPS origin"); }
  if (
    url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash ||
    !url.hostname.endsWith(".cloudflareaccess.com") || url.hostname === "cloudflareaccess.com"
  ) throw new Error("ACCESS_TEAM_DOMAIN is not configured as an HTTPS cloudflareaccess.com origin");
  return url.origin;
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error("Access JWKS request failed");
  const length = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(length) && length > MAX_JWKS_BYTES) throw new Error("Access JWKS response is too large");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.byteLength;
    if (size > MAX_JWKS_BYTES) {
      await reader.cancel();
      throw new Error("Access JWKS response is too large");
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error("Access JWKS response is malformed"); }
}

function parseJwks(value: unknown): readonly AccessJwk[] {
  if (!isObject(value) || !Array.isArray(value.keys) || value.keys.length === 0 || value.keys.length > 20) {
    throw new Error("Access JWKS contains an invalid key set");
  }
  const keys: AccessJwk[] = [];
  for (const key of value.keys) {
    if (!isObject(key) || key.kty !== "RSA" || typeof key.kid !== "string" || typeof key.n !== "string" || typeof key.e !== "string") {
      throw new Error("Access JWKS contains an invalid RSA key");
    }
    keys.push({ kty: key.kty, kid: key.kid, n: key.n, e: key.e, alg: typeof key.alg === "string" ? key.alg : "RS256", use: "sig" });
  }
  return keys;
}

async function remoteJwks(teamOrigin: string, kid: string): Promise<readonly AccessJwk[]> {
  const url = `${teamOrigin}/cdn-cgi/access/certs`;
  const cacheKey = new Request(url, { method: "GET" });
  const cache = await caches.open("unijam-access-jwks");
  const cached = await cache.match(cacheKey);
  if (cached) {
    const keys = parseJwks(await boundedJson(cached));
    if (keys.some((key) => key.kid === kid)) return keys;
    await cache.delete(cacheKey);
  }
  const response = await fetch(url, { method: "GET", redirect: "error", headers: { Accept: "application/json" } });
  const keys = parseJwks(await boundedJson(response.clone()));
  const cacheable = new Response(response.body, response);
  cacheable.headers.set("Cache-Control", "public, max-age=300");
  await cache.put(cacheKey, cacheable);
  return keys;
}

export async function verifyAccessJwt(
  token: string,
  configuration: AccessConfiguration,
  dependencies: AccessVerificationDependencies = {},
): Promise<AccessClaims> {
  if (!token || token.length > MAX_TOKEN_BYTES) throw new Error("Access JWT is missing or too large");
  if (!configuration.audience || !configuration.serviceTokenClientId) throw new Error("Access audience or service identity is not configured");
  const teamOrigin = accessTeamOrigin(configuration.teamDomain);
  const segments = token.split(".");
  if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) throw new Error("Access JWT is malformed");
  const header = parseHeader(parseJsonSegment(segments[0]));
  const claims = parseClaims(parseJsonSegment(segments[1]));
  const keys = await (dependencies.loadJwks ?? remoteJwks)(teamOrigin, header.kid);
  const jwk = keys.find((candidate) => candidate.kid === header.kid && candidate.kty === "RSA");
  if (!jwk) throw new Error("Access signing key is unavailable");
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const verified = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    Uint8Array.from(decodeBase64Url(segments[2])).buffer,
    new TextEncoder().encode(`${segments[0]}.${segments[1]}`),
  );
  if (!verified) throw new Error("Access JWT signature is invalid");
  const nowSeconds = Math.floor((dependencies.now?.() ?? Date.now()) / 1_000);
  const audience = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
  if (!audience.includes(configuration.audience)) throw new Error("Access JWT audience is invalid");
  if (claims.iss !== teamOrigin || claims.type !== "app") throw new Error("Access JWT issuer or type is invalid");
  if (claims.exp <= nowSeconds - CLOCK_SKEW_SECONDS || claims.iat > nowSeconds + CLOCK_SKEW_SECONDS) throw new Error("Access JWT is expired or issued in the future");
  if (claims.nbf !== undefined && claims.nbf > nowSeconds + CLOCK_SKEW_SECONDS) throw new Error("Access JWT is not active yet");
  if (claims.common_name !== configuration.serviceTokenClientId || claims.sub !== "") {
    throw new Error("Access JWT is not the configured service-token identity");
  }
  return claims;
}
