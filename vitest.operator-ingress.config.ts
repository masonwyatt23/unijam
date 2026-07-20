import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./operator-ingress/src/index.ts",
      wrangler: { configPath: "./operator-ingress/wrangler.jsonc" },
      miniflare: {
        bindings: {
          ACCESS_TEAM_DOMAIN: "https://unijam-test.cloudflareaccess.com",
          ACCESS_AUD: "test-access-audience",
          ACCESS_SERVICE_TOKEN_CLIENT_ID: "test-service-token.access",
          CONNECTOR_SERVICE_TOKEN: "test-connector-service-token",
          CONNECTOR_OPERATOR_SECRET: "test-connector-operator-secret",
        },
        serviceBindings: {
          async CONNECTORS(request: Request) {
            return Response.json({
              authorization: request.headers.get("Authorization"),
              operatorAuthorization: request.headers.get("X-UniJam-Operator-Authorization"),
              accessAssertion: request.headers.get("Cf-Access-Jwt-Assertion"),
              body: await request.json(),
            });
          },
        },
      },
    }),
  ],
  test: {
    include: ["operator-ingress/tests/**/*.test.ts"],
    testTimeout: 15_000,
  },
});
