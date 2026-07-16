import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { verifyAccessJwt, type AccessJwk } from "../src/access";
import { handleOperatorRequest } from "../src/index";

const teamDomain = "https://unijam-test.cloudflareaccess.com";
const audience = "test-access-audience";
const clientId = "test-service-token.access";
const nowMs = Date.UTC(2026, 6, 16, 18);

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function jsonSegment(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

async function signedToken(overrides: Record<string, unknown> = {}) {
  const keys = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const exported = await crypto.subtle.exportKey("jwk", keys.publicKey);
  if (exported.kty !== "RSA" || typeof exported.n !== "string" || typeof exported.e !== "string") {
    throw new Error("Test RSA key export is malformed");
  }
  const publicJwk: AccessJwk = {
    ...exported,
    kty: "RSA",
    n: exported.n,
    e: exported.e,
    kid: "test-access-signing-key",
    alg: "RS256",
  };
  const nowSeconds = Math.floor(nowMs / 1_000);
  const encodedHeader = jsonSegment({ alg: "RS256", kid: publicJwk.kid, typ: "JWT" });
  const encodedClaims = jsonSegment({
    aud: [audience], common_name: clientId, exp: nowSeconds + 300, iat: nowSeconds - 10,
    iss: teamDomain, sub: "", type: "app", ...overrides,
  });
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keys.privateKey,
    new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`),
  );
  return { token: `${encodedHeader}.${encodedClaims}.${base64Url(new Uint8Array(signature))}`, publicJwk };
}

const configuration = { teamDomain, audience, serviceTokenClientId: clientId };

describe("Access JWT validation", () => {
  it("accepts only the configured service-token identity and audience", async () => {
    const { token, publicJwk } = await signedToken();
    const claims = await verifyAccessJwt(token, configuration, {
      now: () => nowMs,
      loadJwks: async () => [publicJwk],
    });
    expect(claims.common_name).toBe(clientId);

    const wrongAudience = await signedToken({ aud: ["other-audience"] });
    await expect(verifyAccessJwt(wrongAudience.token, configuration, {
      now: () => nowMs,
      loadJwks: async () => [wrongAudience.publicJwk],
    })).rejects.toThrow(/audience/);

    const humanIdentity = await signedToken({ common_name: "", sub: "human-subject" });
    await expect(verifyAccessJwt(humanIdentity.token, configuration, {
      now: () => nowMs,
      loadJwks: async () => [humanIdentity.publicJwk],
    })).rejects.toThrow(/service-token identity/);
  });

  it("rejects expired tokens and fails closed without Access configuration", async () => {
    const expired = await signedToken({ exp: Math.floor(nowMs / 1_000) - 120 });
    await expect(verifyAccessJwt(expired.token, configuration, {
      now: () => nowMs,
      loadJwks: async () => [expired.publicJwk],
    })).rejects.toThrow(/expired/);
    await expect(verifyAccessJwt(expired.token, { ...configuration, audience: "" }, {
      now: () => nowMs,
      loadJwks: async () => [expired.publicJwk],
    })).rejects.toThrow(/not configured/);
  });
});

describe("operator recovery ingress", () => {
  it("forwards only a normalized recovery request and adds private connector credentials", async () => {
    const { token, publicJwk } = await signedToken();
    const response = await handleOperatorRequest(new Request("https://operator-staging.unijam.ashlr.ai/v1/operator/publish/recover-playlist", {
      method: "POST",
      headers: {
        "Cf-Access-Jwt-Assertion": token,
        "Content-Type": "application/json",
        "X-UniJam-Operator-Authorization": "Bearer must-not-forward",
      },
      body: JSON.stringify({
        operationId: "publish:spotify:ROOM1234:r4:account",
        expectedRecoveryMarker: "unijam:v1:create_playlist:0123456789abcdef",
        destinationPlaylistId: "playlist-123",
      }),
    }), env, { now: () => nowMs, loadJwks: async () => [publicJwk] });
    expect(response.status).toBe(200);
    const body = await response.json<{
      authorization: string;
      operatorAuthorization: string;
      accessAssertion: string | null;
      body: Record<string, string>;
    }>();
    expect(body.authorization).toBe("Bearer test-connector-service-token");
    expect(body.operatorAuthorization).toBe("Bearer test-connector-operator-secret");
    expect(body.accessAssertion).toBeNull();
    expect(body.body).toEqual({
      operationId: "publish:spotify:ROOM1234:r4:account",
      expectedRecoveryMarker: "unijam:v1:create_playlist:0123456789abcdef",
      destinationPlaylistId: "playlist-123",
    });
  });

  it("rejects every other route, missing Access assertion, and extra body field", async () => {
    const missing = await handleOperatorRequest(new Request("https://operator-staging.unijam.ashlr.ai/v1/operator/publish/recover-playlist", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    }), env);
    expect(missing.status).toBe(401);

    const otherPath = await handleOperatorRequest(new Request("https://operator-staging.unijam.ashlr.ai/health"), env);
    expect(otherPath.status).toBe(404);

    const { token, publicJwk } = await signedToken();
    const extra = await handleOperatorRequest(new Request("https://operator-staging.unijam.ashlr.ai/v1/operator/publish/recover-playlist", {
      method: "POST",
      headers: { "Cf-Access-Jwt-Assertion": token, "Content-Type": "application/json" },
      body: JSON.stringify({
        operationId: "publish:spotify:ROOM1234:r4:account",
        expectedRecoveryMarker: "unijam:v1:create_playlist:0123456789abcdef",
        destinationPlaylistId: "playlist-123",
        unexpected: true,
      }),
    }), env, { now: () => nowMs, loadJwks: async () => [publicJwk] });
    expect(extra.status).toBe(400);
  });
});
